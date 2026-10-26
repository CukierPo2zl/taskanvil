import { useMemo, useState } from "react";
import { SearchIcon } from "./icons";
import type { SkillInfo } from "./types";

export function sourceLabel(source: SkillInfo["source"]): string {
	return source === "global" ? "~/.claude" : source;
}

export function SkillsPage(props: { repo: string; skills: SkillInfo[]; onOpen: (name: string) => void }) {
	const [query, setQuery] = useState("");
	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return props.skills;
		return props.skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
	}, [props.skills, query]);

	return (
		<div className="page">
			<div className="page-head">
				<h1>Skills</h1>
				<p>
					Skills an agent step can run in <code>{props.repo}</code> — from the project's <code>.claude/skills</code>,
					your <code>~/.claude/skills</code>, and installed Claude Code plugins.
				</p>
			</div>

			<div className="page-toolbar">
				<div className="search search-lg">
					<SearchIcon size={14} />
					<input
						value={query}
						placeholder="Search skills…"
						aria-label="Search skills"
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => e.key === "Escape" && setQuery("")}
					/>
				</div>
				<span className="page-count">
					{query.trim() ? `${visible.length} of ${props.skills.length}` : props.skills.length} skills
				</span>
			</div>

			<div className="table">
				{visible.map((s) => (
					<button
						type="button"
						key={`${s.source}:${s.name}`}
						className="table-row"
						title="View SKILL.md"
						onClick={() => props.onOpen(s.name)}
					>
						<code className="table-name">{s.name}</code>
						<span className="table-desc">
							{s.description}
							{s.shadows && <span className="badge badge-amber">overrides {s.shadows}</span>}
						</span>
						<span className={`badge badge-src-${s.source}`}>{sourceLabel(s.source)}</span>
					</button>
				))}
				{visible.length === 0 && (
					<div className="table-empty">
						{props.skills.length === 0 ? "No skills found for this project." : `No skills match “${query.trim()}”.`}
					</div>
				)}
			</div>
		</div>
	);
}
