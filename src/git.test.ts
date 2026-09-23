import { describe, expect, it } from "vitest";
import { inspectGitCommand } from "./git.js";
import { resolveConvention } from "./runner.js";

describe("inspectGitCommand", () => {
	it("ignores non-git commands", () => {
		expect(inspectGitCommand("pnpm test").isGit).toBe(false);
		expect(inspectGitCommand("echo git commit").isGit).toBe(false);
	});

	it("parses a plain commit with message", () => {
		const info = inspectGitCommand('git commit -m "EXT-4711: add feature-flag client"');
		expect(info.isGit).toBe(true);
		expect(info.subcommand).toBe("commit");
		expect(info.commitMessage).toBe("EXT-4711: add feature-flag client");
	});

	it("parses single-quoted messages", () => {
		expect(inspectGitCommand("git commit -m 'EXT-0: fix thing'").commitMessage).toBe("EXT-0: fix thing");
	});

	it("handles git -C <path>", () => {
		const info = inspectGitCommand('git -C /tmp/x commit -m "EXT-1: y stuff"');
		expect(info.subcommand).toBe("commit");
		expect(info.commitMessage).toBe("EXT-1: y stuff");
	});

	it("detects git after && chains", () => {
		const info = inspectGitCommand('pnpm test && git commit -m "EXT-2: z"');
		expect(info.isGit).toBe(true);
		expect(info.subcommand).toBe("commit");
	});

	it("flags --amend, --no-verify and force pushes", () => {
		expect(inspectGitCommand('git commit --amend -m "x"').hasAmend).toBe(true);
		expect(inspectGitCommand('git commit --no-verify -m "x"').hasNoVerify).toBe(true);
		expect(inspectGitCommand("git push --force origin main").hasForce).toBe(true);
		expect(inspectGitCommand("git push -f origin main").hasForce).toBe(true);
		expect(inspectGitCommand("git push origin main").hasForce).toBe(false);
	});

	it("detects push subcommand", () => {
		expect(inspectGitCommand("git push -u origin feature/x").subcommand).toBe("push");
	});
});

describe("resolveConvention", () => {
	const convention = {
		format: "{ticket}: {summary}",
		summaryPattern: /^.{5,72}(?<!\.)$/,
		rules: "imperative mood",
	};

	it("resolves the prefix from directives", () => {
		const r = resolveConvention(convention, { ticket: "EXT-4711" });
		expect(r.prefix).toBe("EXT-4711: ");
	});

	it("validates summaries against the pattern", () => {
		const r = resolveConvention(convention, { ticket: "EXT-0" });
		expect(r.summaryPattern.test("add feature-flag client")).toBe(true);
		expect(r.summaryPattern.test("tiny")).toBe(false);
		expect(r.summaryPattern.test("ends with a period.")).toBe(false);
		expect(r.summaryPattern.test("x".repeat(73))).toBe(false);
	});
});
