import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { LinearService } from "./linear.js";
import { registerSetup } from "./setup.js";

function fakeLinear(overrides: Partial<LinearService> = {}) {
	return {
		connected: false,
		workspaceName: undefined,
		authorizeUrl: (state: string) => `https://linear.app/oauth/authorize?state=${state}`,
		completeOAuth: vi.fn(async () => ({
			accessToken: "a",
			refreshToken: "r",
			workspaceName: "Acme",
			connectedAt: "now",
		})),
		...overrides,
	} as unknown as LinearService;
}

function build(linear: LinearService, env = { LINEAR_CLIENT_ID: true, LINEAR_CLIENT_SECRET: true }) {
	const app = Fastify();
	registerSetup(app, { linear, localUrl: "http://localhost:3456", env });
	return app;
}

describe("setup routes", () => {
	it("renders the checklist and a connect button when env is complete", async () => {
		const res = await build(fakeLinear()).inject({ method: "GET", url: "/setup" });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("Connect Linear workspace");
		expect(res.body).toContain("http://localhost:3456/oauth/callback");
	});

	it("hides the connect button while env variables are missing", async () => {
		const res = await build(fakeLinear(), { LINEAR_CLIENT_ID: true, LINEAR_CLIENT_SECRET: false }).inject({
			method: "GET",
			url: "/setup",
		});
		expect(res.body).not.toContain("Connect Linear workspace");
		expect(res.body).toContain("LINEAR_CLIENT_SECRET");
	});

	it("shows the connected workspace", async () => {
		const res = await build(fakeLinear({ connected: true, workspaceName: "Acme" } as never)).inject({
			method: "GET",
			url: "/setup",
		});
		expect(res.body).toContain("Acme");
		expect(res.body).toContain("Reconnect");
	});

	it("redirects to Linear with a state and accepts the matching callback", async () => {
		const linear = fakeLinear();
		const app = build(linear);
		const auth = await app.inject({ method: "GET", url: "/oauth/authorize" });
		expect(auth.statusCode).toBe(302);
		const state = new URL(auth.headers.location as string).searchParams.get("state");
		expect(state).toMatch(/^[0-9a-f]{32}$/);

		const cb = await app.inject({ method: "GET", url: `/oauth/callback?code=abc&state=${state}` });
		expect(cb.statusCode).toBe(302);
		expect(cb.headers.location).toBe("/setup?connected=1");
		expect(linear.completeOAuth).toHaveBeenCalledWith("abc");
	});

	it("rejects a callback whose state was never issued", async () => {
		const linear = fakeLinear();
		const cb = await build(linear).inject({ method: "GET", url: "/oauth/callback?code=abc&state=forged" });
		expect(cb.headers.location).toBe("/setup?error=invalid_state");
		expect(linear.completeOAuth).not.toHaveBeenCalled();
	});

	it("surfaces a Linear-side error without exchanging a code", async () => {
		const linear = fakeLinear();
		const cb = await build(linear).inject({ method: "GET", url: "/oauth/callback?error=access_denied" });
		expect(cb.headers.location).toBe("/setup?error=access_denied");
		expect(linear.completeOAuth).not.toHaveBeenCalled();
	});
});
