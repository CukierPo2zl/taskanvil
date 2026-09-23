/**
 * YOUR agent. Every behavior lives in this file — the engine in src/ only
 * provides primitives. If the agent does something, it's because a line here
 * says so.
 *
 * This file is a starting point, not a product. The skill names below
 * ("debug", "implement", "investigate") are placeholders: taskanvil ships no
 * skills. Replace them with skills you own — a `SKILL.md` in the target
 * repository's `.claude/skills/<name>/`, in `~/.claude/skills/<name>/`, or
 * from an installed Claude Code plugin ("plugin:skill"). A label whose skill
 * is missing fails the run and posts the available skill names to Linear.
 */
import { defineAgent } from "./src/config.js";

const READ_ONLY = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task"];
const CODING = [
	...READ_ONLY,
	"Edit",
	"Write",
	"Bash(git status*)",
	"Bash(git diff*)",
	"Bash(git log*)",
	"Bash(git add*)",
	"Bash(git commit*)",
	"Bash(pnpm *)",
	"Bash(npx tsc*)",
];

export default defineAgent({
	directives: {
		branch: {
			description: "Git branch name to work on, e.g. from a table row named 'Branch'.",
			validate: /^[\w./-]+$/,
			default: (issue) => `agent/${issue.identifier.toLowerCase()}`,
		},
		push: {
			description:
				"Whether the work should be pushed to origin when finished (true only if the ticket explicitly says so).",
			type: "boolean",
			default: false,
		},
		instructions: {
			description: "Any extra instructions about how to work: commit granularity, style, things to avoid, etc.",
		},
	},

	labels: {
		bug: async (ctx) => {
			await ctx.worktree();
			await ctx.claude({
				skill: "debug",
				model: "opus",
				tools: CODING,
				git: { commit: true, push: false },
			});
			if (ctx.directives.push === true) {
				await ctx.push();
				await ctx.openPR({ draft: true });
			}
		},

		feature: async (ctx) => {
			await ctx.worktree();
			await ctx.claude({
				skill: "implement",
				model: "opus",
				tools: CODING,
				git: { commit: true, push: false },
			});
			if (ctx.directives.push === true) {
				await ctx.push();
				await ctx.openPR({ draft: true });
			}
		},

		spike: async (ctx) => {
			const result = await ctx.claude({
				skill: "investigate",
				tools: READ_ONLY,
				git: { commit: false, push: false },
				cwd: ctx.repo.path,
			});
			await ctx.post.response(result.finalText);
		},
	},

	default: async (ctx) => {
		await ctx.worktree();
		await ctx.claude({
			skill: "implement",
			model: "opus",
			tools: CODING,
			git: { commit: true, push: false },
		});
	},
});
