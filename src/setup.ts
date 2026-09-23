/**
 * First-run setup — connects the agent to a Linear workspace.
 *
 *   GET /setup            status page: env checklist, connect button, webhook URL
 *   GET /oauth/authorize  redirects to Linear's consent screen
 *   GET /oauth/callback   exchanges the code, writes runtime/tokens.json
 *
 * The agent runs on the user's machine, so the redirect URI is a localhost
 * URL and the OAuth state lives in process memory.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { LinearService } from "./linear.js";

export interface SetupOptions {
	linear: LinearService;
	/** Base URL the browser reaches the agent on, e.g. http://localhost:3456 */
	localUrl: string;
	/** Public URL Linear can reach (tunnel), if the user configured one. */
	publicUrl?: string;
	/** Name → present, for the env checklist. Values are never shown. */
	env: Record<string, boolean>;
}

const STATE_TTL_MS = 10 * 60 * 1000;

export function registerSetup(app: FastifyInstance, opts: SetupOptions): void {
	const pendingStates = new Map<string, number>();

	app.get("/setup", async (request, reply) => {
		const query = request.query as { connected?: string; error?: string };
		reply.type("text/html").send(renderSetupPage(opts, query));
	});

	app.get("/oauth/authorize", async (_request, reply) => {
		const state = randomBytes(16).toString("hex");
		pendingStates.set(state, Date.now() + STATE_TTL_MS);
		reply.redirect(opts.linear.authorizeUrl(state));
	});

	app.get("/oauth/callback", async (request, reply) => {
		const { code, state, error } = request.query as { code?: string; state?: string; error?: string };
		if (error) return reply.redirect(`/setup?error=${encodeURIComponent(error)}`);

		const expires = state ? pendingStates.get(state) : undefined;
		if (state) pendingStates.delete(state);
		if (!code || !expires || expires < Date.now()) {
			return reply.redirect("/setup?error=invalid_state");
		}

		try {
			const tokens = await opts.linear.completeOAuth(code);
			app.log.info({ workspace: tokens.workspaceName }, "linear connected");
			return reply.redirect("/setup?connected=1");
		} catch (err) {
			app.log.error(err, "oauth callback failed");
			return reply.redirect(`/setup?error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`);
		}
	});
}

function renderSetupPage(opts: SetupOptions, query: { connected?: string; error?: string }): string {
	const { linear, localUrl, publicUrl, env } = opts;
	const webhookBase = publicUrl ?? "<your public tunnel URL>";
	const checklist = Object.entries(env)
		.map(
			([name, present]) => `<li class="${present ? "ok" : "missing"}">${present ? "✓" : "✗"} <code>${name}</code></li>`,
		)
		.join("");
	const envReady = Object.values(env).every(Boolean);

	const status = linear.connected
		? `<p class="ok">Connected to <strong>${escapeHtml(linear.workspaceName ?? "Linear")}</strong>.</p>
		   <p><a class="button secondary" href="/oauth/authorize">Reconnect</a> <a class="button secondary" href="/">Open flow editor</a></p>`
		: envReady
			? `<p>No workspace connected yet.</p><p><a class="button" href="/oauth/authorize">Connect Linear workspace</a></p>`
			: `<p class="missing">Set the missing variables in <code>.env</code> and restart before connecting.</p>`;

	const banner = query.connected
		? `<div class="banner ok">Workspace connected. Tokens saved to <code>runtime/tokens.json</code>.</div>`
		: query.error
			? `<div class="banner missing">Connection failed: ${escapeHtml(query.error)}</div>`
			: "";

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>taskanvil setup</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
	:root { color-scheme: dark; --bg:#08090c; --text:#f4f5f8; --dim:#9a9daa; --line:rgba(255,255,255,.09); --acc:#8b93ff; --good:#4ade80; --bad:#f46570; }
	body { margin:0; padding:48px 16px; background:var(--bg); color:var(--text); font:15px/1.55 system-ui,-apple-system,sans-serif; }
	main { max-width:640px; margin:0 auto; }
	h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:15px; margin:32px 0 8px; color:var(--dim); text-transform:uppercase; letter-spacing:.04em; }
	code { font:13px ui-monospace,monospace; background:rgba(255,255,255,.06); padding:2px 6px; border-radius:4px; }
	ul { list-style:none; padding:0; margin:0; } li { padding:6px 0; border-bottom:1px solid var(--line); }
	.ok { color:var(--good); } .missing { color:var(--bad); }
	.banner { padding:12px 16px; border:1px solid currentColor; border-radius:8px; margin-bottom:24px; }
	.button { display:inline-block; padding:10px 18px; border-radius:8px; background:var(--acc); color:#08090c; font-weight:600; text-decoration:none; }
	.button.secondary { background:transparent; color:var(--text); border:1px solid var(--line); }
	p.hint { color:var(--dim); font-size:13px; }
</style></head><body><main>
	<h1>taskanvil</h1>
	<p class="hint">One-time setup for this machine.</p>
	${banner}
	<h2>1. Environment</h2>
	<ul>${checklist}</ul>
	<p class="hint">Register <code>${escapeHtml(localUrl)}/oauth/callback</code> as a redirect URL on your Linear OAuth application.</p>
	<h2>2. Linear workspace</h2>
	${status}
	<h2>3. Webhook</h2>
	<p>Point the OAuth application's webhook at <code>${escapeHtml(webhookBase)}/linear-webhook</code> with the <em>Agent session events</em> category enabled.</p>
	<p class="hint">Linear must reach this machine, so run a tunnel (ngrok, cloudflared) and set <code>AGENT_PUBLIC_URL</code> to its URL.</p>
</main></body></html>`;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
