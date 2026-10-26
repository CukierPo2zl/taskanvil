import { readFileSync } from "node:fs";
import { type PermissionResult, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ActivityPort, ClaudeRunOptions, ClaudeRunResult, CommitConvention, GitPolicy } from "./config.js";
import { inspectGitCommand } from "./git.js";
import { stripFrontmatter } from "./skills.js";
import type { Directives } from "./types.js";

export interface ResolvedConvention {
	prefix: string;
	summaryPattern: RegExp;
	describe: string;
}

export function resolveConvention(convention: CommitConvention, directives: Directives): ResolvedConvention {
	let prefix = convention.format;
	for (const [key, value] of Object.entries(directives)) {
		prefix = prefix.replaceAll(`{${key}}`, String(value ?? ""));
	}
	const summaryIdx = prefix.indexOf("{summary}");
	prefix = summaryIdx >= 0 ? prefix.slice(0, summaryIdx) : prefix;

	return {
		prefix,
		summaryPattern: convention.summaryPattern ?? /^.{5,72}(?<!\.)$/,
		describe: `${prefix}<summary>${convention.rules ? ` — ${convention.rules}` : ""}`,
	};
}

function gitGate(
	convention: ResolvedConvention | undefined,
	policy: GitPolicy,
): (toolName: string, input: Record<string, unknown>) => PermissionResult | null {
	return (toolName, input) => {
		if (toolName !== "Bash") return null;
		const command = String(input.command ?? "");
		const info = inspectGitCommand(command);
		if (!info.isGit) return null;

		if (info.hasNoVerify) {
			return { behavior: "deny", message: "git --no-verify is not allowed in this session." };
		}
		if (info.hasAmend) {
			return { behavior: "deny", message: "git --amend is not allowed — create a new commit instead." };
		}
		if (info.subcommand === "push") {
			if (policy.push !== true) {
				return {
					behavior: "deny",
					message: "Pushing is not allowed in this session. Finish your work; shipping is handled outside the session.",
				};
			}
			if (info.hasForce) {
				return { behavior: "deny", message: "Force-push is not allowed." };
			}
			return { behavior: "allow" };
		}
		if (info.subcommand === "commit") {
			if (policy.commit === false) {
				return {
					behavior: "deny",
					message: "Committing is not allowed in this session — leave changes in the working tree.",
				};
			}
			if (convention) {
				const message = info.commitMessage;
				if (!message) {
					return {
						behavior: "deny",
						message: `Commit with an inline message: git commit -m "${convention.describe}"`,
					};
				}
				const firstLine = message.split("\n")[0] ?? "";
				if (!firstLine.startsWith(convention.prefix)) {
					return {
						behavior: "deny",
						message: `Commit message must start with "${convention.prefix}". Required format: ${convention.describe}`,
					};
				}
				const summary = firstLine.slice(convention.prefix.length);
				if (!convention.summaryPattern.test(summary)) {
					return {
						behavior: "deny",
						message: `Commit summary "${summary}" violates the convention (${convention.summaryPattern}). Required format: ${convention.describe}`,
					};
				}
			}
			return { behavior: "allow" };
		}
		return null;
	};
}

export class PromptStream implements AsyncIterable<SDKUserMessage> {
	private queue: SDKUserMessage[] = [];
	private waiters: Array<(m: SDKUserMessage | null) => void> = [];
	private closed = false;

	push(text: string): void {
		if (this.closed) return;
		const msg: SDKUserMessage = {
			type: "user",
			message: { role: "user", content: text },
			parent_tool_use_id: null,
			session_id: "",
		};
		const waiter = this.waiters.shift();
		if (waiter) waiter(msg);
		else this.queue.push(msg);
	}

	close(): void {
		this.closed = true;
		for (const w of this.waiters.splice(0)) w(null);
	}

	async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		while (true) {
			const msg =
				this.queue.shift() ??
				(await new Promise<SDKUserMessage | null>((resolve) => {
					if (this.closed) return resolve(null);
					this.waiters.push(resolve);
				}));
			if (msg === null) return;
			yield msg;
		}
	}
}

export interface RunnerHandle {
	result: Promise<ClaudeRunResult>;
	inject(text: string): void;
	abort(): void;
}

export function startClaude(
	opts: ClaudeRunOptions & {
		cwd: string;
		convention?: ResolvedConvention;
		post: ActivityPort;
		initialPrompt: string;
		resume?: string;
		/** Puts a question to the user (Linear elicitation) and resolves with their reply; null = stopped. */
		askUser?: (body: string) => Promise<string | null>;
	},
): RunnerHandle {
	const stream = new PromptStream();
	stream.push(opts.initialPrompt);

	const abortController = new AbortController();
	const gate = gitGate(opts.convention, opts.git ?? {});

	const q = query({
		prompt: stream,
		options: {
			cwd: opts.cwd,
			model: opts.model,
			maxTurns: opts.maxTurns ?? 80,
			allowedTools: opts.tools,
			disallowedTools: opts.disallowedTools,
			resume: opts.resume,
			abortController,
			systemPrompt: { type: "preset", preset: "claude_code" },
			settingSources: [],
			canUseTool: async (toolName, input) => {
				if (toolName === "AskUserQuestion") {
					// Headless, the CLI has no picker and returns "did not answer" at once —
					// route the questions through Linear and hand the reply back as the answers.
					const questions = (input as { questions?: AskedQuestion[] }).questions ?? [];
					const reply = opts.askUser ? await opts.askUser(formatQuestions(questions)) : null;
					if (reply === null) {
						return { behavior: "deny", message: "Could not reach the user. Ask in plain text and end your turn." };
					}
					const answers = Object.fromEntries(questions.map((q) => [q.question, reply]));
					return { behavior: "allow", updatedInput: { ...input, answers } };
				}
				const verdict = gate(toolName, input as Record<string, unknown>);
				if (verdict?.behavior === "deny") {
					await opts.post.action("blocked", `${toolName}: ${verdict.message}`).catch(() => {});
					return verdict;
				}
				return verdict ?? { behavior: "allow", updatedInput: input };
			},
		},
	});

	const result = (async (): Promise<ClaudeRunResult> => {
		let claudeSessionId = "";
		let finalText = "";
		let turns = 0;

		try {
			for await (const message of q) {
				if (message.type === "system" && message.subtype === "init") {
					claudeSessionId = message.session_id;
				} else if (message.type === "assistant") {
					turns++;
					for (const block of message.message.content) {
						if (block.type === "text" && block.text.trim()) {
							await opts.post.thought(truncate(block.text, 3000)).catch(() => {});
						} else if (block.type === "tool_use") {
							await opts.post.action(block.name, truncate(summarizeInput(block.input), 300)).catch(() => {});
						}
					}
				} else if (message.type === "result") {
					finalText = message.subtype === "success" ? message.result : `Session ended: ${message.subtype}`;
					// Streaming input keeps the CLI alive until the prompt stream ends —
					// close it so the run resolves. Comments injected mid-turn were already
					// handed to the CLI and still produce a later result, which overwrites finalText.
					stream.close();
				}
			}
		} finally {
			stream.close();
		}

		return { finalText, claudeSessionId, turns };
	})();

	return {
		result,
		inject: (text) => stream.push(text),
		abort: () => {
			abortController.abort();
			stream.close();
		},
	};
}

interface AskedQuestion {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options?: Array<{ label: string; description?: string }>;
}

/** One Linear comment answers every question, so number them for the user to reply by number. */
export function formatQuestions(questions: AskedQuestion[]): string {
	return questions
		.map((q, i) => {
			const options = (q.options ?? []).map((o) => `   - **${o.label}**${o.description ? ` — ${o.description}` : ""}`);
			const hint = q.multiSelect ? " _(pick any)_" : "";
			return [`**${i + 1}. ${q.question}**${hint}`, ...options].join("\n");
		})
		.join("\n\n")
		.concat("\n\n_Reply here — answer by number, or in your own words._");
}

export function loadSkillFile(path: string): string {
	return stripFrontmatter(readFileSync(path, "utf8"));
}

function summarizeInput(input: unknown): string {
	if (input && typeof input === "object") {
		const o = input as Record<string, unknown>;
		const key = ["command", "file_path", "path", "pattern", "prompt", "url"].find((k) => typeof o[k] === "string");
		if (key) return String(o[key]);
	}
	return JSON.stringify(input ?? {});
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}
