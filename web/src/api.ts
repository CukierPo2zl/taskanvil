import type { AgentStatus, BrowseResult, FlowDefinition, FlowListing, RepoInfo, SkillInfo } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string; details?: string[] };
		const detail = body.details?.length ? `: ${body.details.join("; ")}` : "";
		throw new Error(`${body.error ?? response.statusText}${detail}`);
	}
	return response.json() as Promise<T>;
}

export const api = {
	status: () => request<AgentStatus>("/api/status"),
	repos: () => request<RepoInfo[]>("/api/repos"),
	addRepo: (path: string, opts: { name?: string; baseBranch?: string; remote?: string; routingLabel?: string } = {}) =>
		request<{ name: string }>("/api/repos", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path, ...opts }),
		}),
	updateRepo: (
		name: string,
		patch: {
			name?: string;
			baseBranch?: string;
			remote?: string | null;
			routingLabel?: string | null;
			default?: boolean;
		},
	) =>
		request<{ name: string }>(`/api/repos/${encodeURIComponent(name)}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(patch),
		}),
	removeRepo: (name: string) =>
		request<{ removed: string }>(`/api/repos/${encodeURIComponent(name)}`, { method: "DELETE" }),
	browse: (path?: string) => request<BrowseResult>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
	pickDirectory: () =>
		request<{ path?: string; canceled?: boolean; unsupported?: boolean }>("/api/pick-directory", { method: "POST" }),
	skills: (repo: string) => request<SkillInfo[]>(`/api/repos/${encodeURIComponent(repo)}/skills`),
	skillContent: (repo: string, skill: string) =>
		request<SkillInfo & { content: string }>(
			`/api/repos/${encodeURIComponent(repo)}/skills/${encodeURIComponent(skill)}`,
		),
	flows: (repo: string) => request<FlowListing[]>(`/api/repos/${encodeURIComponent(repo)}/flows`),
	flow: (repo: string, label: string) =>
		request<{ label: string; definition: FlowDefinition }>(
			`/api/repos/${encodeURIComponent(repo)}/flows/${encodeURIComponent(label)}`,
		),
	saveFlow: (repo: string, label: string, definition: FlowDefinition) =>
		request<{ saved: string; warnings: string[] }>(
			`/api/repos/${encodeURIComponent(repo)}/flows/${encodeURIComponent(label)}`,
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ definition }),
			},
		),
	deleteFlow: (repo: string, label: string) =>
		request<{ deleted: string }>(`/api/repos/${encodeURIComponent(repo)}/flows/${encodeURIComponent(label)}`, {
			method: "DELETE",
		}),
};
