import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CommitConvention, DirectiveSpec } from "./config.js";
import type { IssueInfo } from "./types.js";

const directiveJson = z.object({
	description: z.string(),
	type: z.enum(["string", "boolean"]).optional(),
	validate: z.string().optional(),
	required: z.union([z.literal("ask"), z.literal(false)]).optional(),
	ask: z.string().optional(),
	/** Booleans pass through; strings may use {identifier}, {title}, {url}, with |lower / |upper. */
	default: z.union([z.string(), z.boolean()]).optional(),
});

const projectConfigJson = z.object({
	directives: z.record(z.string(), directiveJson).optional(),
	commit: z
		.object({
			format: z.string(),
			summaryPattern: z.string().optional(),
			rules: z.string().optional(),
		})
		.optional(),
});

export type ProjectConfigJson = z.infer<typeof projectConfigJson>;

export interface ProjectConfig {
	directives: Record<string, DirectiveSpec>;
	commit?: CommitConvention;
	source: string;
}

export function projectConfigPath(repoPath: string): string {
	return join(repoPath, ".claude", "agent.json");
}

export function loadProjectConfig(repoPath: string): ProjectConfig | undefined {
	const file = projectConfigPath(repoPath);
	if (!existsSync(file)) return undefined;

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	const parsed = projectConfigJson.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
		throw new Error(`${file} is invalid: ${issues}`);
	}

	const directives: Record<string, DirectiveSpec> = {};
	for (const [name, spec] of Object.entries(parsed.data.directives ?? {})) {
		directives[name] = {
			description: spec.description,
			type: spec.type,
			validate: spec.validate ? compileRegex(spec.validate, `${file} → directives.${name}.validate`) : undefined,
			required: spec.required,
			ask: spec.ask,
			default:
				typeof spec.default === "string"
					? (issue: IssueInfo) => renderTemplate(spec.default as string, issue)
					: spec.default,
		};
	}

	const commit: CommitConvention | undefined = parsed.data.commit
		? {
				format: parsed.data.commit.format,
				summaryPattern: parsed.data.commit.summaryPattern
					? compileRegex(parsed.data.commit.summaryPattern, `${file} → commit.summaryPattern`)
					: undefined,
				rules: parsed.data.commit.rules,
			}
		: undefined;

	return { directives, commit, source: file };
}

export function mergeDirectives(
	global: Record<string, DirectiveSpec>,
	project?: ProjectConfig,
): Record<string, DirectiveSpec> {
	return { ...global, ...(project?.directives ?? {}) };
}

function compileRegex(source: string, where: string): RegExp {
	try {
		return new RegExp(source);
	} catch (err) {
		throw new Error(`${where}: invalid regex ${JSON.stringify(source)} — ${err instanceof Error ? err.message : err}`);
	}
}

function renderTemplate(template: string, issue: IssueInfo): string {
	const fields: Record<string, string> = { identifier: issue.identifier, title: issue.title, url: issue.url };
	return template.replace(/\{(\w+)(?:\|(lower|upper))?\}/g, (whole, key: string, mod?: string) => {
		const value = fields[key];
		if (value === undefined) return whole;
		return mod === "lower" ? value.toLowerCase() : mod === "upper" ? value.toUpperCase() : value;
	});
}
