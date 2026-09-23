import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { RepoConfig } from "./config.js";

export type SkillSource = "project" | "global" | "plugin";

export interface SkillInfo {
	name: string;
	description: string;
	source: SkillSource;
	path: string;
	shadows?: SkillSource;
}

export interface DiscoverOptions {
	globalSkillsDir?: string;
	pluginsManifest?: string;
}

export function discoverSkills(repo: RepoConfig, opts: DiscoverOptions = {}): SkillInfo[] {
	const tiers: Array<{ dir: string; source: SkillSource }> = [
		{ dir: opts.globalSkillsDir ?? join(homedir(), ".claude", "skills"), source: "global" },
		{ dir: join(repo.path, ".claude", "skills"), source: "project" },
	];

	const merged = new Map<string, SkillInfo>();
	for (const skill of scanPlugins(
		opts.pluginsManifest ?? join(homedir(), ".claude", "plugins", "installed_plugins.json"),
	)) {
		merged.set(skill.name, skill); // namespaced "plugin:skill" — no collisions with tiers
	}
	for (const tier of tiers) {
		for (const skill of scanSkillDir(tier.dir, tier.source)) {
			const hidden = merged.get(skill.name);
			merged.set(skill.name, { ...skill, shadows: hidden?.source });
		}
	}
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkill(repo: RepoConfig, name: string, opts: DiscoverOptions = {}): SkillInfo {
	const skills = discoverSkills(repo, opts);
	const skill = skills.find((s) => s.name === name);
	if (!skill) {
		throw new Error(
			`Unknown skill "${name}" for project at ${repo.path}. ` +
				`Add ${join(repo.path, ".claude", "skills", name, "SKILL.md")} or pick one of: ${skills.map((s) => s.name).join(", ") || "(none)"}`,
		);
	}
	return skill;
}

/**
 * Skills and commands from installed Claude Code plugins — the same manifest
 * the CLI's "/" menu reads (~/.claude/plugins/installed_plugins.json, v2).
 * Names are namespaced "plugin:skill", matching Claude Code's own convention,
 * so they never collide with the directory tiers. Built-in CLI skills
 * (/review, /init, …) are compiled into the claude binary and cannot be
 * discovered from disk — plugins are the scannable part of the "/" menu.
 */
function scanPlugins(manifestFile: string): SkillInfo[] {
	if (!existsSync(manifestFile)) return [];
	let manifest: { plugins?: Record<string, Array<{ installPath?: string }>> };
	try {
		manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
	} catch {
		return []; // a broken plugins manifest shouldn't take the skill list down
	}

	const skills: SkillInfo[] = [];
	for (const [key, installs] of Object.entries(manifest.plugins ?? {})) {
		const pluginName = key.split("@")[0] ?? key;
		const installPath = installs?.[0]?.installPath;
		if (!installPath || !existsSync(installPath)) continue;

		for (const skill of scanSkillDir(join(installPath, "skills"), "plugin")) {
			skills.push({ ...skill, name: `${pluginName}:${skill.name}` });
		}
		// Slash commands are prompt markdown too — usable as skills by this engine.
		for (const command of scanSkillDir(join(installPath, "commands"), "plugin")) {
			skills.push({ ...command, name: `${pluginName}:${command.name}` });
		}
	}
	return skills;
}

function scanSkillDir(dir: string, source: SkillInfo["source"]): SkillInfo[] {
	if (!existsSync(dir)) return [];
	const skills: SkillInfo[] = [];

	for (const entry of readdirSync(dir)) {
		const entryPath = join(dir, entry);
		let file: string | undefined;
		if (statSync(entryPath).isDirectory()) {
			const skillMd = join(entryPath, "SKILL.md");
			if (existsSync(skillMd)) file = skillMd;
		} else if (entry.endsWith(".md")) {
			file = entryPath;
		}
		if (!file) continue;

		const raw = readFileSync(file, "utf8");
		const { attrs, body } = parseFrontmatter(raw);
		const fallbackName = statSync(entryPath).isDirectory() ? entry : basename(entry, ".md");
		skills.push({
			name: attrs.name ?? fallbackName,
			description: attrs.description ?? firstProseLine(body),
			source,
			path: file,
		});
	}
	return skills;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(raw: string): { attrs: Record<string, string>; body: string } {
	const match = raw.match(FRONTMATTER);
	if (!match) return { attrs: {}, body: raw };

	const attrs: Record<string, string> = {};
	for (const line of (match[1] ?? "").split(/\r?\n/)) {
		const sep = line.indexOf(":");
		if (sep > 0) attrs[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
	}
	return { attrs, body: raw.slice(match[0].length) };
}

export function stripFrontmatter(raw: string): string {
	return parseFrontmatter(raw).body;
}

function firstProseLine(body: string): string {
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (trimmed && !trimmed.startsWith("#")) return trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed;
	}
	return "";
}
