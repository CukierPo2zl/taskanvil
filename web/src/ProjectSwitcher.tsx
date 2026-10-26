import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronsUpDown, PlusIcon } from "./icons";
import type { RepoInfo } from "./types";

/** A stable two-stop gradient per project name, like a generated avatar. */
export function avatarGradient(name: string): string {
	let hash = 0;
	for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
	const hue = Math.abs(hash) % 360;
	return `linear-gradient(135deg, hsl(${hue} 80% 60%), hsl(${(hue + 70) % 360} 85% 55%))`;
}

export function ProjectSwitcher(props: {
	repos: RepoInfo[];
	repo: string;
	picking: boolean;
	onSelect: (name: string) => void;
	onAdd: () => void;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const current = props.repos.find((r) => r.name === props.repo);

	return (
		<div className="switcher" ref={rootRef}>
			<button
				type="button"
				className="switcher-trigger"
				aria-haspopup="menu"
				aria-expanded={open}
				title={current?.path}
				onClick={() => setOpen((v) => !v)}
			>
				<span className="avatar" style={{ background: avatarGradient(props.repo || "?") }} />
				<span className="switcher-name">{props.repo || "No project"}</span>
				{current?.isDefault && <span className="badge badge-neutral">default</span>}
				<ChevronsUpDown />
			</button>
			{open && (
				<div className="menu switcher-menu" role="menu">
					<div className="menu-label">Projects</div>
					{props.repos.map((r) => (
						<button
							type="button"
							role="menuitem"
							key={r.name}
							className="menu-item"
							title={r.path}
							onClick={() => {
								props.onSelect(r.name);
								setOpen(false);
							}}
						>
							<span className="avatar avatar-sm" style={{ background: avatarGradient(r.name) }} />
							<span className="menu-item-label">{r.name}</span>
							{r.name === props.repo && <CheckIcon />}
						</button>
					))}
					<div className="menu-sep" />
					<button
						type="button"
						role="menuitem"
						className="menu-item"
						disabled={props.picking}
						onClick={() => {
							setOpen(false);
							props.onAdd();
						}}
					>
						<span className="menu-icon">
							<PlusIcon />
						</span>
						<span className="menu-item-label">{props.picking ? "Opening picker…" : "Add project"}</span>
					</button>
				</div>
			)}
		</div>
	);
}
