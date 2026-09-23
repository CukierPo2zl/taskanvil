/**
 * Entry point: load config → start Fastify → wire webhook events to the orchestrator.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Fastify from "fastify";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(projectRoot, ".env") });

// Imports that read env vars come after dotenv.
const { LinearService } = await import("./linear.js");
const { Orchestrator } = await import("./orchestrator.js");
const { registerApi } = await import("./api.js");
const { registerSetup } = await import("./setup.js");
const { RepoStore } = await import("./repoRegistry.js");
const config = (await import("../agent.config.js")).default;

const port = config.port ?? Number(process.env.AGENT_PORT ?? 3456);
const host = process.env.AGENT_HOST ?? "127.0.0.1";
const localUrl = `http://localhost:${port}`;
const publicUrl = process.env.AGENT_PUBLIC_URL?.replace(/\/$/, "");

const required = ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET"] as const;
const env = Object.fromEntries(required.map((name) => [name, Boolean(process.env[name])]));
const missing = required.filter((name) => !env[name]);

const linear = new LinearService(
	process.env.LINEAR_WEBHOOK_SECRET ?? "",
	{
		clientId: process.env.LINEAR_CLIENT_ID ?? "",
		clientSecret: process.env.LINEAR_CLIENT_SECRET ?? "",
		redirectUri: `${localUrl}/oauth/callback`,
	},
	join(projectRoot, "runtime", "tokens.json"),
);
const repos = new RepoStore(config, projectRoot);
const orchestrator = new Orchestrator(config, linear, projectRoot, repos);

const app = Fastify({ logger: { level: "info" } });

if (missing.length === 0) {
	linear.registerWebhookRoute(app, (event) => {
		app.log.info(
			{ action: event.action, session: event.agentSessionId, issue: event.issue?.identifier, stop: event.stopSignal },
			"webhook",
		);
		void orchestrator.handleEvent(event);
	});
}

app.get("/health", async () => ({ ok: true, linear: linear.connected }));

registerSetup(app, { linear, localUrl, publicUrl, env });
registerApi(app, repos, () => ({
	connected: linear.connected,
	workspaceName: linear.workspaceName,
}));

// Flow editor UI — built bundle, if present (pnpm ui:build).
const uiDist = join(projectRoot, "web", "dist");
if (existsSync(uiDist)) {
	const { default: fastifyStatic } = await import("@fastify/static");
	await app.register(fastifyStatic, { root: uiDist, prefix: "/ui/" });
	app.get("/", async (_request, reply) => reply.redirect(linear.connected ? "/ui/" : "/setup"));
} else {
	app.log.warn("web/dist not found — flow editor UI not served (run: pnpm ui:build)");
	app.get("/", async (_request, reply) => reply.redirect("/setup"));
}

await app.listen({ port, host });

if (missing.length > 0) {
	app.log.warn({ missing }, `environment incomplete — webhook disabled, see ${localUrl}/setup`);
} else if (!linear.connected) {
	app.log.warn(`no Linear workspace connected — open ${localUrl}/setup to connect`);
} else {
	app.log.info({ workspace: linear.workspaceName }, `taskanvil listening on ${localUrl}`);
}
