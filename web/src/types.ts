/**
 * Mirrors of the engine's wire types (src/flow.ts, src/skills.ts).
 * Kept by hand — the API surface is small and changes rarely.
 */

export interface RepoInfo {
	name: string;
	path: string;
	baseBranch: string;
	remote?: string;
	routingLabel?: string;
	isDefault: boolean;
	source: "config" | "registry";
	remotes?: string[];
	contract: { source: string; directives: string[]; hasCommitConvention: boolean } | { error: string } | null;
}

export interface BrowseResult {
	path: string;
	parent: string | null;
	isGitRepo: boolean;
	dirs: Array<{ name: string; path: string; isGitRepo: boolean }>;
}

export type SkillSource = "project" | "global" | "plugin";

export interface SkillInfo {
	name: string;
	description: string;
	source: SkillSource;
	path: string;
	shadows?: SkillSource;
}

export interface GitPolicy {
	commit?: boolean;
	push?: boolean;
}

export type NodeType = "worktree" | "agent" | "commit" | "push" | "openPR" | "say" | "respond";

export interface FlowNodeDef {
	id: string;
	type: NodeType;
	position?: { x: number; y: number };
	branch?: string;
	dir?: string;
	skill?: string;
	model?: string;
	tools?: string[];
	session?: "fresh" | "continue";
	git?: GitPolicy;
	maxTurns?: number;
	extraPrompt?: string;
	message?: string;
	title?: string;
	body?: string;
	draft?: boolean;
	template?: string;
}

export interface FlowEdgeDef {
	from: string;
	to: string;
	condition?: string;
}

export interface FlowDefinition {
	name: string;
	description?: string;
	nodes: FlowNodeDef[];
	edges: FlowEdgeDef[];
}

export interface FlowListing {
	label: string;
	name: string;
	description?: string;
	error?: string;
}

export interface AgentStatus {
	linear: { connected: boolean; workspaceName?: string };
	setupUrl: string;
}
