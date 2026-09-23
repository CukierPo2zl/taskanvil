import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeRunOptions, HandlerCtx } from "./config.js";
import {
	evaluateCondition,
	type FlowDefinition,
	listFlows,
	matchLabel,
	resolveFlow,
	runFlow,
	validateFlow,
} from "./flow.js";
import type { SkillInfo } from "./skills.js";

function mockCtx() {
	const calls: string[] = [];
	const claudeCalls: ClaudeRunOptions[] = [];
	const ctx = {
		issue: {
			id: "i1",
			identifier: "LIN-42",
			title: "Add feature-flag client",
			description: "",
			url: "https://linear.app/x/LIN-42",
			labels: ["feature"],
		},
		directives: { ticket: "EXT-7", push: true },
		repo: { name: "web", path: "/repo", baseBranch: "develop" },
		post: {
			thought: vi.fn(),
			action: vi.fn(),
			response: vi.fn(async (body: string) => void calls.push(`respond:${body}`)),
			elicitation: vi.fn(),
			error: vi.fn(),
		},
		worktree: vi.fn(async (opts?: { branch?: string; dir?: string }) => {
			calls.push(`worktree:${opts?.branch ?? ""}`);
			return { path: "/wt", branch: opts?.branch ?? "b", baseBranch: "develop", repoPath: "/repo" };
		}),
		claude: vi.fn(async (opts: ClaudeRunOptions) => {
			calls.push(`claude:${opts.skill}`);
			claudeCalls.push(opts);
			return { finalText: `done ${opts.skill}`, claudeSessionId: "s1", turns: 1 };
		}),
		commit: vi.fn(async (message: string) => void calls.push(`commit:${message}`)),
		push: vi.fn(async () => void calls.push("push")),
		openPR: vi.fn(async () => {
			calls.push("openPR");
			return "https://github.com/x/pull/1";
		}),
	} as unknown as HandlerCtx;
	return { ctx, calls, claudeCalls };
}

const skillFixtures: Record<string, SkillInfo> = {
	implement: { name: "implement", description: "", source: "global", path: "/home/.claude/skills/implement/SKILL.md" },
	simplify: { name: "simplify", description: "", source: "project", path: "/repo/.claude/skills/simplify/SKILL.md" },
};

const deps = {
	resolveSkill: (name: string) => {
		const skill = skillFixtures[name];
		if (!skill) throw new Error(`unknown skill "${name}"`);
		return skill;
	},
};

describe("validateFlow", () => {
	it("accepts a well-formed linear flow", () => {
		const flow: FlowDefinition = {
			name: "ok",
			nodes: [
				{ id: "w", type: "worktree" },
				{ id: "a", type: "agent", skill: "implement" },
			],
			edges: [{ from: "w", to: "a" }],
		};
		expect(validateFlow(flow)).toEqual([]);
	});

	it("rejects duplicate ids, dangling edges, agent nodes without skill", () => {
		const flow = {
			name: "bad",
			nodes: [
				{ id: "a", type: "agent", skill: "" },
				{ id: "a", type: "push" },
			],
			edges: [{ from: "a", to: "ghost" }],
		} as FlowDefinition;
		const errors = validateFlow(flow);
		expect(errors.join("\n")).toContain('duplicate node id "a"');
		expect(errors.join("\n")).toContain('unknown node "ghost"');
		expect(errors.join("\n")).toContain('agent node "a" has no skill');
	});

	it("requires exactly one start node", () => {
		const flow: FlowDefinition = {
			name: "two-starts",
			nodes: [
				{ id: "a", type: "push" },
				{ id: "b", type: "push" },
			],
			edges: [],
		};
		expect(validateFlow(flow).join("\n")).toContain("exactly one start node");
	});
});

describe("runFlow", () => {
	const featureFlow: FlowDefinition = {
		name: "feature",
		nodes: [
			{ id: "wt", type: "worktree" },
			{ id: "impl", type: "agent", skill: "implement", git: { commit: true, push: false } },
			{ id: "simp", type: "agent", skill: "simplify", session: "continue" },
			{ id: "ship", type: "push" },
			{ id: "pr", type: "openPR", draft: true },
		],
		edges: [
			{ from: "wt", to: "impl" },
			{ from: "impl", to: "simp" },
			{ from: "simp", to: "ship" },
			{ from: "ship", to: "pr" },
		],
	};

	it("walks a linear chain in order, passing resolved skill names to ctx.claude", async () => {
		const { ctx, calls, claudeCalls } = mockCtx();
		await runFlow(featureFlow, ctx, deps);
		expect(calls).toEqual(["worktree:", "claude:implement", "claude:simplify", "push", "openPR"]);
		expect(claudeCalls[0]?.session).toBeUndefined();
		expect(claudeCalls[1]?.session).toBe("continue");
	});

	it("interpolates issue fields and directives into commit messages and responses", async () => {
		const flow: FlowDefinition = {
			name: "c",
			nodes: [
				{ id: "impl", type: "agent", skill: "implement" },
				{ id: "c", type: "commit", message: "{ticket}: {title}" },
				{ id: "r", type: "respond", template: "Result: {lastText}" },
			],
			edges: [
				{ from: "impl", to: "c" },
				{ from: "c", to: "r" },
			],
		};
		const { ctx, calls } = mockCtx();
		await runFlow(flow, ctx, deps);
		expect(calls).toContain("commit:EXT-7: Add feature-flag client");
		expect(calls).toContain("respond:Result: done implement");
	});

	it("leaves unknown placeholders untouched", async () => {
		const flow: FlowDefinition = {
			name: "u",
			nodes: [{ id: "c", type: "commit", message: "{nope}: {identifier}" }],
			edges: [],
		};
		const { ctx, calls } = mockCtx();
		await runFlow(flow, ctx, deps);
		expect(calls).toEqual(["commit:{nope}: LIN-42"]);
	});

	it("throws a helpful error for unknown skills", async () => {
		const flow: FlowDefinition = {
			name: "bad-skill",
			nodes: [{ id: "a", type: "agent", skill: "does-not-exist" }],
			edges: [],
		};
		const { ctx } = mockCtx();
		await expect(runFlow(flow, ctx, deps)).rejects.toThrow('unknown skill "does-not-exist"');
	});

	it("refuses to run an invalid flow", async () => {
		const { ctx } = mockCtx();
		await expect(runFlow({ name: "", nodes: [], edges: [] }, ctx, deps)).rejects.toThrow("invalid");
	});

	it("aborts unbounded cycles via the step limit", async () => {
		const flow: FlowDefinition = {
			name: "loop",
			nodes: [
				{ id: "start", type: "worktree" },
				{ id: "a", type: "push" },
				{ id: "b", type: "push" },
			],
			edges: [
				{ from: "start", to: "a" },
				{ from: "a", to: "b" },
				{ from: "b", to: "a" },
			],
		};
		const { ctx } = mockCtx();
		await expect(runFlow(flow, ctx, deps)).rejects.toThrow("exceeded");
	});

	it("takes the first edge whose condition passes: push == true routes to the push node", async () => {
		const flow: FlowDefinition = {
			name: "gated",
			nodes: [
				{ id: "impl", type: "agent", skill: "implement" },
				{ id: "ship", type: "push" },
				{ id: "r", type: "respond", template: "not shipped" },
			],
			edges: [
				{ from: "impl", to: "ship", condition: "push == true" },
				{ from: "impl", to: "r" },
			],
		};
		const { ctx, calls } = mockCtx();
		await runFlow(flow, ctx, deps);
		expect(calls).toContain("push");
		expect(calls).not.toContain("respond:not shipped");
	});

	it("falls through failing conditional edges to the unconditional default edge", async () => {
		const flow: FlowDefinition = {
			name: "fallthrough",
			nodes: [
				{ id: "impl", type: "agent", skill: "implement" },
				{ id: "ship", type: "push" },
				{ id: "r", type: "respond", template: "not shipped" },
			],
			edges: [
				{ from: "impl", to: "ship", condition: "push == false" },
				{ from: "impl", to: "r" },
			],
		};
		const { ctx, calls } = mockCtx();
		await runFlow(flow, ctx, deps);
		expect(calls).not.toContain("push");
		expect(calls).toContain("respond:not shipped");
	});

	it("a condition referencing an unknown directive evaluates to false, never throws", async () => {
		const flow: FlowDefinition = {
			name: "typo",
			nodes: [
				{ id: "impl", type: "agent", skill: "implement" },
				{ id: "ship", type: "push" },
			],
			edges: [{ from: "impl", to: "ship", condition: "pusj == true" }],
		};
		const { ctx, calls } = mockCtx();
		await runFlow(flow, ctx, deps);
		expect(calls).toEqual(["claude:implement"]);
	});
});

describe("evaluateCondition", () => {
	const scope = {
		directives: { push: true, ticket: "EXT-7", empty: "" },
		lastText: "All checks passed. APPROVED.",
		results: { review: "LGTM with nits" },
	};

	it("bare directive name is a truthiness check", () => {
		expect(evaluateCondition("push", scope)).toBe(true);
		expect(evaluateCondition("empty", scope)).toBe(false);
		expect(evaluateCondition("missing", scope)).toBe(false);
	});

	it("compares directives as strings with == and !=", () => {
		expect(evaluateCondition("push == true", scope)).toBe(true);
		expect(evaluateCondition("ticket == EXT-7", scope)).toBe(true);
		expect(evaluateCondition("ticket != EXT-7", scope)).toBe(false);
		expect(evaluateCondition("ticket == EXT-8", scope)).toBe(false);
	});

	it("supports quoted right-hand values", () => {
		expect(evaluateCondition('ticket == "EXT-7"', scope)).toBe(true);
		expect(evaluateCondition("ticket == 'EXT-7'", scope)).toBe(true);
	});

	it("contains matches substrings of node results and lastText", () => {
		expect(evaluateCondition("results.review contains LGTM", scope)).toBe(true);
		expect(evaluateCondition("results.review contains BLOCKED", scope)).toBe(false);
		expect(evaluateCondition("lastText contains APPROVED", scope)).toBe(true);
	});

	it("fails closed on unknown keys, even with !=", () => {
		expect(evaluateCondition("nope == true", scope)).toBe(false);
		expect(evaluateCondition("nope != true", scope)).toBe(false);
		expect(evaluateCondition("results.ghost contains x", scope)).toBe(false);
	});

	it("throws on malformed syntax", () => {
		expect(() => evaluateCondition("push ==", scope)).toThrow("Malformed");
		expect(() => evaluateCondition("== true", scope)).toThrow("Malformed");
	});
});

describe("resolveFlow", () => {
	let repoPath: string;
	let otherRepoPath: string;

	const minimalFlow = (name: string) => JSON.stringify({ name, nodes: [{ id: "r", type: "respond" }], edges: [] });

	beforeEach(() => {
		repoPath = mkdtempSync(join(tmpdir(), "agent-repo-"));
		otherRepoPath = mkdtempSync(join(tmpdir(), "agent-repo2-"));
	});
	afterEach(() => {
		rmSync(repoPath, { recursive: true, force: true });
		rmSync(otherRepoPath, { recursive: true, force: true });
	});

	const repo = (path = repoPath) => ({ path, baseBranch: "main" });

	it("returns undefined when the repo has no flow for the label", () => {
		expect(resolveFlow(repo(), "bug")).toBeUndefined();
	});

	it("finds the repo's own flow", () => {
		mkdirSync(join(repoPath, ".claude", "flows"), { recursive: true });
		writeFileSync(join(repoPath, ".claude", "flows", "bug.json"), minimalFlow("bug-fix"));
		const resolved = resolveFlow(repo(), "bug");
		expect(resolved?.definition.name).toBe("bug-fix");
		expect(resolved?.source).toContain(repoPath);
	});

	it("flows are exclusive — one repo's flow is invisible to another", () => {
		mkdirSync(join(repoPath, ".claude", "flows"), { recursive: true });
		writeFileSync(join(repoPath, ".claude", "flows", "bug.json"), minimalFlow("bug-fix"));
		expect(resolveFlow(repo(otherRepoPath), "bug")).toBeUndefined();
		expect(listFlows(repo(otherRepoPath))).toEqual([]);
		expect(listFlows(repo()).map((f) => f.label)).toEqual(["bug"]);
	});

	it("rejects invalid flow files with the file path in the error", () => {
		mkdirSync(join(repoPath, ".claude", "flows"), { recursive: true });
		const file = join(repoPath, ".claude", "flows", "bug.json");
		writeFileSync(file, JSON.stringify({ name: "broken", nodes: [], edges: [] }));
		expect(() => resolveFlow(repo(), "bug")).toThrow(file);
	});
});

describe("matchLabel", () => {
	it("matches case-insensitively and returns the known label's own casing", () => {
		expect(matchLabel(["Feature"], ["feature", "bug"])).toBe("feature");
		expect(matchLabel(["BUG"], ["feature", "bug"])).toBe("bug");
	});

	it("respects issue label order, not candidate order", () => {
		expect(matchLabel(["bug", "feature"], ["feature", "bug"])).toBe("bug");
	});

	it("ignores labels the agent doesn't know", () => {
		expect(matchLabel(["urgent", "refactor"], ["refactor"])).toBe("refactor");
		expect(matchLabel(["urgent"], ["feature", "bug"])).toBeUndefined();
		expect(matchLabel([], ["feature"])).toBeUndefined();
	});

	it("first casing wins when candidates collide case-insensitively", () => {
		expect(matchLabel(["feature"], ["Feature", "feature"])).toBe("Feature");
	});
});
