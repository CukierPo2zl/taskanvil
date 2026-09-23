import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DirectiveSpec } from "./config.js";
import { loadProjectConfig, mergeDirectives } from "./projectConfig.js";
import type { IssueInfo } from "./types.js";

const issue: IssueInfo = {
	id: "i1",
	identifier: "LIN-73",
	title: "Fix login",
	description: "",
	url: "https://linear.app/x/LIN-73",
	labels: [],
};

describe("loadProjectConfig", () => {
	let repoPath: string;

	beforeEach(() => {
		repoPath = mkdtempSync(join(tmpdir(), "agent-contract-"));
	});
	afterEach(() => {
		rmSync(repoPath, { recursive: true, force: true });
	});

	const write = (content: string) => {
		mkdirSync(join(repoPath, ".claude"), { recursive: true });
		writeFileSync(join(repoPath, ".claude", "agent.json"), content);
	};

	it("returns undefined when the repo has no contract file", () => {
		expect(loadProjectConfig(repoPath)).toBeUndefined();
	});

	it("compiles validate regexes and parses the commit convention", () => {
		write(
			JSON.stringify({
				directives: {
					ticket: { description: "External ticket", validate: "^[A-Z]+-\\d+$", required: "ask", ask: "Which ticket?" },
				},
				commit: { format: "{ticket}: {summary}", summaryPattern: "^.{5,72}(?<!\\.)$", rules: "imperative" },
			}),
		);
		const config = loadProjectConfig(repoPath);
		expect(config?.directives.ticket?.validate?.test("EXT-4711")).toBe(true);
		expect(config?.directives.ticket?.validate?.test("LIN-73x")).toBe(false);
		expect(config?.directives.ticket?.required).toBe("ask");
		expect(config?.commit?.format).toBe("{ticket}: {summary}");
		expect(config?.commit?.summaryPattern?.test("add feature-flag client")).toBe(true);
		expect(config?.commit?.summaryPattern?.test("ends with period.")).toBe(false);
	});

	it("turns string defaults into templates over issue fields with |lower", () => {
		write(
			JSON.stringify({
				directives: { branch: { description: "Branch", default: "agent/{identifier|lower}" } },
			}),
		);
		const spec = loadProjectConfig(repoPath)?.directives.branch;
		const dflt = typeof spec?.default === "function" ? spec.default(issue) : spec?.default;
		expect(dflt).toBe("agent/lin-73");
	});

	it("passes boolean defaults through unchanged", () => {
		write(JSON.stringify({ directives: { push: { description: "Push?", type: "boolean", default: false } } }));
		expect(loadProjectConfig(repoPath)?.directives.push?.default).toBe(false);
	});

	it("throws with the file path on invalid JSON", () => {
		write("{ not json");
		expect(() => loadProjectConfig(repoPath)).toThrow(join(repoPath, ".claude", "agent.json"));
	});

	it("throws on schema violations, naming the bad field", () => {
		write(JSON.stringify({ directives: { ticket: { validate: "^x$" } } }));
		expect(() => loadProjectConfig(repoPath)).toThrow(/directives\.ticket/);
	});

	it("throws on an uncompilable regex, naming the directive", () => {
		write(JSON.stringify({ directives: { ticket: { description: "x", validate: "[unclosed" } } }));
		expect(() => loadProjectConfig(repoPath)).toThrow(/directives\.ticket\.validate/);
	});
});

describe("mergeDirectives", () => {
	const global: Record<string, DirectiveSpec> = {
		branch: { description: "global branch" },
		push: { description: "global push", type: "boolean", default: false },
	};

	it("returns global specs when there is no project config", () => {
		expect(mergeDirectives(global, undefined)).toEqual(global);
	});

	it("adds project directives and lets them override global ones per key", () => {
		const merged = mergeDirectives(global, {
			source: "x",
			directives: {
				ticket: { description: "project ticket" },
				push: { description: "project push wins", type: "boolean", default: true },
			},
		});
		expect(Object.keys(merged).sort()).toEqual(["branch", "push", "ticket"]);
		expect(merged.push?.default).toBe(true);
		expect(merged.branch?.description).toBe("global branch");
	});
});
