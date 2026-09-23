import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentConfig, RepoConfig } from "./config.js";

export interface RegistryEntry {
	name: string;
	path: string;
	baseBranch: string;
	remote?: string;
	routingLabel?: string;
	default?: boolean;
	addedAt: string;
}

export interface RepoWithSource extends RepoConfig {
	name: string;
	source: "config" | "registry";
	routingLabel?: string;
}

export class RepoStore {
	private file: string;
	private entries: RegistryEntry[] = [];

	constructor(
		private config: AgentConfig,
		projectRoot: string,
	) {
		this.file = join(projectRoot, "runtime", "repos.json");
		if (existsSync(this.file)) {
			this.entries = JSON.parse(readFileSync(this.file, "utf8"));
		}
	}

	private persist(): void {
		writeFileSync(this.file, `${JSON.stringify(this.entries, null, 2)}\n`);
	}

	all(): RepoWithSource[] {
		const merged = new Map<string, RepoWithSource>();
		for (const [name, repo] of Object.entries(this.config.repos ?? {})) {
			merged.set(name, { ...repo, name, source: "config" });
		}
		for (const entry of this.entries) {
			merged.set(entry.name, {
				name: entry.name,
				path: entry.path,
				baseBranch: entry.baseBranch,
				remote: entry.remote,
				routingLabel: entry.routingLabel,
				source: "registry",
			});
		}
		return [...merged.values()];
	}

	routeByLabels(issueLabels: string[]): string | undefined {
		const lower = new Set(issueLabels.map((l) => l.toLowerCase()));
		return this.all().find((r) => r.routingLabel && lower.has(r.routingLabel.toLowerCase()))?.name;
	}

	get(name: string): RepoWithSource | undefined {
		return this.all().find((r) => r.name === name);
	}

	defaultName(): string | undefined {
		const configured = this.config.defaultRepo;
		if (configured && this.get(configured)) return configured;
		const flagged = this.entries.find((e) => e.default);
		if (flagged) return flagged.name;
		return this.all()[0]?.name;
	}

	update(
		name: string,
		patch: {
			name?: string;
			baseBranch?: string;
			remote?: string | null;
			routingLabel?: string | null;
			default?: boolean;
		},
	): RepoWithSource {
		const entry = this.entries.find((e) => e.name === name);
		if (!entry) {
			throw new Error(
				this.get(name)
					? `"${name}" is defined in agent.config.ts — edit it there`
					: `"${name}" is not a registered project`,
			);
		}

		if (patch.name !== undefined && patch.name.trim() !== entry.name) {
			const newName = patch.name.trim();
			if (!/^[\w.-]{1,64}$/.test(newName)) throw new Error(`Invalid repo name "${newName}"`);
			if (this.entries.some((e) => e !== entry && e.name === newName)) {
				throw new Error(`Name "${newName}" is already registered`);
			}
			entry.name = newName;
		}

		if (patch.baseBranch !== undefined) {
			const branch = patch.baseBranch.trim();
			if (!branch) throw new Error("Base branch cannot be empty");
			entry.baseBranch = branch;
		}

		if (patch.remote !== undefined) {
			const remote = patch.remote?.trim();
			if (!remote || remote === "origin") {
				entry.remote = undefined;
			} else {
				assertRemoteExists(entry.path, remote);
				entry.remote = remote;
			}
		}

		if (patch.routingLabel !== undefined) {
			const label = patch.routingLabel?.trim();
			if (!label) {
				entry.routingLabel = undefined;
			} else {
				if (!/^[\w -]{1,64}$/.test(label)) throw new Error(`Invalid routing label "${label}"`);
				const clash = this.entries.find((e) => e !== entry && e.routingLabel?.toLowerCase() === label.toLowerCase());
				if (clash) throw new Error(`Routing label "${label}" is already used by "${clash.name}"`);
				entry.routingLabel = label;
			}
		}

		if (patch.default !== undefined) {
			for (const e of this.entries) e.default = undefined;
			if (patch.default) entry.default = true;
		}

		this.persist();
		return {
			name: entry.name,
			path: entry.path,
			baseBranch: entry.baseBranch,
			remote: entry.remote,
			routingLabel: entry.routingLabel,
			source: "registry",
		};
	}

	add(
		path: string,
		opts: { name?: string; baseBranch?: string; remote?: string; routingLabel?: string } = {},
	): RepoWithSource {
		const abs = resolve(path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
		if (!existsSync(abs)) throw new Error(`Directory does not exist: ${abs}`);
		if (!isGitRepo(abs)) throw new Error(`Not a git repository: ${abs}`);

		const remote = opts.remote?.trim() || undefined;
		if (remote) assertRemoteExists(abs, remote);

		const name = opts.name?.trim() || basename(abs);
		if (!/^[\w.-]{1,64}$/.test(name)) throw new Error(`Invalid repo name "${name}"`);
		// Only registry entries can conflict — shadowing a config repo of the
		// same name is intentional (that's how a stale config path gets replaced).
		const existing = this.entries.find((e) => e.name === name);
		if (existing && existing.path !== abs) {
			throw new Error(
				`Name "${name}" is already registered for ${existing.path} — remove it first or pick another name`,
			);
		}

		const routingLabel = opts.routingLabel?.trim() || undefined;
		if (routingLabel) {
			if (!/^[\w -]{1,64}$/.test(routingLabel)) throw new Error(`Invalid routing label "${routingLabel}"`);
			const clash = this.entries.find(
				(e) => e.name !== name && e.routingLabel?.toLowerCase() === routingLabel.toLowerCase(),
			);
			if (clash) {
				throw new Error(`Routing label "${routingLabel}" is already used by "${clash.name}" — labels must be unique`);
			}
		}

		const baseBranch = opts.baseBranch?.trim() || detectBaseBranch(abs, remote ?? "origin");
		this.entries = this.entries.filter((e) => e.name !== name);
		this.entries.push({ name, path: abs, baseBranch, remote, routingLabel, addedAt: new Date().toISOString() });
		this.persist();
		return { name, path: abs, baseBranch, remote, routingLabel, source: "registry" };
	}

	remove(name: string): boolean {
		const before = this.entries.length;
		this.entries = this.entries.filter((e) => e.name !== name);
		if (this.entries.length === before) return false;
		this.persist();
		return true;
	}
}

export function isGitRepo(path: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--git-dir"], { cwd: path, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

export function listRemotes(path: string): string[] {
	try {
		return execFileSync("git", ["remote"], { cwd: path, stdio: "pipe" }).toString().trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function assertRemoteExists(path: string, remote: string): void {
	const remotes = listRemotes(path);
	if (!remotes.includes(remote)) {
		throw new Error(`Remote "${remote}" not found in ${path} — available: ${remotes.join(", ") || "(none)"}`);
	}
}

export function detectBaseBranch(path: string, remote = "origin"): string {
	try {
		const ref = execFileSync("git", ["symbolic-ref", `refs/remotes/${remote}/HEAD`], { cwd: path, stdio: "pipe" })
			.toString()
			.trim();
		const short = ref.replace(`refs/remotes/${remote}/`, "");
		if (short) return short;
	} catch {
		// no <remote>/HEAD ref locally — fall through
	}
	try {
		const branch = execFileSync("git", ["branch", "--show-current"], { cwd: path, stdio: "pipe" }).toString().trim();
		if (branch) return branch;
	} catch {
		// detached HEAD or similar
	}
	return "main";
}
