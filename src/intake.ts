import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig, DirectiveSpec } from "./config.js";
import type { Directives, IssueInfo } from "./types.js";

/** Cheap, fast model for structured extraction. Override with `intakeModel` or ANTHROPIC_MODEL_INTAKE. */
const DEFAULT_INTAKE_MODEL = "claude-haiku-4-5-20251001";

const anthropic = process.env.ANTHROPIC_API_KEY
	? new Anthropic()
	: new Anthropic({ authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN });

export interface IntakeResult {
	directives: Directives;
	ask?: { directive: string; question: string };
}

export async function runIntake(
	config: AgentConfig,
	specs: Record<string, DirectiveSpec>,
	issue: IssueInfo,
	extraUserText?: string,
): Promise<IntakeResult> {
	const extracted = await extract(config, issue, specs, extraUserText);
	const directives: Directives = {};

	for (const [name, spec] of Object.entries(specs)) {
		let value = extracted[name];

		if (typeof value === "string" && spec.validate && !spec.validate.test(value)) {
			value = undefined;
		}

		if (value === undefined) {
			const dflt = typeof spec.default === "function" ? spec.default(issue) : spec.default;
			if (dflt !== undefined) {
				directives[name] = dflt;
				continue;
			}
			if (spec.required === "ask") {
				return {
					directives,
					ask: {
						directive: name,
						question:
							spec.ask ??
							`I couldn't find a value for "${name}" (${spec.description}) in this ticket. What should I use?`,
					},
				};
			}
			continue;
		}

		directives[name] = value;
	}

	return { directives };
}

export async function applyAskAnswer(
	config: AgentConfig,
	specs: Record<string, DirectiveSpec>,
	issue: IssueInfo,
	current: Directives,
	askedDirective: string,
	answer: string,
): Promise<IntakeResult> {
	const spec = specs[askedDirective];
	if (!spec) return { directives: current };

	const result = await runIntake(
		config,
		specs,
		issue,
		`The user answered the question "${spec.ask ?? askedDirective}" with: ${answer}`,
	);
	const merged = { ...result.directives, ...pruneUndefined(current) };

	if (merged[askedDirective] === undefined) {
		return {
			directives: merged,
			ask: {
				directive: askedDirective,
				question: `I still couldn't parse a valid value for "${askedDirective}" from your reply (expected ${spec.validate ?? "any value"}). Could you give it to me exactly?`,
			},
		};
	}
	return { directives: merged };
}

function pruneUndefined(d: Directives): Directives {
	return Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
}

async function extract(
	config: AgentConfig,
	issue: IssueInfo,
	specs: Record<string, DirectiveSpec>,
	extraUserText?: string,
): Promise<Directives> {
	const properties: Record<string, unknown> = {};
	for (const [name, spec] of Object.entries(specs)) {
		properties[name] = {
			type: spec.type === "boolean" ? "boolean" : "string",
			description: spec.description,
		};
	}

	const response = await anthropic.messages.create({
		model: config.intakeModel ?? process.env.ANTHROPIC_MODEL_INTAKE ?? DEFAULT_INTAKE_MODEL,
		max_tokens: 1024,
		tools: [
			{
				name: "report_directives",
				description:
					"Report the working directives found in the ticket. Omit any field the ticket does not clearly specify — never guess or invent values.",
				input_schema: { type: "object", properties, required: [] },
			},
		],
		tool_choice: { type: "tool", name: "report_directives" },
		messages: [
			{
				role: "user",
				content: [
					`Read this ticket and extract working directives. The author may use a table, prose, bullets, or any format.`,
					``,
					`<ticket identifier="${issue.identifier}">`,
					`<title>${issue.title}</title>`,
					`<description>`,
					issue.description || "(empty)",
					`</description>`,
					`</ticket>`,
					extraUserText ? `\n<additional_user_message>\n${extraUserText}\n</additional_user_message>` : "",
				].join("\n"),
			},
		],
	});

	const toolUse = response.content.find((b) => b.type === "tool_use");
	const input = (toolUse?.type === "tool_use" ? toolUse.input : {}) as Record<string, unknown>;

	const out: Directives = {};
	for (const [k, v] of Object.entries(input)) {
		if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
		else if (typeof v === "boolean") out[k] = v;
	}
	return out;
}
