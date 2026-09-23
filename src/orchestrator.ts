import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivityPort, AgentConfig, ClaudeRunOptions, HandlerCtx, LabelHandler } from "./config.js";
import { type FlowNode, listFlows, matchLabel, resolveFlow, runFlow } from "./flow.js";
import * as git from "./git.js";
import { applyAskAnswer, runIntake } from "./intake.js";
import type { LinearService } from "./linear.js";
import { loadProjectConfig, mergeDirectives, type ProjectConfig } from "./projectConfig.js";
import type { RepoStore, RepoWithSource } from "./repoRegistry.js";
import { loadSkillFile, type RunnerHandle, resolveConvention, startClaude } from "./runner.js";
import { findSkill } from "./skills.js";
import type { SessionRecord, WebhookEvent, WorktreeInfo } from "./types.js";

export class Orchestrator {
	private sessions = new Map<string, SessionRecord>();
	private runners = new Map<string, RunnerHandle>();
	private stateFile: string;

	constructor(
		private config: AgentConfig,
		private linear: LinearService,
		private projectRoot: string,
		private repos: RepoStore,
	) {
		this.stateFile = join(projectRoot, "runtime", "state.json");
		if (existsSync(this.stateFile)) {
			const saved: SessionRecord[] = JSON.parse(readFileSync(this.stateFile, "utf8"));
			for (const record of saved) {
				if (record.status === "running") record.status = "stopped";
				this.sessions.set(record.agentSessionId, record);
			}
		}
	}

	private persist(): void {
		writeFileSync(this.stateFile, JSON.stringify([...this.sessions.values()], null, 2));
	}

	private activityPort(agentSessionId: string): ActivityPort {
		const linear = this.linear;
		return {
			thought: (body) => linear.postActivity(agentSessionId, { type: "thought", body }),
			action: (action, parameter, result) =>
				linear.postActivity(agentSessionId, { type: "action", action, parameter, result }),
			response: (body) => linear.postActivity(agentSessionId, { type: "response", body }),
			elicitation: (body) => linear.postActivity(agentSessionId, { type: "elicitation", body }),
			error: (body) => linear.postActivity(agentSessionId, { type: "error", body }),
		};
	}

	async handleEvent(event: WebhookEvent): Promise<void> {
		const post = this.activityPort(event.agentSessionId);
		try {
			if (event.stopSignal) return await this.handleStop(event, post);
			if (event.action === "created") return await this.handleCreated(event, post);
			return await this.handlePrompted(event, post);
		} catch (err) {
			const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
			console.error(`[orchestrator] ${event.agentSessionId} failed:`, message);
			const record = this.sessions.get(event.agentSessionId);
			if (record) {
				record.status = "failed";
				this.persist();
			}
			await post.error(`Something went wrong:\n\`\`\`\n${truncate(message, 1500)}\n\`\`\``).catch(() => {});
		}
	}

	private async handleStop(event: WebhookEvent, post: ActivityPort): Promise<void> {
		const runner = this.runners.get(event.agentSessionId);
		runner?.abort();
		this.runners.delete(event.agentSessionId);
		const record = this.sessions.get(event.agentSessionId);
		if (record) {
			record.status = "stopped";
			record.updatedAt = new Date().toISOString();
			this.persist();
		}
		await post.response("Stopped. The worktree and any commits are left as they are.");
	}

	private async handleCreated(event: WebhookEvent, post: ActivityPort): Promise<void> {
		if (!event.issue) {
			await post.error("This session has no issue attached — nothing to work on.");
			return;
		}
		const issue = await this.linear.fetchIssue(event.issue.id);

		const repoName = this.routeRepo(issue.labels);
		const matched = matchLabel(issue.labels, this.knownLabels(repoName));

		const record: SessionRecord = {
			agentSessionId: event.agentSessionId,
			issue,
			repoName,
			label: matched ?? "default",
			status: "intake",
			directives: {},
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		this.sessions.set(event.agentSessionId, record);

		const intake = await runIntake(this.config, this.directiveSpecs(repoName), issue, event.promptBody);
		record.directives = intake.directives;

		if (intake.ask) {
			record.pendingAsk = { directive: intake.ask.directive };
			this.persist();
			await post.elicitation(intake.ask.question);
			return;
		}

		this.persist();
		await this.announceAndRun(record, event, post);
	}

	private async handlePrompted(event: WebhookEvent, post: ActivityPort): Promise<void> {
		const record = this.sessions.get(event.agentSessionId);
		if (!record) {
			await post.error(
				"I have no state for this session (the agent may have been restarted before work began). Please re-delegate the issue.",
			);
			return;
		}

		if (record.pendingAsk) {
			const result = await applyAskAnswer(
				this.config,
				this.directiveSpecs(record.repoName),
				record.issue,
				record.directives,
				record.pendingAsk.directive,
				event.promptBody ?? "",
			);
			record.directives = result.directives;
			if (result.ask) {
				record.pendingAsk = { directive: result.ask.directive };
				this.persist();
				await post.elicitation(result.ask.question);
				return;
			}
			record.pendingAsk = undefined;
			this.persist();
			await this.announceAndRun(record, event, post);
			return;
		}

		const runner = this.runners.get(event.agentSessionId);
		if (runner && record.status === "running") {
			runner.inject(formatUserComment(event.promptBody ?? ""));
			await post.thought("Noted — feeding your comment into the running session.");
			return;
		}

		await this.announceAndRun(record, event, post, { resume: true });
	}

	private routeRepo(labels: string[]): string {
		const byLabel = this.repos.routeByLabels(labels);
		if (byLabel) return byLabel;
		for (const [label, repo] of Object.entries(this.config.repoRouting ?? {})) {
			if (labels.some((l) => l.toLowerCase() === label.toLowerCase()) && this.repos.get(repo)) return repo;
		}
		const fallback = this.repos.defaultName();
		if (!fallback) throw new Error("No repositories registered — add a project in the flow editor UI first.");
		return fallback;
	}

	/**
	 * The repo's contract file (<repo>/.claude/agent.json), read fresh each time
	 * so edits apply without a restart. A broken file fails the session loudly
	 * rather than silently running with the wrong ticket rules.
	 */
	private projectConfig(repoName: string): ProjectConfig | undefined {
		const repo = this.repos.get(repoName);
		return repo ? loadProjectConfig(repo.path) : undefined;
	}

	private directiveSpecs(repoName: string) {
		return mergeDirectives(this.config.directives, this.projectConfig(repoName));
	}

	private knownLabels(repoName: string): string[] {
		const repo = this.repos.get(repoName);
		const flowLabels = repo ? listFlows(repo).map((f) => f.label) : [];
		return [...flowLabels, ...Object.keys(this.config.labels)];
	}

	private async announceAndRun(
		record: SessionRecord,
		event: WebhookEvent,
		post: ActivityPort,
		opts: { resume?: boolean } = {},
	): Promise<void> {
		const handler: LabelHandler = this.config.labels[record.label] ?? this.config.default;
		const repoConfig = this.repos.get(record.repoName);
		if (!repoConfig) throw new Error(`Repo "${record.repoName}" is not registered`);

		const flow = resolveFlow(repoConfig, record.label);

		const directivesText = Object.entries(record.directives)
			.map(([k, v]) => `${k}: ${v}`)
			.join(" · ");
		const planLabel = flow ? `flow: \`${flow.definition.name}\`` : `handler: \`${record.label}\``;
		await post.thought(
			`**Plan** — ${planLabel} · repo: \`${record.repoName}\`${directivesText ? ` · ${directivesText}` : ""}${opts.resume ? " · resuming previous session" : ""}`,
		);

		record.status = "running";
		record.updatedAt = new Date().toISOString();
		this.persist();

		const ctx = this.buildCtx(record, event, post, repoConfig, opts.resume ?? false);
		if (flow && !opts.resume) {
			await runFlow(flow.definition, ctx, {
				resolveSkill: (name) => findSkill(repoConfig, name),
			});
		} else if (flow && opts.resume) {
			// Follow-up comment on a completed flow run: resume the Claude session
			// with the last agent node's settings instead of re-walking the graph.
			const lastAgent = flow.definition.nodes
				.filter((n): n is Extract<FlowNode, { type: "agent" }> => n.type === "agent")
				.at(-1);
			await ctx.claude({
				skill: "", // unused on resume — the prompt is the user's comment
				model: lastAgent?.model,
				tools: lastAgent?.tools,
				git: lastAgent?.git,
			});
		} else {
			await handler(ctx);
		}

		if (!ctx._responsePosted) {
			await post.response(ctx._lastClaudeText || "Done.");
		}

		record.status = "done";
		record.updatedAt = new Date().toISOString();
		this.runners.delete(record.agentSessionId);
		this.persist();
	}

	private buildCtx(
		record: SessionRecord,
		event: WebhookEvent,
		post: ActivityPort,
		repoConfig: RepoWithSource,
		resume: boolean,
	): HandlerCtx & { _responsePosted: boolean; _lastClaudeText: string } {
		const orchestrator = this;
		const commitConvention = this.projectConfig(record.repoName)?.commit ?? repoConfig.commit;
		let worktree: WorktreeInfo | undefined = record.worktreePath
			? {
					path: record.worktreePath,
					branch: record.branch ?? "",
					baseBranch: repoConfig.baseBranch,
					repoPath: repoConfig.path,
				}
			: undefined;

		const ctx: HandlerCtx & { _responsePosted: boolean; _lastClaudeText: string } = {
			issue: record.issue,
			directives: record.directives,
			repo: { ...repoConfig, name: record.repoName },
			promptContext: event.promptContext,
			guidance: event.guidance,
			_responsePosted: false,
			_lastClaudeText: "",

			post: {
				...post,
				response: async (body) => {
					ctx._responsePosted = true;
					await post.response(body);
				},
			},

			async worktree(opts = {}) {
				const branch =
					opts.branch ??
					(typeof record.directives.branch === "string" ? record.directives.branch : undefined) ??
					`agent/${record.issue.identifier.toLowerCase()}`;
				const dir = opts.dir ?? record.issue.identifier;
				worktree = await git.createWorktree(repoConfig, {
					branch,
					dir,
					worktreeBaseDir: repoConfig.worktreeBaseDir ?? join(orchestrator.projectRoot, "runtime", "worktrees"),
				});
				record.worktreePath = worktree.path;
				record.branch = worktree.branch;
				orchestrator.persist();
				await post.action("worktree", `${worktree.path} (branch ${branch} from ${repoConfig.baseBranch})`);
				return worktree;
			},

			async claude(opts: ClaudeRunOptions) {
				const cwd = opts.cwd ?? worktree?.path ?? repoConfig.path;
				const convention = commitConvention ? resolveConvention(commitConvention, record.directives) : undefined;

				// session: "continue" chains onto the previous step's Claude session —
				// it already holds the issue context, so the prompt is just the new skill.
				const continueSession = !resume && opts.session === "continue" && !!record.claudeSessionId;

				const skillText = resume ? "" : loadSkillFile(findSkill(repoConfig, opts.skill).path);
				const prompt = resume
					? formatUserComment(event.promptBody ?? "Continue.")
					: continueSession
						? [skillText, opts.extraPrompt].filter(Boolean).join("\n\n")
						: buildPrompt({
								skill: skillText,
								promptContext: event.promptContext,
								guidance: event.guidance,
								issue: record.issue,
								directives: record.directives,
								conventionText: convention ? `Commit messages MUST match: ${convention.describe}` : undefined,
								extra: opts.extraPrompt,
							});

				const handle = startClaude({
					...opts,
					cwd,
					convention,
					post,
					initialPrompt: prompt,
					resume: resume || continueSession ? record.claudeSessionId : undefined,
				});
				orchestrator.runners.set(record.agentSessionId, handle);

				const result = await handle.result;
				record.claudeSessionId = result.claudeSessionId || record.claudeSessionId;
				ctx._lastClaudeText = result.finalText;
				orchestrator.persist();
				return result;
			},

			async commit(message) {
				if (!worktree) throw new Error("ctx.commit() called before ctx.worktree()");
				const sha = await git.commitAll(worktree.path, message);
				await post.action("commit", `${sha} ${message.split("\n")[0]}`);
			},

			async push() {
				if (!worktree) throw new Error("ctx.push() called before ctx.worktree()");
				const remote = repoConfig.remote ?? "origin";
				await git.push(worktree.path, worktree.branch, remote);
				await post.action("push", `${remote}/${worktree.branch}`);
			},

			async openPR(opts = {}) {
				if (!worktree) throw new Error("ctx.openPR() called before ctx.worktree()");
				const url = await git.openPR(worktree.path, {
					base: repoConfig.baseBranch,
					title: opts.title ?? `${record.issue.identifier}: ${record.issue.title}`,
					body: opts.body ?? `Linear: ${record.issue.url}`,
					draft: opts.draft,
				});
				await post.action("pull request", url);
				return url;
			},
		};
		return ctx;
	}
}

function buildPrompt(parts: {
	skill: string;
	promptContext?: string;
	guidance?: string;
	issue: SessionRecord["issue"];
	directives: SessionRecord["directives"];
	conventionText?: string;
	extra?: string;
}): string {
	const sections = [parts.skill.trim()];

	if (parts.promptContext) {
		sections.push(`<linear_context>\n${parts.promptContext}\n</linear_context>`);
	} else {
		sections.push(
			`<issue identifier="${parts.issue.identifier}" url="${parts.issue.url}">\n<title>${parts.issue.title}</title>\n<description>\n${parts.issue.description}\n</description>\n</issue>`,
		);
	}
	if (parts.guidance) sections.push(`<workspace_guidance>\n${parts.guidance}\n</workspace_guidance>`);

	const directives = Object.entries(parts.directives)
		.map(([k, v]) => `- ${k}: ${v}`)
		.join("\n");
	if (directives) sections.push(`<working_directives>\n${directives}\n</working_directives>`);
	if (parts.conventionText) sections.push(`<commit_convention>\n${parts.conventionText}\n</commit_convention>`);
	if (parts.extra) sections.push(parts.extra);

	return sections.join("\n\n");
}

function formatUserComment(body: string): string {
	return `<user_comment>\n${body}\n</user_comment>`;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}
