import { useState } from "react";
import { api } from "./api";
import type { RepoInfo } from "./types";

export function ProjectSettings(props: {
	repo: RepoInfo;
	onSaved: (newName: string) => void;
	onRemoved: () => void;
	onClose: () => void;
}) {
	const { repo } = props;
	const [name, setName] = useState(repo.name);
	const [baseBranch, setBaseBranch] = useState(repo.baseBranch);
	const [remote, setRemote] = useState(repo.remote ?? "origin");
	const [routingLabel, setRoutingLabel] = useState(repo.routingLabel ?? "");
	const [isDefault, setIsDefault] = useState(repo.isDefault);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const save = () => {
		setBusy(true);
		api
			.updateRepo(repo.name, {
				name: name.trim(),
				baseBranch: baseBranch.trim(),
				remote: remote.trim() || null,
				routingLabel: routingLabel.trim() || null,
				default: isDefault,
			})
			.then((updated) => props.onSaved(updated.name))
			.catch((err) => setError(String(err)))
			.finally(() => setBusy(false));
	};

	const remove = () => {
		if (
			!window.confirm(
				`Remove "${repo.name}" from the agent?\n\nThe repository on disk is not touched — only the registration, so its flows and skills stay in the repo.`,
			)
		)
			return;
		setBusy(true);
		api
			.removeRepo(repo.name)
			.then(() => props.onRemoved())
			.catch((err) => setError(String(err)))
			.finally(() => setBusy(false));
	};

	return (
		<div className="modal-backdrop" onClick={props.onClose} onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
			<div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Project settings">
				<header>
					<h2>Project settings</h2>
					<button type="button" onClick={props.onClose}>
						✕
					</button>
				</header>

				<div className="picked-path">
					<code>{repo.path}</code>
				</div>

				<div className="modal-fields">
					<label className="field">
						<span>project name</span>
						<input value={name} onChange={(e) => setName(e.target.value)} />
					</label>
					<label className="field">
						<span>git remote — fetched from, branched off, pushed to</span>
						<select value={remote} onChange={(e) => setRemote(e.target.value)}>
							{(repo.remotes?.length ? repo.remotes : [remote || "origin"]).map((r) => (
								<option key={r} value={r}>
									{r}
								</option>
							))}
						</select>
					</label>
					<label className="field">
						<span>base branch — worktrees start from {remote || "origin"}/&lt;this&gt;</span>
						<input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="develop" />
					</label>
					<label className="field">
						<span>Linear routing label — issues with this label run here (blank = only reachable as default)</span>
						<input value={routingLabel} onChange={(e) => setRoutingLabel(e.target.value)} placeholder="uao" />
					</label>
					<label className="check">
						<input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
						default project — issues with no routing label land here
					</label>
				</div>

				{error && <p className="warn">{error}</p>}

				<footer className="settings-footer">
					<button type="button" className="danger" disabled={busy} onClick={remove}>
						Remove project
					</button>
					<span className="spacer" />
					<button type="button" className="primary" disabled={busy} onClick={save}>
						{busy ? "Saving…" : "Save settings"}
					</button>
				</footer>
			</div>
		</div>
	);
}
