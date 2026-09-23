import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import type { RepoConfig } from "./config.js";
import { type FlowDefinition, flowPath, listFlows, loadFlow, validateFlow } from "./flow.js";
import { loadProjectConfig } from "./projectConfig.js";
import { isGitRepo, listRemotes, type RepoStore } from "./repoRegistry.js";
import { discoverSkills } from "./skills.js";

/** Labels double as filenames — keep them path-safe. */
const LABEL = /^[\w-]{1,64}$/;

export interface LinearStatus {
	connected: boolean;
	workspaceName?: string;
}

export function registerApi(app: FastifyInstance, repos: RepoStore, linearStatus: () => LinearStatus): void {
	app.get("/api/status", async () => ({ linear: linearStatus(), setupUrl: "/setup" }));

	const repoOr404 = (
		name: string,
		reply: { code(c: number): { send(b: unknown): unknown } },
	): RepoConfig | undefined => {
		const repo = repos.get(name);
		if (!repo) reply.code(404).send({ error: `Unknown repo "${name}"` });
		return repo;
	};

	app.get("/api/repos", async () =>
		repos.all().map((repo) => {
			let contract: { source: string; directives: string[]; hasCommitConvention: boolean } | { error: string } | null =
				null;
			try {
				const project = loadProjectConfig(repo.path);
				if (project) {
					contract = {
						source: project.source,
						directives: Object.keys(project.directives),
						hasCommitConvention: !!project.commit,
					};
				}
			} catch (err) {
				contract = { error: err instanceof Error ? err.message : String(err) };
			}
			return {
				name: repo.name,
				path: repo.path,
				baseBranch: repo.baseBranch,
				remote: repo.remote,
				routingLabel: repo.routingLabel,
				isDefault: repo.name === repos.defaultName(),
				source: repo.source,
				remotes: listRemotes(repo.path),
				contract,
			};
		}),
	);

	app.post<{ Body: { path: string; name?: string; baseBranch?: string; remote?: string; routingLabel?: string } }>(
		"/api/repos",
		async (request, reply) => {
			const { path, name, baseBranch, remote, routingLabel } = request.body ?? {};
			if (!path) return reply.code(400).send({ error: "path is required" });
			try {
				return repos.add(path, { name, baseBranch, remote, routingLabel });
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	);

	app.patch<{
		Params: { name: string };
		Body: {
			name?: string;
			baseBranch?: string;
			remote?: string | null;
			routingLabel?: string | null;
			default?: boolean;
		};
	}>("/api/repos/:name", async (request, reply) => {
		try {
			return repos.update(request.params.name, request.body ?? {});
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.delete<{ Params: { name: string } }>("/api/repos/:name", async (request, reply) => {
		if (!repos.remove(request.params.name)) {
			return reply.code(404).send({
				error: `"${request.params.name}" is not a registered repo (config-defined repos can't be removed here)`,
			});
		}
		return { removed: request.params.name };
	});

	// Native OS folder dialog. The server runs on the user's machine, so it can
	// pop Finder's chooser and hand back an absolute path — something browser
	// sandboxes can't do. Async execFile keeps the event loop (webhooks!) alive
	// while the dialog is open.
	app.post("/api/pick-directory", async () => {
		if (process.platform !== "darwin") return { unsupported: true };
		try {
			const { stdout } = await promisify(execFile)(
				"osascript",
				["-e", 'POSIX path of (choose folder with prompt "Select a project repository")'],
				{ timeout: 5 * 60 * 1000 },
			);
			return { path: stdout.trim() };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes("User canceled") || message.includes("-128")) return { canceled: true };
			return { unsupported: true, error: message.split("\n")[0] };
		}
	});

	// Directory listing for the in-page fallback picker. Directories only;
	// localhost-only server, so this is the user browsing their own machine.
	app.get<{ Querystring: { path?: string } }>("/api/browse", async (request, reply) => {
		const requested = request.query.path?.replace(/^~(?=\/|$)/, homedir()) || homedir();
		const path = resolve(requested);
		let entries: string[];
		try {
			entries = readdirSync(path);
		} catch (err) {
			return reply.code(400).send({ error: `Cannot read ${path}: ${err instanceof Error ? err.message : err}` });
		}
		const dirs = entries
			.filter((e) => !e.startsWith(".") || e === ".claude")
			.flatMap((e) => {
				const full = join(path, e);
				try {
					if (!statSync(full).isDirectory()) return [];
				} catch {
					return [];
				}
				return [{ name: e, path: full, isGitRepo: existsSync(join(full, ".git")) }];
			})
			.sort((a, b) => Number(b.isGitRepo) - Number(a.isGitRepo) || a.name.localeCompare(b.name));
		return { path, parent: dirname(path) !== path ? dirname(path) : null, isGitRepo: isGitRepo(path), dirs };
	});

	app.get<{ Params: { name: string } }>("/api/repos/:name/skills", async (request, reply) => {
		const repo = repoOr404(request.params.name, reply);
		if (!repo) return;
		return discoverSkills(repo);
	});

	app.get<{ Params: { name: string; skill: string } }>("/api/repos/:name/skills/:skill", async (request, reply) => {
		const repo = repoOr404(request.params.name, reply);
		if (!repo) return;
		const skill = discoverSkills(repo).find((s) => s.name === request.params.skill);
		if (!skill) return reply.code(404).send({ error: `Unknown skill "${request.params.skill}"` });
		try {
			return { ...skill, content: readFileSync(skill.path, "utf8") };
		} catch (err) {
			return reply.code(500).send({ error: `Cannot read ${skill.path}: ${err instanceof Error ? err.message : err}` });
		}
	});

	app.get<{ Params: { name: string } }>("/api/repos/:name/flows", async (request, reply) => {
		const repo = repoOr404(request.params.name, reply);
		if (!repo) return;
		return listFlows(repo);
	});

	app.get<{ Params: { name: string; label: string } }>("/api/repos/:name/flows/:label", async (request, reply) => {
		const repo = repoOr404(request.params.name, reply);
		if (!repo) return;
		const { label } = request.params;
		if (!LABEL.test(label)) return reply.code(400).send({ error: "Invalid label" });

		const file = flowPath(repo, label);
		if (!existsSync(file)) return reply.code(404).send({ error: `No flow for label "${label}"` });
		try {
			return { label, definition: loadFlow(file) };
		} catch (err) {
			return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.put<{ Params: { name: string; label: string }; Body: { definition: FlowDefinition } }>(
		"/api/repos/:name/flows/:label",
		async (request, reply) => {
			const repo = repoOr404(request.params.name, reply);
			if (!repo) return;
			const { label } = request.params;
			const { definition } = request.body ?? {};
			if (!LABEL.test(label)) return reply.code(400).send({ error: "Invalid label" });

			const errors = validateFlow(definition ?? ({} as FlowDefinition));
			if (errors.length > 0) return reply.code(400).send({ error: "Flow is invalid", details: errors });

			// Unknown skill references are warnings, not rejections — the skill may
			// be about to be added, and project skills differ per repo anyway.
			const skills = discoverSkills(repo);
			const warnings = definition.nodes
				.filter((n) => n.type === "agent" && !skills.some((s) => s.name === n.skill))
				.map((n) => `Node "${n.id}" references unknown skill "${n.type === "agent" ? n.skill : ""}"`);

			const file = flowPath(repo, label);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${JSON.stringify(definition, null, 2)}\n`);
			return { saved: file, warnings };
		},
	);

	app.delete<{ Params: { name: string; label: string } }>("/api/repos/:name/flows/:label", async (request, reply) => {
		const repo = repoOr404(request.params.name, reply);
		if (!repo) return;
		const { label } = request.params;
		if (!LABEL.test(label)) return reply.code(400).send({ error: "Invalid label" });
		const file = flowPath(repo, label);
		if (!existsSync(file)) return reply.code(404).send({ error: `No flow for label "${label}"` });
		unlinkSync(file);
		return { deleted: file };
	});
}
