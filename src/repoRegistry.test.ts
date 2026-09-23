import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "./config.js";
import { detectBaseBranch, isGitRepo, RepoStore } from "./repoRegistry.js";

function makeGitRepo(base: string, name: string, branch = "main"): string {
	const path = join(base, name);
	mkdirSync(path, { recursive: true });
	execFileSync("git", ["init", "-b", branch], { cwd: path, stdio: "pipe" });
	return path;
}

const baseConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
	({ directives: {}, labels: {}, default: async () => {}, ...over }) as AgentConfig;

describe("RepoStore", () => {
	let projectRoot: string;
	let reposDir: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "agent-registry-"));
		mkdirSync(join(projectRoot, "runtime"), { recursive: true });
		reposDir = mkdtempSync(join(tmpdir(), "agent-clones-"));
	});
	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
		rmSync(reposDir, { recursive: true, force: true });
	});

	it("registers a git directory, detects the branch, and persists it", () => {
		const clone = makeGitRepo(reposDir, "my-app", "develop");
		const store = new RepoStore(baseConfig(), projectRoot);
		const added = store.add(clone);

		expect(added).toMatchObject({ name: "my-app", path: clone, baseBranch: "develop", source: "registry" });
		expect(store.get("my-app")?.path).toBe(clone);
		expect(store.defaultName()).toBe("my-app");

		const reloaded = new RepoStore(baseConfig(), projectRoot);
		expect(reloaded.get("my-app")?.baseBranch).toBe("develop");
		expect(existsSync(join(projectRoot, "runtime", "repos.json"))).toBe(true);
	});

	it("rejects non-existent paths and non-git directories", () => {
		const store = new RepoStore(baseConfig(), projectRoot);
		expect(() => store.add(join(reposDir, "nope"))).toThrow("does not exist");
		const plain = join(reposDir, "plain");
		mkdirSync(plain);
		expect(() => store.add(plain)).toThrow("Not a git repository");
	});

	it("merges config repos with registry repos, registry winning on collisions", () => {
		const configClone = makeGitRepo(reposDir, "from-config");
		const registryClone = makeGitRepo(reposDir, "shared-name");
		const config = baseConfig({
			repos: {
				"from-config": { path: configClone, baseBranch: "main" },
				"shared-name": { path: "/stale/path", baseBranch: "old" },
			},
			defaultRepo: "from-config",
		});
		const store = new RepoStore(config, projectRoot);
		store.add(registryClone, { name: "shared-name", baseBranch: "develop" });

		const shared = store.get("shared-name");
		expect(shared?.source).toBe("registry");
		expect(shared?.path).toBe(registryClone);
		expect(store.get("from-config")?.source).toBe("config");
		expect(store.defaultName()).toBe("from-config");
	});

	it("falls back to the first registered repo when config.defaultRepo is missing", () => {
		const clone = makeGitRepo(reposDir, "only-repo");
		const store = new RepoStore(baseConfig({ defaultRepo: "ghost" }), projectRoot);
		expect(store.defaultName()).toBeUndefined();
		store.add(clone);
		expect(store.defaultName()).toBe("only-repo");
	});

	it("rejects a duplicate name pointing at a different path, allows re-adding the same path", () => {
		const a = makeGitRepo(reposDir, "app-a");
		const b = makeGitRepo(reposDir, "app-b");
		const store = new RepoStore(baseConfig(), projectRoot);
		store.add(a, { name: "app" });
		expect(() => store.add(b, { name: "app" })).toThrow("already registered");
		store.add(a, { name: "app", baseBranch: "release" });
		expect(store.get("app")?.baseBranch).toBe("release");
		expect(JSON.parse(readFileSync(join(projectRoot, "runtime", "repos.json"), "utf8"))).toHaveLength(1);
	});

	it("routes issues to repos by routing label, case-insensitively", () => {
		const a = makeGitRepo(reposDir, "shop-app");
		const b = makeGitRepo(reposDir, "blog");
		const store = new RepoStore(baseConfig(), projectRoot);
		store.add(a, { routingLabel: "shop" });
		store.add(b, { routingLabel: "Blog" });

		expect(store.routeByLabels(["feature", "SHOP"])).toBe("shop-app");
		expect(store.routeByLabels(["blog"])).toBe("blog");
		expect(store.routeByLabels(["feature"])).toBeUndefined();
		expect(store.routeByLabels([])).toBeUndefined();
	});

	it("rejects a routing label already used by another repo", () => {
		const a = makeGitRepo(reposDir, "app-a");
		const b = makeGitRepo(reposDir, "app-b");
		const store = new RepoStore(baseConfig(), projectRoot);
		store.add(a, { routingLabel: "web" });
		expect(() => store.add(b, { routingLabel: "WEB" })).toThrow("already used");
		store.add(a, { routingLabel: "web" });
		expect(store.routeByLabels(["web"])).toBe("app-a");
	});

	it("removes registry entries but not config repos", () => {
		const clone = makeGitRepo(reposDir, "removable");
		const config = baseConfig({ repos: { fixed: { path: clone, baseBranch: "main" } } });
		const store = new RepoStore(config, projectRoot);
		store.add(clone, { name: "removable" });
		expect(store.remove("removable")).toBe(true);
		expect(store.get("removable")).toBeUndefined();
		expect(store.remove("fixed")).toBe(false);
		expect(store.get("fixed")).toBeDefined();
	});
});

describe("git helpers", () => {
	it("isGitRepo distinguishes repos from plain directories", () => {
		const base = mkdtempSync(join(tmpdir(), "agent-git-"));
		try {
			const repo = makeGitRepo(base, "repo");
			expect(isGitRepo(repo)).toBe(true);
			expect(isGitRepo(base)).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("detectBaseBranch falls back to the checked-out branch without origin/HEAD", () => {
		const base = mkdtempSync(join(tmpdir(), "agent-git-"));
		try {
			expect(detectBaseBranch(makeGitRepo(base, "repo", "develop"))).toBe("develop");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("RepoStore.update", () => {
	let projectRoot: string;
	let reposDir: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "agent-registry-"));
		mkdirSync(join(projectRoot, "runtime"), { recursive: true });
		reposDir = mkdtempSync(join(tmpdir(), "agent-clones-"));
	});
	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
		rmSync(reposDir, { recursive: true, force: true });
	});

	it("edits base branch, routing label, and name; null clears the label", () => {
		const clone = makeGitRepo(reposDir, "app", "main");
		const store = new RepoStore(baseConfig(), projectRoot);
		store.add(clone, { routingLabel: "old" });

		store.update("app", { baseBranch: "develop", routingLabel: "shop" });
		expect(store.get("app")).toMatchObject({ baseBranch: "develop", routingLabel: "shop" });

		store.update("app", { routingLabel: null, name: "shop-app" });
		expect(store.get("app")).toBeUndefined();
		expect(store.get("shop-app")?.routingLabel).toBeUndefined();

		expect(new RepoStore(baseConfig(), projectRoot).get("shop-app")?.baseBranch).toBe("develop");
	});

	it("default flag moves between entries and drives defaultName()", () => {
		const a = makeGitRepo(reposDir, "app-a");
		const b = makeGitRepo(reposDir, "app-b");
		const store = new RepoStore(baseConfig(), projectRoot);
		store.add(a);
		store.add(b);
		expect(store.defaultName()).toBe("app-a");

		store.update("app-b", { default: true });
		expect(store.defaultName()).toBe("app-b");
		store.update("app-a", { default: true });
		expect(store.defaultName()).toBe("app-a");
	});

	it("rejects edits to unknown or config-defined repos and clashing values", () => {
		const a = makeGitRepo(reposDir, "app-a");
		const b = makeGitRepo(reposDir, "app-b");
		const store = new RepoStore(baseConfig({ repos: { fixed: { path: a, baseBranch: "main" } } }), projectRoot);
		store.add(a, { name: "app-a", routingLabel: "aaa" });
		store.add(b, { name: "app-b" });

		expect(() => store.update("ghost", {})).toThrow("not a registered");
		expect(() => store.update("fixed", {})).toThrow("agent.config.ts");
		expect(() => store.update("app-b", { name: "app-a" })).toThrow("already registered");
		expect(() => store.update("app-b", { routingLabel: "AAA" })).toThrow("already used");
		expect(() => store.update("app-b", { baseBranch: "  " })).toThrow("empty");
	});
});

describe("remote setting", () => {
	let projectRoot: string;
	let reposDir: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "agent-registry-"));
		mkdirSync(join(projectRoot, "runtime"), { recursive: true });
		reposDir = mkdtempSync(join(tmpdir(), "agent-clones-"));
	});
	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
		rmSync(reposDir, { recursive: true, force: true });
	});

	const addRemote = (path: string, name: string) =>
		execFileSync("git", ["remote", "add", name, "https://example.com/x.git"], { cwd: path, stdio: "pipe" });

	it("accepts an existing remote on add and update, persists it", () => {
		const clone = makeGitRepo(reposDir, "app");
		addRemote(clone, "upstream");
		const store = new RepoStore(baseConfig(), projectRoot);

		store.add(clone, { remote: "upstream", baseBranch: "main" });
		expect(store.get("app")?.remote).toBe("upstream");
		expect(new RepoStore(baseConfig(), projectRoot).get("app")?.remote).toBe("upstream");

		store.update("app", { remote: "origin" });
		expect(store.get("app")?.remote).toBeUndefined();
	});

	it("rejects remotes the clone does not have, listing the available ones", () => {
		const clone = makeGitRepo(reposDir, "app");
		addRemote(clone, "upstream");
		const store = new RepoStore(baseConfig(), projectRoot);
		expect(() => store.add(clone, { remote: "ghost" })).toThrow(/available: upstream/);
		store.add(clone, { baseBranch: "main" });
		expect(() => store.update("app", { remote: "ghost" })).toThrow(/available: upstream/);
	});
});
