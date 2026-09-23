import { join } from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: join(import.meta.dirname, "..", ".env") });

const { runIntake } = await import("../src/intake.js");
const { loadProjectConfig, mergeDirectives } = await import("../src/projectConfig.js");
const { RepoStore } = await import("../src/repoRegistry.js");
const config = (await import("../agent.config.js")).default;

const projectRoot = join(import.meta.dirname, "..");
const repos = new RepoStore(config, projectRoot);
const defaultName = repos.defaultName();
const repo = defaultName ? repos.get(defaultName) : undefined;
const specs = mergeDirectives(config.directives, repo ? loadProjectConfig(repo.path) : undefined);

const tableTicket = {
	id: "x",
	identifier: "LIN-99",
	title: "Implement the feature-flag service",
	url: "https://linear.app/acme/issue/LIN-99",
	labels: [],
	description: [
		"| Key | Value |",
		"| -- | -- |",
		"| Branch | feature/feature-flags-rewrite |",
		"| Model | Fable |",
		"| Ticket number | EXT-4711 |",
		"",
		"Migrate the current feature flags solution to the feature-flag service.",
	].join("\n"),
};

const proseTicket = {
	...tableTicket,
	identifier: "LIN-100",
	description:
		"Use EXT-2205 for the commits please. Work on branch release/2.4-hotfix, squash everything into a single commit, and push when you're done.",
};

const bareTicket = {
	...tableTicket,
	identifier: "LIN-101",
	description: "Fix the login redirect loop on session expiry.",
};

for (const [name, ticket] of Object.entries({ tableTicket, proseTicket, bareTicket })) {
	const result = await runIntake(config, specs, ticket);
	console.log(`\n=== ${name} (${ticket.identifier}) ===`);
	console.log("directives:", JSON.stringify(result.directives));
	console.log("ask:", result.ask ? `${result.ask.directive} → "${result.ask.question.slice(0, 60)}…"` : "none");
}
