import { LinearClient, LinearWebhooks } from "@linear/sdk";
import type { FastifyInstance } from "fastify";
import { type LinearTokens, readTokens, writeTokens } from "./tokens.js";
import type { IssueInfo, WebhookEvent } from "./types.js";

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
/** Agent sessions require an app actor with these scopes. */
const SCOPES = "write,app:assignable,app:mentionable";

export interface LinearOAuthConfig {
	clientId: string;
	clientSecret: string;
	/** Must match a redirect URL registered on the Linear OAuth application. */
	redirectUri: string;
}

export class LinearService {
	private client: LinearClient | undefined;
	private tokens: LinearTokens | undefined;
	private webhooks: InstanceType<typeof LinearWebhooks>;
	private refreshing: Promise<void> | null = null;

	constructor(
		webhookSecret: string,
		private oauth: LinearOAuthConfig,
		private tokensFile: string,
	) {
		this.webhooks = new LinearWebhooks(webhookSecret);
		const tokens = readTokens(tokensFile);
		if (tokens) this.connect(tokens);
	}

	/** True once a workspace has completed the OAuth handshake. */
	get connected(): boolean {
		return this.client !== undefined;
	}

	get workspaceName(): string | undefined {
		return this.tokens?.workspaceName;
	}

	private connect(tokens: LinearTokens): void {
		this.tokens = tokens;
		this.client = new LinearClient({ accessToken: tokens.accessToken });
	}

	private requireClient(): LinearClient {
		if (!this.client) throw new Error("Linear is not connected — open /setup to connect a workspace");
		return this.client;
	}

	// -------------------------------------------------------------------------
	// OAuth handshake (see setup.ts for the routes)
	// -------------------------------------------------------------------------

	authorizeUrl(state: string): string {
		const params = new URLSearchParams({
			client_id: this.oauth.clientId,
			redirect_uri: this.oauth.redirectUri,
			response_type: "code",
			scope: SCOPES,
			state,
			actor: "app",
		});
		return `${AUTHORIZE_URL}?${params}`;
	}

	/** Exchange an authorization code, persist the tokens and connect. */
	async completeOAuth(code: string): Promise<LinearTokens> {
		const data = await this.tokenRequest({
			grant_type: "authorization_code",
			code,
			redirect_uri: this.oauth.redirectUri,
		});
		if (!data.refresh_token) {
			throw new Error("Linear did not return a refresh token — enable refresh tokens on the OAuth application");
		}
		const client = new LinearClient({ accessToken: data.access_token });
		const org = await client.organization;
		const tokens: LinearTokens = {
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			workspaceName: org.name,
			connectedAt: new Date().toISOString(),
		};
		writeTokens(this.tokensFile, tokens);
		this.connect(tokens);
		return tokens;
	}

	private async tokenRequest(
		params: Record<string, string>,
	): Promise<{ access_token: string; refresh_token?: string }> {
		const res = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				...params,
				client_id: this.oauth.clientId,
				client_secret: this.oauth.clientSecret,
			}),
		});
		if (!res.ok) throw new Error(`Linear token request failed: ${res.status} ${await res.text()}`);
		return (await res.json()) as { access_token: string; refresh_token?: string };
	}

	// -------------------------------------------------------------------------
	// Webhook handling
	// -------------------------------------------------------------------------

	registerWebhookRoute(app: FastifyInstance, onEvent: (e: WebhookEvent) => void): void {
		// Scoped plugin: the raw-body parser applies ONLY to the webhook route.
		// Linear signs the exact bytes it sent, so this route needs the untouched
		// buffer — but every other route (the flow editor API) wants parsed JSON.
		void app.register(async (scoped) => {
			scoped.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
				done(null, body);
			});

			scoped.post("/linear-webhook", async (request, reply) => {
				const signature = request.headers["linear-signature"];
				const raw = request.body as Buffer;
				if (typeof signature !== "string" || !Buffer.isBuffer(raw)) {
					return reply.code(401).send({ error: "missing signature or body" });
				}

				let payload: Record<string, unknown>;
				try {
					payload = JSON.parse(raw.toString("utf8"));
					if (!this.webhooks.verify(raw, signature, payload.webhookTimestamp as number)) {
						return reply.code(401).send({ error: "invalid signature" });
					}
				} catch {
					return reply.code(401).send({ error: "verification failed" });
				}

				// Ack immediately; processing happens async so Linear never times out.
				reply.code(200).send({ ok: true });

				if (payload.type === "AgentSessionEvent") {
					if (!this.connected) {
						app.log.warn("agent session event ignored — Linear is not connected (open /setup)");
						return;
					}
					const event = normalizeAgentSessionEvent(payload);
					if (event) onEvent(event);
				}
			});
		});
	}

	async fetchIssue(issueId: string): Promise<IssueInfo> {
		return this.withAuthRetry(async () => {
			const issue = await this.requireClient().issue(issueId);
			const labels = await issue.labels();
			return {
				id: issue.id,
				identifier: issue.identifier,
				title: issue.title,
				description: issue.description ?? "",
				url: issue.url,
				labels: labels.nodes.map((l) => l.name),
				branchNameSuggestion: issue.branchName,
			};
		});
	}

	async postActivity(
		agentSessionId: string,
		content:
			| { type: "thought"; body: string }
			| { type: "action"; action: string; parameter: string; result?: string }
			| { type: "response"; body: string }
			| { type: "elicitation"; body: string }
			| { type: "error"; body: string },
		ephemeral = false,
	): Promise<void> {
		await this.withAuthRetry(() => this.requireClient().createAgentActivity({ agentSessionId, content, ephemeral }));
	}

	private async withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (err) {
			if (!isAuthError(err)) throw err;
			await this.refreshToken();
			return fn();
		}
	}

	private async refreshToken(): Promise<void> {
		this.refreshing ??= this.doRefresh().finally(() => {
			this.refreshing = null;
		});
		return this.refreshing;
	}

	private async doRefresh(): Promise<void> {
		if (!this.tokens) throw new Error("Linear is not connected");
		const data = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: this.tokens.refreshToken });
		const tokens: LinearTokens = {
			...this.tokens,
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? this.tokens.refreshToken,
		};
		writeTokens(this.tokensFile, tokens);
		this.connect(tokens);
	}
}

function isAuthError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /401|unauthorized|authentication/i.test(msg);
}

function normalizeAgentSessionEvent(payload: Record<string, unknown>): WebhookEvent | null {
	const action = payload.action as string;
	if (action !== "created" && action !== "prompted") return null;

	const session = payload.agentSession as Record<string, unknown> | undefined;
	if (!session?.id) return null;

	const activity = payload.agentActivity as { content?: { type?: string; body?: string }; signal?: string } | undefined;

	const rawIssue = session.issue as Record<string, unknown> | undefined;
	const issue: IssueInfo | undefined = rawIssue
		? {
				id: rawIssue.id as string,
				identifier: rawIssue.identifier as string,
				title: (rawIssue.title as string) ?? "",
				description: (rawIssue.description as string) ?? "",
				url: (rawIssue.url as string) ?? "",
				labels: [], // filled by a fetchIssue call — webhook payload has no label names
			}
		: undefined;

	const guidanceRules = payload.guidance as Array<{ body?: string }> | undefined;

	return {
		action,
		agentSessionId: session.id as string,
		organizationId: payload.organizationId as string,
		issue,
		promptContext: payload.promptContext as string | undefined,
		guidance:
			guidanceRules
				?.map((g) => g.body)
				.filter(Boolean)
				.join("\n") || undefined,
		promptBody: activity?.content?.body,
		stopSignal: activity?.signal === "stop",
	};
}
