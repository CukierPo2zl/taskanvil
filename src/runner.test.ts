import { describe, expect, it } from "vitest";
import { formatQuestions } from "./runner.js";

describe("formatQuestions", () => {
	it("numbers questions and lists their options for a Linear reply", () => {
		const body = formatQuestions([
			{
				question: "Which branch should this build on?",
				options: [{ label: "main", description: "the scaffold" }, { label: "agent/agent-86" }],
			},
			{ question: "Which features?", multiSelect: true, options: [{ label: "Balance" }, { label: "History" }] },
		]);

		expect(body).toContain("**1. Which branch should this build on?**");
		expect(body).toContain("   - **main** — the scaffold");
		expect(body).toContain("   - **agent/agent-86**\n");
		expect(body).toContain("**2. Which features?** _(pick any)_");
		expect(body).toMatch(/Reply here/);
	});
});
