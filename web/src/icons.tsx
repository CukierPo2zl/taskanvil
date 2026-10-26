import type { ReactElement } from "react";
import type { NodeType } from "./types";

const PATHS: Record<NodeType, ReactElement> = {
	worktree: (
		<>
			<circle cx="4" cy="3.5" r="1.7" />
			<circle cx="4" cy="10.5" r="1.7" />
			<circle cx="10.5" cy="3.5" r="1.7" />
			<path d="M4 5.2v3.6M10.5 5.2c0 2.6-2.4 3.4-4.6 3.5" />
		</>
	),
	agent: <path d="M7 1.2 8.4 5.6 12.8 7 8.4 8.4 7 12.8 5.6 8.4 1.2 7 5.6 5.6Z" fill="currentColor" stroke="none" />,
	commit: (
		<>
			<circle cx="7" cy="7" r="2.4" />
			<path d="M1 7h3.6M9.4 7H13" />
		</>
	),
	push: <path d="M7 12.5V5M4 8l3-3 3 3M3.5 2h7" />,
	openPR: (
		<>
			<circle cx="4" cy="3.5" r="1.7" />
			<circle cx="4" cy="10.5" r="1.7" />
			<circle cx="10.5" cy="10.5" r="1.7" />
			<path d="M4 5.2v3.6M7 3.5h1.5a2 2 0 0 1 2 2v3.3" />
		</>
	),
	respond: (
		<path d="M2 3.2A1.2 1.2 0 0 1 3.2 2h7.6A1.2 1.2 0 0 1 12 3.2v5.1a1.2 1.2 0 0 1-1.2 1.2H6.5L3.8 12V9.5h-.6A1.2 1.2 0 0 1 2 8.3Z" />
	),
	say: (
		<>
			<path d="M2 6v2.5M2 7h2.5L11 3.5v7L4.5 7" />
			<path d="M5.5 7.3 6.3 11" />
		</>
	),
};

export function SearchIcon({ size = 12 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 14 14"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.4"
			strokeLinecap="round"
			aria-hidden="true"
		>
			<circle cx="6" cy="6" r="4.2" />
			<path d="m9.3 9.3 3.2 3.2" />
		</svg>
	);
}

export function Glyph({ type, size = 14 }: { type: NodeType; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 14 14"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.3"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{PATHS[type]}
		</svg>
	);
}

function Icon(props: { size?: number; children: ReactElement | ReactElement[]; strokeWidth?: number }) {
	const size = props.size ?? 16;
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={props.strokeWidth ?? 1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{props.children}
		</svg>
	);
}

/** taskanvil's mark: an anvil silhouette. */
export function LogoMark({ size = 22 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
			<path
				d="M3 6h14.5c0 2.4 1.7 3.6 3.5 3.8V11h-5.2l-1.6 3h1.8v2.5h3V19H5v-2.5h3V14h1.8L8.2 11H6.5C4.6 11 3 9.4 3 7.5Z"
				fill="currentColor"
			/>
		</svg>
	);
}

/** The thin diagonal breadcrumb separator. */
export function Slash() {
	return (
		<svg className="crumb-slash" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
			<path d="M16.88 3.549L7.12 20.451" stroke="currentColor" strokeWidth="1" fill="none" />
		</svg>
	);
}

export function ChevronsUpDown({ size = 14 }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="m5 6 3-3 3 3M5 10l3 3 3-3" />
		</Icon>
	);
}

export function CheckIcon({ size = 14 }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="m3.5 8.5 3 3 6-7" />
		</Icon>
	);
}

export function PlusIcon({ size = 14 }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M8 3v10M3 8h10" />
		</Icon>
	);
}

export function CloseIcon({ size = 14 }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="m4 4 8 8M12 4l-8 8" />
		</Icon>
	);
}

export function FlowIcon({ size = 14 }: { size?: number }) {
	return (
		<Icon size={size}>
			<rect x="1.5" y="5.5" width="4" height="5" rx="1" />
			<rect x="10.5" y="5.5" width="4" height="5" rx="1" />
			<path d="M5.5 8h5" />
		</Icon>
	);
}
