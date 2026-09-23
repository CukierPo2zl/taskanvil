import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoConfig } from "./config.js";
import { discoverSkills, findSkill, parseFrontmatter, stripFrontmatter } from "./skills.js";

describe("parseFrontmatter", () => {
	it("extracts attrs and strips them from the body", () => {
		const raw = "---\nname: commit\ndescription: How to commit\n---\n# Commit\nbody";
		const { attrs, body } = parseFrontmatter(raw);
		expect(attrs).toEqual({ name: "commit", description: "How to commit" });
		expect(body).toBe("# Commit\nbody");
	});

	it("passes through files without frontmatter", () => {
		const raw = "# Plain\nno frontmatter here";
		expect(parseFrontmatter(raw)).toEqual({ attrs: {}, body: raw });
		expect(stripFrontmatter(raw)).toBe(raw);
	});

	it("keeps colons inside values", () => {
		const { attrs } = parseFrontmatter("---\ndescription: use when: always\n---\nx");
		expect(attrs.description).toBe("use when: always");
	});
});

describe("discoverSkills", () => {
	let repoPath: string;
	let homeDir: string;
	let globalDir: string;
	let pluginsManifest: string;
	const repo = (): RepoConfig => ({ path: repoPath, baseBranch: "main" });
	const discover = () => discoverSkills(repo(), { globalSkillsDir: globalDir, pluginsManifest });
	const projectSkills = () => join(repoPath, ".claude", "skills");

	beforeEach(() => {
		repoPath = mkdtempSync(join(tmpdir(), "agent-repo-"));
		homeDir = mkdtempSync(join(tmpdir(), "agent-home-"));
		globalDir = join(homeDir, "skills");
		pluginsManifest = join(homeDir, "installed_plugins.json");
	});
	afterEach(() => {
		rmSync(repoPath, { recursive: true, force: true });
		rmSync(homeDir, { recursive: true, force: true });
	});

	const writeSkill = (base: string, name: string, frontmatter = true) => {
		const dir = join(base, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			frontmatter
				? `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\nInstructions.`
				: `# ${name}\nInstructions.`,
		);
	};

	it("finds project dir-format skills", () => {
		writeSkill(projectSkills(), "implement");
		const skills = discover();
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({ name: "implement", description: "implement skill", source: "project" });
	});

	it("accepts bare .md files and derives name/description without frontmatter", () => {
		mkdirSync(projectSkills(), { recursive: true });
		writeFileSync(join(projectSkills(), "commit.md"), "# Commit\nStage related changes only.");
		const [skill] = discover();
		expect(skill?.name).toBe("commit");
		expect(skill?.description).toBe("Stage related changes only.");
	});

	it("merges project and global tiers with distinct sources", () => {
		writeSkill(globalDir, "google");
		writeSkill(projectSkills(), "deploy");
		const skills = discover();
		expect(skills.map((s) => `${s.name}:${s.source}`)).toEqual(["deploy:project", "google:global"]);
	});

	it("project skills shadow global ones, recording what they hid", () => {
		writeSkill(globalDir, "commit");
		writeSkill(projectSkills(), "commit");
		const skills = discover();
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({ source: "project", shadows: "global" });
		expect(skills[0]?.path).toContain(repoPath);
	});

	it("returns empty when no tier has a skills dir", () => {
		expect(discover()).toEqual([]);
	});

	it("findSkill resolves by name and names the project's skills dir on a miss", () => {
		writeSkill(projectSkills(), "implement");
		expect(findSkill(repo(), "implement", { globalSkillsDir: globalDir, pluginsManifest }).path).toContain(repoPath);
		expect(() => findSkill(repo(), "debug", { globalSkillsDir: globalDir, pluginsManifest })).toThrow(
			/Unknown skill "debug".*\.claude\/skills\/debug\/SKILL\.md.*implement/,
		);
	});

	it("discovers installed plugin skills and commands, namespaced plugin:name", () => {
		const pluginPath = join(homeDir, "plugins", "cache", "mkt", "review-kit", "1.0.0");
		writeSkill(join(pluginPath, "skills"), "code-review");
		mkdirSync(join(pluginPath, "commands"), { recursive: true });
		writeFileSync(
			join(pluginPath, "commands", "commit.md"),
			"---\ndescription: Create a git commit\n---\nCommit steps.",
		);
		writeFileSync(
			pluginsManifest,
			JSON.stringify({ version: 2, plugins: { "review-kit@mkt": [{ installPath: pluginPath }] } }),
		);

		const skills = discover();
		expect(skills.map((s) => `${s.name}:${s.source}`)).toEqual([
			"review-kit:code-review:plugin",
			"review-kit:commit:plugin",
		]);
		expect(skills[1]?.description).toBe("Create a git commit");
	});

	it("skips missing install paths and survives a broken manifest", () => {
		writeFileSync(
			pluginsManifest,
			JSON.stringify({ version: 2, plugins: { "ghost@mkt": [{ installPath: join(homeDir, "nope") }] } }),
		);
		expect(discover()).toEqual([]);
		writeFileSync(pluginsManifest, "{ not json");
		expect(discover()).toEqual([]);
	});
});
