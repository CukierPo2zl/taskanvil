/**
 * Linear OAuth token store — runtime/tokens.json.
 *
 * These are mutable state, not configuration: the access token expires and
 * every refresh rotates both tokens, so they live in a file the agent owns
 * rather than in .env. The agent handles exactly one Linear workspace.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LinearTokens {
	accessToken: string;
	refreshToken: string;
	/** Display name of the connected workspace, shown on the setup page. */
	workspaceName: string;
	/** ISO timestamp of the OAuth handshake that produced these tokens. */
	connectedAt: string;
}

export function readTokens(file: string): LinearTokens | undefined {
	if (!existsSync(file)) return undefined;
	const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	const tokens = migrate(raw);
	if (!tokens.accessToken || !tokens.refreshToken) {
		throw new Error(`${file} is malformed — delete it and reconnect via /setup`);
	}
	return tokens;
}

export function writeTokens(file: string, tokens: LinearTokens): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
}

/** Accept the pre-0.1 multi-workspace shape by taking its first entry. */
function migrate(raw: Record<string, unknown>): LinearTokens {
	const workspaces = raw.workspaces as
		| Record<string, { accessToken: string; refreshToken: string; name?: string }>
		| undefined;
	if (workspaces) {
		const first = Object.values(workspaces)[0];
		return {
			accessToken: first?.accessToken ?? "",
			refreshToken: first?.refreshToken ?? "",
			workspaceName: first?.name ?? "Linear",
			connectedAt: new Date(0).toISOString(),
		};
	}
	return raw as unknown as LinearTokens;
}
