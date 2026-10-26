import { useState } from "react";
import { api } from "./api";
import type { RepoInfo } from "./types";

/** Settings tab: one card per concern, each saving the whole form. Keyed by
    project name in the parent so state resets when the project changes. */
export function ProjectSettings(props: { repo: RepoInfo; onSaved: (newName: string) => void; onRemoved: () => void }) {
	const { repo } = props;
	const [name, setName] = useState(repo.name);
	const [baseBranch, setBaseBranch] = useState(repo.baseBranch);
	const [remote, setRemote] = useState(repo.remote ?? "origin");
	const [routingLabel, setRoutingLabel] = useState(repo.routingLabel ?? "");
	const [isDefault, setIsDefault] = useState(repo.isDefault);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const fromConfig = repo.source === "config";

	const save = () => {
		setBusy(true);
		setError("");
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

	const saveButton = (
		<button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>
			{busy ? "Saving…" : "Save"}
		</button>
	);

	return (
		<div className="page">
			<div className="page-head">
				<h1>Settings</h1>
				<p>
					<code>{repo.path}</code>
				</p>
			</div>

			{error && <div className="note note-error">{error}</div>}

			<section className="card">
				<div className="card-body">
					<h3>Project name</h3>
					<p>Used to identify this project in the dashboard and in Linear routing.</p>
					<input
						className="card-input"
						value={name}
						aria-label="Project name"
						onChange={(e) => setName(e.target.value)}
					/>
				</div>
				<footer className="card-foot">
					<span>Letters, digits and dashes work best.</span>
					{saveButton}
				</footer>
			</section>

			<section className="card">
				<div className="card-body">
					<h3>Git</h3>
					<p>
						Worktrees are branched off{" "}
						<code>
							{remote || "origin"}/{baseBranch || "<base>"}
						</code>
						, and pushes go to the same remote.
					</p>
					<div className="card-grid">
						<label className="field">
							<span>Remote</span>
							<select value={remote} onChange={(e) => setRemote(e.target.value)}>
								{(repo.remotes?.length ? repo.remotes : [remote || "origin"]).map((r) => (
									<option key={r} value={r}>
										{r}
									</option>
								))}
							</select>
						</label>
						<label className="field">
							<span>Base branch</span>
							<input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="develop" />
						</label>
					</div>
				</div>
				<footer className="card-foot">
					<span>Fetched before every run.</span>
					{saveButton}
				</footer>
			</section>

			<section className="card">
				<div className="card-body">
					<h3>Linear routing</h3>
					<p>Issues carrying this label run against this project. Leave it blank to only reach it as the default.</p>
					<input
						className="card-input"
						value={routingLabel}
						aria-label="Routing label"
						onChange={(e) => setRoutingLabel(e.target.value)}
						placeholder="uao"
					/>
					<label className="check">
						<input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
						Default project — issues with no routing label land here
					</label>
				</div>
				<footer className="card-foot">
					<span>Applies to newly delegated issues.</span>
					{saveButton}
				</footer>
			</section>

			<section className="card card-danger">
				<div className="card-body">
					<h3>Remove project</h3>
					<p>
						Unregisters the project from the agent. The repository on disk is not touched, so its flows and skills stay
						in the repo.
					</p>
				</div>
				<footer className="card-foot">
					<span>{fromConfig ? "Defined in agent.config.ts — remove it there." : "This cannot be undone here."}</span>
					<button type="button" className="btn btn-danger btn-sm" disabled={busy || fromConfig} onClick={remove}>
						Remove
					</button>
				</footer>
			</section>
		</div>
	);
}
