export interface IssueInfo {
	id: string;
	identifier: string;
	title: string;
	description: string;
	url: string;
	labels: string[];
	branchNameSuggestion?: string;
}

export type Directives = Record<string, string | boolean | undefined>;

export interface WebhookEvent {
	action: "created" | "prompted";
	agentSessionId: string;
	organizationId: string;
	issue?: IssueInfo;
	promptContext?: string;
	guidance?: string;
	promptBody?: string;
	stopSignal: boolean;
}

export type SessionStatus = "intake" | "running" | "done" | "failed" | "stopped";

export interface SessionRecord {
	agentSessionId: string;
	issue: IssueInfo;
	repoName: string;
	label: string;
	status: SessionStatus;
	directives: Directives;
	pendingAsk?: { directive: string };
	claudeSessionId?: string;
	worktreePath?: string;
	branch?: string;
	createdAt: string;
	updatedAt: string;
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	baseBranch: string;
	repoPath: string;
	/** `.claude/` entries copied in from the main checkout, e.g. "flows/bug.json". */
	synced: string[];
}
