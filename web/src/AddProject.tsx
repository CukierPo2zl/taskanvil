import { useEffect, useState } from "react";
import { api } from "./api";
import { CloseIcon } from "./icons";
import type { BrowseResult } from "./types";

export function AddProject(props: { initialPath?: string; onAdded: (name: string) => void; onClose: () => void }) {
	const [listing, setListing] = useState<BrowseResult | null>(null);
	const [manualPath, setManualPath] = useState(props.initialPath ?? "");
	const [name, setName] = useState("");
	const [baseBranch, setBaseBranch] = useState("");
	const [remote, setRemote] = useState("");
	const [routingLabel, setRoutingLabel] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const pickedNatively = !!props.initialPath;
	const dirName = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? "";

	const browse = (path?: string) => {
		api
			.browse(path)
			.then((result) => {
				setListing(result);
				setError("");
			})
			.catch((err) => setError(String(err)));
	};

	useEffect(() => {
		if (!pickedNatively) browse();
	}, [pickedNatively]);

	const register = (path: string) => {
		setBusy(true);
		api
			.addRepo(path, {
				name: name.trim() || undefined,
				baseBranch: baseBranch.trim() || undefined,
				remote: remote.trim() || undefined,
				routingLabel: routingLabel.trim() || undefined,
			})
			.then((repo) => props.onAdded(repo.name))
			.catch((err) => setError(String(err)))
			.finally(() => setBusy(false));
	};

	const targetPath = manualPath.trim() || (listing?.isGitRepo ? listing.path : "");

	return (
		<div className="modal-backdrop" onClick={props.onClose} onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
			<div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add project">
				<header>
					<h2>Add project</h2>
					<button type="button" className="icon-btn" title="Close" onClick={props.onClose}>
						<CloseIcon />
					</button>
				</header>

				{pickedNatively ? (
					<div className="picked-path">
						<code>{manualPath}</code>
					</div>
				) : (
					<div className="browser">
						<div className="browser-path">
							<button
								type="button"
								disabled={!listing?.parent}
								onClick={() => listing?.parent && browse(listing.parent)}
							>
								↑
							</button>
							<code>{listing?.path ?? "…"}</code>
							{listing?.isGitRepo && <span className="badge badge-green">git repo</span>}
						</div>
						<ul className="browser-dirs">
							{listing?.dirs.map((dir) => (
								<li key={dir.path} className="browser-row">
									<button type="button" className="browser-name" onClick={() => browse(dir.path)}>
										{dir.isGitRepo ? "◈" : "▸"} {dir.name}
										{dir.isGitRepo && <span className="badge badge-green">git</span>}
									</button>
									{dir.isGitRepo && (
										<button
											type="button"
											className="btn btn-secondary btn-xs browser-add"
											disabled={busy}
											onClick={() => setManualPath(dir.path)}
										>
											select
										</button>
									)}
								</li>
							))}
							{listing && listing.dirs.length === 0 && <li className="hint">No subdirectories.</li>}
						</ul>
					</div>
				)}

				<div className="modal-fields">
					<label className="field">
						<span>Linear routing label — issues with this label run against this repo</span>
						<input
							value={routingLabel}
							onChange={(e) => setRoutingLabel(e.target.value)}
							placeholder={targetPath ? dirName(targetPath) : "my-web-app"}
						/>
					</label>
					<label className="field">
						<span>project name (blank = directory name)</span>
						<input
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={targetPath ? dirName(targetPath) : "my-web-app"}
						/>
					</label>
					<label className="field">
						<span>base branch (blank = auto-detect)</span>
						<input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="develop" />
					</label>
					<label className="field">
						<span>git remote (blank = origin)</span>
						<input value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="origin" />
					</label>
					{!pickedNatively && (
						<label className="field">
							<span>or paste a path directly</span>
							<input
								value={manualPath}
								onChange={(e) => setManualPath(e.target.value)}
								placeholder="~/Desktop/projects/…"
								onKeyDown={(e) => e.key === "Enter" && manualPath.trim() && register(manualPath.trim())}
							/>
						</label>
					)}
				</div>

				<p className="hint">
					No routing label means issues only reach this repo when it's the default. On a shared board, set one — e.g.
					label <code>{routingLabel.trim() || (targetPath ? dirName(targetPath) : "my-web-app")}</code> on a Linear
					issue sends it here.
				</p>

				{error && <p className="warn">{error}</p>}

				<footer>
					<button
						type="button"
						className="btn btn-primary"
						disabled={busy || !targetPath}
						onClick={() => register(targetPath)}
					>
						{busy ? "Registering…" : "Register project"}
					</button>
				</footer>
			</div>
		</div>
	);
}
