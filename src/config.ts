import type { Directives, IssueInfo, WorktreeInfo } from "./types.js";

export interface CommitConvention {
	/**
	 * Template for the first line, e.g. "{ticket}: {summary}".
	 * "{ticket}" is resolved from directives at session start; "{summary}" is
	 * whatever Claude writes, validated by summaryPattern.
	 */
	format: string;
	summaryPattern?: RegExp;
	rules?: string;
}

export interface RepoConfig {
	path: string;
	baseBranch: string;
	remote?: string;
	worktreeBaseDir?: string;
	commit?: CommitConvention;
	setupCommand?: string;
}

export interface DirectiveSpec {
	description: string;
	type?: "string" | "boolean";
	validate?: RegExp;
	required?: "ask" | false;
	ask?: string;
	default?: string | boolean | ((issue: IssueInfo) => string | boolean | undefined);
}

export interface GitPolicy {
	commit?: boolean;
	push?: boolean;
}

export interface ClaudeRunOptions {
	skill: string;
	/**
	 * "continue" resumes this Linear session's previous Claude session, so the
	 * agent keeps full context of what earlier steps did (right for
	 * implement→simplify→commit chains). "fresh" (default) starts clean —
	 * right for review-style steps that must not inherit the author's bias.
	 */
	session?: "fresh" | "continue";
	model?: string;
	tools?: string[];
	disallowedTools?: string[];
	git?: GitPolicy;
	maxTurns?: number;
	extraPrompt?: string;
	cwd?: string;
	/**
	 * When the agent ends a turn waiting on the user, post it as a Linear
	 * elicitation and resume the same Claude session with their reply, instead
	 * of moving on to the next step. Right for grilling/planning steps.
	 */
	interactive?: boolean;
}

export interface ClaudeRunResult {
	finalText: string;
	claudeSessionId: string;
	turns: number;
}

export interface ActivityPort {
	thought(body: string): Promise<void>;
	action(action: string, parameter: string, result?: string): Promise<void>;
	/** Final answer — this ends the session spinner in Linear. */
	response(body: string): Promise<void>;
	/** Question to the user — puts the session into awaiting-input state. */
	elicitation(body: string): Promise<void>;
	error(body: string): Promise<void>;
}

export interface HandlerCtx {
	issue: IssueInfo;
	directives: Directives;
	repo: RepoConfig & { name: string };
	promptContext?: string;
	guidance?: string;

	worktree(opts?: { branch?: string; dir?: string }): Promise<WorktreeInfo>;
	claude(opts: ClaudeRunOptions): Promise<ClaudeRunResult>;
	commit(message: string): Promise<void>;
	push(): Promise<void>;
	openPR(opts?: { title?: string; body?: string; draft?: boolean }): Promise<string>;
	post: ActivityPort;
}

export type LabelHandler = (ctx: HandlerCtx) => Promise<void>;

export interface AgentConfig {
	port?: number;
	repos?: Record<string, RepoConfig>;
	defaultRepo?: string;
	repoRouting?: Record<string, string>;
	directives: Record<string, DirectiveSpec>;
	labels: Record<string, LabelHandler>;
	default: LabelHandler;
	intakeModel?: string;
}

export function defineAgent(config: AgentConfig): AgentConfig {
	return config;
}
