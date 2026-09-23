import { useEffect, useMemo, useRef, useState } from "react";
import { SearchIcon } from "./icons";
import type { FlowNodeDef, SkillInfo, SkillSource } from "./types";

// Aliases resolve via the bundled Agent SDK; fable postdates it, so its full
// model ID is passed through to the API instead.
const MODELS: Array<{ value: string; label: string }> = [
	{ value: "", label: "(default)" },
	{ value: "claude-fable-5", label: "fable" },
	{ value: "opus", label: "opus" },
	{ value: "sonnet", label: "sonnet" },
	{ value: "haiku", label: "haiku" },
];

const TIERS: Array<{ source: SkillSource; label: string }> = [
	{ source: "project", label: "Project (.claude/skills)" },
	{ source: "global", label: "Global (~/.claude/skills)" },
	{ source: "plugin", label: "Plugins (Claude Code)" },
];

function SkillPicker(props: { value?: string; skills: SkillInfo[]; onChange: (name: string) => void }) {
	const { value, skills, onChange } = props;
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLUListElement>(null);

	const q = query.trim().toLowerCase();
	const matches = useMemo(
		() =>
			q ? skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) : skills,
		[skills, q],
	);
	const groups = TIERS.map((t) => ({ ...t, skills: matches.filter((s) => s.source === t.source) })).filter(
		(g) => g.skills.length > 0,
	);
	const flat = groups.flatMap((g) => g.skills);

	const openPicker = () => {
		const all = TIERS.flatMap((t) => skills.filter((s) => s.source === t.source));
		setQuery("");
		setActive(
			Math.max(
				0,
				all.findIndex((s) => s.name === value),
			),
		);
		setOpen(true);
	};

	const pick = (name: string) => {
		onChange(name);
		setOpen(false);
	};

	useEffect(() => setActive(0), [q]);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
		};
		window.addEventListener("mousedown", onDown);
		return () => window.removeEventListener("mousedown", onDown);
	}, [open]);

	useEffect(() => {
		listRef.current?.querySelector(".combo-option.active")?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const onKey = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((a) => Math.min(a + 1, flat.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((a) => Math.max(a - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (flat[active]) pick(flat[active].name);
		} else if (e.key === "Escape") {
			setOpen(false);
		}
	};

	return (
		<div className="combo" ref={rootRef}>
			<button
				type="button"
				className={`combo-trigger${value ? "" : " placeholder"}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => (open ? setOpen(false) : openPicker())}
			>
				<code>{value || "Pick a skill…"}</code>
				<svg
					width="10"
					height="10"
					viewBox="0 0 10 10"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.4"
					strokeLinecap="round"
					aria-hidden="true"
				>
					<path d="m2 3.5 3 3 3-3" />
				</svg>
			</button>
			{open && (
				<div className="combo-pop">
					<div className="search">
						<SearchIcon />
						<input
							// biome-ignore lint/a11y/noAutofocus: the popover exists to be typed in
							autoFocus
							value={query}
							placeholder="Search skills"
							aria-label="Search skills"
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={onKey}
						/>
					</div>
					<ul className="combo-list" ref={listRef} role="listbox">
						{groups.map((g) => (
							<li key={g.source}>
								<div className="combo-group">{g.label}</div>
								<ul>
									{g.skills.map((s) => {
										const i = flat.indexOf(s);
										return (
											<li key={s.name}>
												<button
													type="button"
													role="option"
													aria-selected={s.name === value}
													className={`combo-option${i === active ? " active" : ""}${s.name === value ? " current" : ""}`}
													title={s.description}
													onMouseEnter={() => setActive(i)}
													onClick={() => pick(s.name)}
												>
													<code>{s.name}</code>
													{s.shadows && <span className="badge badge-shadowed">overrides {s.shadows}</span>}
												</button>
											</li>
										);
									})}
								</ul>
							</li>
						))}
						{flat.length === 0 && <li className="combo-empty hint">No skills match “{query.trim()}”.</li>}
					</ul>
				</div>
			)}
		</div>
	);
}

export function NodeInspector(props: {
	def: FlowNodeDef;
	skills: SkillInfo[];
	onChange: (def: FlowNodeDef) => void;
	onDelete: () => void;
	onClose: () => void;
}) {
	const { def, skills, onChange } = props;
	const set = (patch: Partial<FlowNodeDef>) => onChange({ ...def, ...patch });
	const selectedSkill = skills.find((s) => s.name === def.skill);

	return (
		<div className="inspector">
			<header className={`sig-${def.type}`}>
				<span className="chip">{def.type}</span>
				<code>{def.id}</code>
				<button type="button" className="close" title="Close" onClick={props.onClose}>
					✕
				</button>
			</header>

			{def.type === "worktree" && (
				<>
					<Field label="branch (blank = from directives)">
						<input
							value={def.branch ?? ""}
							onChange={(e) => set({ branch: e.target.value || undefined })}
							placeholder="agent/{identifier}"
						/>
					</Field>
					<Field label="directory">
						<input
							value={def.dir ?? ""}
							onChange={(e) => set({ dir: e.target.value || undefined })}
							placeholder="{identifier}"
						/>
					</Field>
				</>
			)}

			{def.type === "agent" && (
				<>
					<Field label="skill">
						<SkillPicker value={def.skill} skills={skills} onChange={(name) => set({ skill: name })} />
					</Field>
					{selectedSkill?.description && <p className="hint">{selectedSkill.description}</p>}
					{def.skill && !selectedSkill && <p className="warn">Skill “{def.skill}” not found for this repo.</p>}

					<Field label="session">
						<select
							value={def.session ?? "fresh"}
							onChange={(e) => set({ session: e.target.value === "continue" ? "continue" : undefined })}
						>
							<option value="fresh">fresh — clean context (reviews)</option>
							<option value="continue">continue — keep previous step's context</option>
						</select>
					</Field>
					<Field label="model">
						<select value={def.model ?? ""} onChange={(e) => set({ model: e.target.value || undefined })}>
							{MODELS.map((m) => (
								<option key={m.value} value={m.value}>
									{m.label}
								</option>
							))}
						</select>
					</Field>
					<Field label="git policy">
						<label className="check">
							<input
								type="checkbox"
								checked={def.git?.commit !== false}
								onChange={(e) => set({ git: { ...def.git, commit: e.target.checked } })}
							/>
							allow commit
						</label>
						<label className="check">
							<input
								type="checkbox"
								checked={def.git?.push === true}
								onChange={(e) => set({ git: { ...def.git, push: e.target.checked } })}
							/>
							allow push (rarely)
						</label>
					</Field>
					<Field label="max turns">
						<input
							type="number"
							value={def.maxTurns ?? ""}
							onChange={(e) => set({ maxTurns: e.target.value ? Number(e.target.value) : undefined })}
							placeholder="80"
						/>
					</Field>
					<details className="disclosure">
						<summary>tools: {def.tools?.length ? `${def.tools.length} allowed` : "all"} ›</summary>
						<textarea
							rows={5}
							value={(def.tools ?? []).join("\n")}
							aria-label="Allowed tools, one per line, blank = all"
							onChange={(e) =>
								set({
									tools: e.target.value.trim()
										? e.target.value
												.split("\n")
												.map((t) => t.trim())
												.filter(Boolean)
										: undefined,
								})
							}
							placeholder={"Read\nEdit\nBash(pnpm *)"}
						/>
					</details>
					<details className="disclosure">
						<summary>extra prompt: {def.extraPrompt ? "set" : "—"} ›</summary>
						<textarea
							rows={3}
							value={def.extraPrompt ?? ""}
							aria-label="Extra prompt"
							onChange={(e) => set({ extraPrompt: e.target.value || undefined })}
						/>
					</details>
				</>
			)}

			{def.type === "commit" && (
				<Field label="message template">
					<input
						value={def.message ?? ""}
						onChange={(e) => set({ message: e.target.value || undefined })}
						placeholder="{identifier}: {title}"
					/>
				</Field>
			)}

			{def.type === "openPR" && (
				<>
					<Field label="title">
						<input
							value={def.title ?? ""}
							onChange={(e) => set({ title: e.target.value || undefined })}
							placeholder="{identifier}: {title}"
						/>
					</Field>
					<Field label="body">
						<textarea rows={3} value={def.body ?? ""} onChange={(e) => set({ body: e.target.value || undefined })} />
					</Field>
					<label className="check">
						<input
							type="checkbox"
							checked={def.draft === true}
							onChange={(e) => set({ draft: e.target.checked || undefined })}
						/>
						draft PR
					</label>
				</>
			)}

			{def.type === "say" && (
				<>
					<Field label="message">
						<textarea
							rows={3}
							value={def.message ?? ""}
							onChange={(e) => set({ message: e.target.value || undefined })}
							placeholder="Starting work on {identifier}…"
						/>
					</Field>
					<p className="hint">
						Posted as a <em>thought</em> on the Linear timeline — the session keeps running. Use <code>respond</code>{" "}
						for the final message.
					</p>
				</>
			)}

			{def.type === "respond" && (
				<Field label="template">
					<textarea
						rows={4}
						value={def.template ?? ""}
						onChange={(e) => set({ template: e.target.value || undefined })}
						placeholder="{lastText}"
					/>
				</Field>
			)}

			{def.type === "push" && (
				<p className="hint">Deterministic push of the worktree branch to origin. No configuration.</p>
			)}

			<button type="button" className="remove-link" onClick={props.onDelete}>
				remove step
			</button>
		</div>
	);
}

export function EdgeInspector(props: {
	condition: string;
	onChange: (condition: string) => void;
	onDelete: () => void;
	onClose: () => void;
}) {
	return (
		<div className="inspector">
			<header className="sig-edge">
				<span className="chip">edge</span>
				<button type="button" className="close" title="Close" onClick={props.onClose}>
					✕
				</button>
			</header>
			<Field label="condition (blank = always taken)">
				<input value={props.condition} onChange={(e) => props.onChange(e.target.value)} placeholder="push == true" />
			</Field>
			<p className="hint">
				<code>push</code> · <code>push == true</code> · <code>ticket != EXT-1</code> ·{" "}
				<code>results.review contains LGTM</code> · <code>lastText contains APPROVED</code>
				<br />
				Edges are tried top-down in creation order; unknown keys are false.
			</p>
			<button type="button" className="remove-link" onClick={props.onDelete}>
				remove edge
			</button>
		</div>
	);
}

function Field(props: { label: string; children: React.ReactNode }) {
	return (
		<label className="field">
			<span>{props.label}</span>
			{props.children}
		</label>
	);
}
