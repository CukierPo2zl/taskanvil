import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectGitCommand, syncAgentConfig } from "./git.js";
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

describe("syncAgentConfig", () => {
	let root: string;
	let repo: string;
	let worktree: string;
	const sh = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } })
			.toString()
			.trim();

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "sync-"));
		repo = join(root, "repo");
		worktree = join(root, "wt");
		mkdirSync(repo);
		sh(repo, "init", "-q", "-b", "main");
		sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
		sh(repo, "worktree", "add", "-q", "-b", "agent/x", worktree);

		// The main checkout holds flows and skills the base branch doesn't have.
		mkdirSync(join(repo, ".claude", "flows"), { recursive: true });
		writeFileSync(join(repo, ".claude", "flows", "bug.json"), '{"name":"bug"}');
		mkdirSync(join(root, "shared", "neon"), { recursive: true });
		writeFileSync(join(root, "shared", "neon", "SKILL.md"), "# neon");
		mkdirSync(join(repo, ".claude", "skills"));
		symlinkSync(join(root, "shared", "neon"), join(repo, ".claude", "skills", "neon"));
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("copies flows and dereferenced skills into the worktree", async () => {
		const synced = await syncAgentConfig(repo, worktree);
		expect(synced.sort()).toEqual(["flows/bug.json", "skills/neon"]);
		expect(readFileSync(join(worktree, ".claude", "flows", "bug.json"), "utf8")).toBe('{"name":"bug"}');
		expect(lstatSync(join(worktree, ".claude", "skills", "neon")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(worktree, ".claude", "skills", "neon", "SKILL.md"), "utf8")).toBe("# neon");
	});

	it("keeps the copies out of `git add -A`", async () => {
		await syncAgentConfig(repo, worktree);
		sh(worktree, "add", "-A");
		expect(sh(worktree, "status", "--porcelain")).toBe("");
	});

	it("leaves entries the branch already has untouched", async () => {
		mkdirSync(join(worktree, ".claude", "flows"), { recursive: true });
		writeFileSync(join(worktree, ".claude", "flows", "bug.json"), "branch version");
		const synced = await syncAgentConfig(repo, worktree);
		expect(synced).toEqual(["skills/neon"]);
		expect(readFileSync(join(worktree, ".claude", "flows", "bug.json"), "utf8")).toBe("branch version");
	});

	it("does nothing when the main checkout has no .claude", async () => {
		rmSync(join(repo, ".claude"), { recursive: true });
		expect(await syncAgentConfig(repo, worktree)).toEqual([]);
		expect(existsSync(join(worktree, ".claude"))).toBe(false);
	});
});
