import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LinearTokens, readTokens, writeTokens } from "./tokens.js";

const sample: LinearTokens = {
	accessToken: "access",
	refreshToken: "refresh",
	workspaceName: "Acme",
	connectedAt: "2026-01-01T00:00:00.000Z",
};

describe("token store", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "taskanvil-tokens-"));
		file = join(dir, "runtime", "tokens.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("returns undefined when no file exists", () => {
		expect(readTokens(file)).toBeUndefined();
	});

	it("round-trips tokens and creates the parent directory", () => {
		writeTokens(file, sample);
		expect(readTokens(file)).toEqual(sample);
	});

	it("writes the file readable by the owner only", () => {
		writeTokens(file, sample);
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("migrates the legacy multi-workspace shape", () => {
		writeTokens(file, sample); // creates the directory
		writeFileSync(
			file,
			JSON.stringify({ workspaces: { ws1: { accessToken: "a", refreshToken: "r", name: "Legacy" } } }),
		);
		expect(readTokens(file)).toMatchObject({ accessToken: "a", refreshToken: "r", workspaceName: "Legacy" });
	});

	it("rejects a malformed file with a hint", () => {
		writeTokens(file, sample);
		writeFileSync(file, JSON.stringify({ accessToken: "only" }));
		expect(() => readTokens(file)).toThrow(/reconnect via \/setup/);
		expect(readFileSync(file, "utf8")).toContain("only"); // never silently rewritten
	});
});
