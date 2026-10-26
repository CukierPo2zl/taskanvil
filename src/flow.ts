import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitPolicy, HandlerCtx, RepoConfig } from "./config.js";
import type { SkillInfo } from "./skills.js";
import type { Directives } from "./types.js";

export type FlowNode = (
	| { id: string; type: "worktree"; branch?: string; dir?: string }
	| {
			id: string;
			type: "agent";
			skill: string;
			model?: string;
			tools?: string[];
			session?: "fresh" | "continue";
			git?: GitPolicy;
			maxTurns?: number;
			extraPrompt?: string;
			interactive?: boolean;
	  }
	| { id: string; type: "commit"; message?: string }
	| { id: string; type: "push" }
	| { id: string; type: "openPR"; title?: string; body?: string; draft?: boolean }
	/** Post a status note (thought) to the Linear timeline — does NOT end the session. */
	| { id: string; type: "say"; message?: string }
	/** Post the final response — Linear marks the session complete. */
	| { id: string; type: "respond"; template?: string }
) & {
	position?: { x: number; y: number };
};

export interface FlowEdge {
	from: string;
	to: string;
	condition?: string;
}

export interface FlowDefinition {
	name: string;
	description?: string;
	nodes: FlowNode[];
	edges: FlowEdge[];
}

export interface FlowScope {
	directives: Directives;
	lastText: string;
	results: Record<string, string>;
}

/**
 * Edge condition mini-language — deliberately small:
 *
 *   "push"                          truthy directive (not "", not "false")
 *   "push == true"                  string equality against a directive
 *   "ticket != EXT-1"                inequality
 *   "results.review contains LGTM"  substring match on a node's output
 *   "lastText contains APPROVED"    substring match on the last agent output
 *
 * Left side is a directive name, `lastText`, or `results.<nodeId>`. An unknown
 * key makes the whole condition false — a typo must never route a flow — while
 * malformed *syntax* throws, since that's an authoring error the editor should
 * surface. Values compare as strings ("true", not true).
 */
export function evaluateCondition(condition: string, scope: FlowScope): boolean {
	const match = condition.trim().match(/^([\w.]+)(?:\s*(==|!=)\s*(.+)|\s+(contains)\s+(.+))?$/);
	if (!match) throw new Error(`Malformed edge condition: "${condition}"`);
	const [, path, eqOp, eqRight, containsOp, containsRight] = match;

	const left = lookupScope(path ?? "", scope);
	if (left === undefined) return false;

	const op = eqOp ?? containsOp;
	if (!op) return left !== "" && left !== "false";

	const right = stripQuotes((eqRight ?? containsRight ?? "").trim());
	if (op === "==") return left === right;
	if (op === "!=") return left !== right;
	return left.includes(right);
}

function lookupScope(path: string, scope: FlowScope): string | undefined {
	if (path === "lastText") return scope.lastText;
	if (path.startsWith("results.")) return scope.results[path.slice("results.".length)];
	const value = scope.directives[path];
	return value === undefined ? undefined : String(value);
}

function stripQuotes(value: string): string {
	const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
	return quoted && value.length >= 2 ? value.slice(1, -1) : value;
}

export interface ResolvedFlow {
	definition: FlowDefinition;
	source: string;
}

export function flowPath(repo: RepoConfig, label: string): string {
	return join(repo.path, ".claude", "flows", `${label}.json`);
}

export function resolveFlow(repo: RepoConfig, label: string): ResolvedFlow | undefined {
	const file = flowPath(repo, label);
	if (!existsSync(file)) return undefined;
	return { definition: loadFlow(file), source: file };
}

export interface FlowListing {
	label: string;
	name: string;
	description?: string;
	error?: string;
}

export function listFlows(repo: RepoConfig): FlowListing[] {
	const dir = join(repo.path, ".claude", "flows");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => {
			const label = f.slice(0, -".json".length);
			try {
				const def = loadFlow(join(dir, f));
				return { label, name: def.name, description: def.description };
			} catch (err) {
				return { label, name: label, error: err instanceof Error ? err.message : String(err) };
			}
		})
		.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Pick the session's label: the first of the issue's labels (in issue order)
 * that matches a known label, case-insensitively. Returns the known label's
 * own casing, since flow filenames are case-sensitive on disk.
 */
export function matchLabel(issueLabels: string[], knownLabels: Iterable<string>): string | undefined {
	const known = new Map<string, string>();
	for (const label of knownLabels) {
		if (!known.has(label.toLowerCase())) known.set(label.toLowerCase(), label);
	}
	for (const label of issueLabels) {
		const hit = known.get(label.toLowerCase());
		if (hit) return hit;
	}
	return undefined;
}

export function loadFlow(file: string): FlowDefinition {
	let parsed: FlowDefinition;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		throw new Error(`Flow file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	const errors = validateFlow(parsed);
	if (errors.length > 0) {
		throw new Error(`Flow file ${file} is invalid:\n- ${errors.join("\n- ")}`);
	}
	return parsed;
}

export function validateFlow(flow: FlowDefinition): string[] {
	const errors: string[] = [];
	if (!flow.name) errors.push(`flow has no "name"`);
	if (!Array.isArray(flow.nodes) || flow.nodes.length === 0) {
		errors.push("flow has no nodes");
		return errors;
	}
	const edges = Array.isArray(flow.edges) ? flow.edges : [];

	const ids = new Set<string>();
	for (const node of flow.nodes) {
		if (!node.id) errors.push(`a node of type "${node.type}" has no id`);
		else if (ids.has(node.id)) errors.push(`duplicate node id "${node.id}"`);
		ids.add(node.id);
		if (node.type === "agent" && !node.skill) errors.push(`agent node "${node.id}" has no skill`);
	}
	for (const edge of edges) {
		if (!ids.has(edge.from)) errors.push(`edge references unknown node "${edge.from}"`);
		if (!ids.has(edge.to)) errors.push(`edge references unknown node "${edge.to}"`);
	}

	const hasIncoming = new Set(edges.map((e) => e.to));
	const starts = flow.nodes.filter((n) => !hasIncoming.has(n.id));
	if (starts.length !== 1) {
		errors.push(
			`flow must have exactly one start node (a node with no incoming edges); found ${starts.length}${
				starts.length ? `: ${starts.map((n) => n.id).join(", ")}` : ""
			}`,
		);
	}
	return errors;
}

export interface FlowRunDeps {
	resolveSkill(name: string): SkillInfo;
}

const MAX_VISITS_PER_NODE = 4;

export async function runFlow(flow: FlowDefinition, ctx: HandlerCtx, deps: FlowRunDeps): Promise<void> {
	const errors = validateFlow(flow);
	if (errors.length > 0) throw new Error(`Flow "${flow.name}" is invalid:\n- ${errors.join("\n- ")}`);

	const byId = new Map(flow.nodes.map((n) => [n.id, n]));
	const hasIncoming = new Set(flow.edges.map((e) => e.to));
	const scope: FlowScope = { directives: ctx.directives, lastText: "", results: {} };

	let node: FlowNode | undefined = flow.nodes.find((n) => !hasIncoming.has(n.id));
	let steps = 0;
	const maxSteps = flow.nodes.length * MAX_VISITS_PER_NODE;

	while (node) {
		if (++steps > maxSteps) {
			throw new Error(`Flow "${flow.name}" exceeded ${maxSteps} steps — likely an unbounded cycle.`);
		}
		await executeNode(node, ctx, deps, scope);

		const outgoing = flow.edges.filter((e) => e.from === node?.id);
		const taken = outgoing.find((e) => !e.condition || evaluateCondition(e.condition, scope));
		node = taken ? byId.get(taken.to) : undefined;
	}
}

async function executeNode(node: FlowNode, ctx: HandlerCtx, deps: FlowRunDeps, scope: FlowScope): Promise<void> {
	const vars = interpolationVars(ctx, scope);

	switch (node.type) {
		case "worktree": {
			await ctx.worktree({
				branch: node.branch ? interpolate(node.branch, vars) : undefined,
				dir: node.dir ? interpolate(node.dir, vars) : undefined,
			});
			return;
		}
		case "agent": {
			const skill = deps.resolveSkill(node.skill);
			const result = await ctx.claude({
				skill: skill.name,
				model: node.model,
				tools: node.tools,
				session: node.session,
				git: node.git,
				maxTurns: node.maxTurns,
				interactive: node.interactive,
				extraPrompt: node.extraPrompt ? interpolate(node.extraPrompt, vars) : undefined,
			});
			scope.lastText = result.finalText;
			scope.results[node.id] = result.finalText;
			return;
		}
		case "commit": {
			await ctx.commit(interpolate(node.message ?? "{identifier}: {title}", vars));
			return;
		}
		case "push": {
			await ctx.push();
			return;
		}
		case "openPR": {
			const url = await ctx.openPR({
				title: node.title ? interpolate(node.title, vars) : undefined,
				body: node.body ? interpolate(node.body, vars) : undefined,
				draft: node.draft,
			});
			scope.results[node.id] = url;
			return;
		}
		case "say": {
			await ctx.post.thought(interpolate(node.message ?? "", vars));
			return;
		}
		case "respond": {
			await ctx.post.response(interpolate(node.template ?? "{lastText}", vars));
			return;
		}
	}
}

function interpolationVars(ctx: HandlerCtx, scope: FlowScope): Record<string, string> {
	const vars: Record<string, string> = {
		identifier: ctx.issue.identifier,
		title: ctx.issue.title,
		url: ctx.issue.url,
		lastText: scope.lastText,
	};
	for (const [key, value] of Object.entries(ctx.directives)) {
		if (value !== undefined) vars[key] = String(value);
	}
	return vars;
}

function interpolate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}
