import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { RepoConfig } from "./config.js";
import type { WorktreeInfo } from "./types.js";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
	return stdout.trim();
}

export async function createWorktree(
	repo: RepoConfig,
	opts: { branch: string; dir: string; worktreeBaseDir: string },
): Promise<WorktreeInfo> {
	const path = join(opts.worktreeBaseDir, opts.dir);
	const remote = repo.remote ?? "origin";
	await mkdir(dirname(path), { recursive: true });

	await git(repo.path, "fetch", remote, repo.baseBranch);

	const existing = await git(repo.path, "worktree", "list", "--porcelain");
	if (existing.includes(`worktree ${path}`)) {
		return { path, branch: opts.branch, baseBranch: repo.baseBranch, repoPath: repo.path };
	}

	const branchExists =
		(await git(repo.path, "branch", "--list", opts.branch)) !== "" ||
		(await git(repo.path, "ls-remote", "--heads", remote, opts.branch)) !== "";

	if (branchExists) {
		await git(repo.path, "worktree", "add", path, opts.branch);
	} else {
		await git(repo.path, "worktree", "add", "-b", opts.branch, path, `${remote}/${repo.baseBranch}`);
	}

	if (repo.setupCommand) {
		await exec("sh", ["-c", repo.setupCommand], {
			cwd: path,
			timeout: 5 * 60 * 1000,
			maxBuffer: 10 * 1024 * 1024,
		});
	}

	return { path, branch: opts.branch, baseBranch: repo.baseBranch, repoPath: repo.path };
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
	await git(repoPath, "worktree", "remove", "--force", worktreePath);
}

export async function commitAll(worktreePath: string, message: string): Promise<string> {
	await git(worktreePath, "add", "-A");
	const staged = await git(worktreePath, "diff", "--cached", "--name-only");
	if (!staged) throw new Error("Nothing to commit — working tree is clean");
	await git(worktreePath, "commit", "-m", message);
	return git(worktreePath, "rev-parse", "--short", "HEAD");
}

export async function push(worktreePath: string, branch: string, remote = "origin"): Promise<void> {
	await git(worktreePath, "push", "-u", remote, branch);
}

export async function hasUnpushedCommits(
	worktreePath: string,
	branch: string,
	base: string,
	remote = "origin",
): Promise<boolean> {
	const count = await git(worktreePath, "rev-list", "--count", `${remote}/${base}..${branch}`);
	return Number(count) > 0;
}

export async function openPR(
	worktreePath: string,
	opts: { base: string; title: string; body: string; draft?: boolean },
): Promise<string> {
	const args = ["pr", "create", "--base", opts.base, "--title", opts.title, "--body", opts.body];
	if (opts.draft) args.push("--draft");
	const { stdout } = await exec("gh", args, { cwd: worktreePath });
	const url = stdout.trim().split("\n").pop() ?? "";
	if (!url.startsWith("http")) throw new Error(`gh pr create returned unexpected output: ${stdout}`);
	return url;
}

export interface GitCommandInfo {
	isGit: boolean;
	subcommand?: string;
	commitMessage?: string;
	hasAmend: boolean;
	hasNoVerify: boolean;
	hasForce: boolean;
}

/**
 * Shallow parse of a shell command to detect git usage. Deliberately strict:
 * anything ambiguous (chained commands mixing git with other tools) is still
 * reported as git so the enforcement layer can decide.
 */
export function inspectGitCommand(command: string): GitCommandInfo {
	const gitMatch = command.match(/(?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?(\S+)([\s\S]*)/);
	if (!gitMatch) return { isGit: false, hasAmend: false, hasNoVerify: false, hasForce: false };

	const subcommand = gitMatch[1];
	const rest = gitMatch[2] ?? "";

	// Extract -m "..." / -m '...' (first -m only; multiple -m form paragraphs)
	const msgMatch = rest.match(/(?:^|\s)(?:-m|--message)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
	const commitMessage = msgMatch ? (msgMatch[1] ?? msgMatch[2] ?? msgMatch[3]) : undefined;

	return {
		isGit: true,
		subcommand,
		commitMessage,
		hasAmend: /\s--amend\b/.test(rest),
		hasNoVerify: /\s--no-verify\b/.test(rest),
		hasForce: /\s(--force|-f|--force-with-lease)\b/.test(rest) && subcommand === "push",
	};
}
