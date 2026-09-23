import { type Edge, MarkerType, type Node } from "@xyflow/react";
import type { FlowDefinition, FlowNodeDef, NodeType } from "./types";

export type CanvasNode = Node<{ def: FlowNodeDef }>;

export const EDGE_OPTIONS = {
	type: "flowEdge",
	markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15 },
} as const;

export function edgeAppearance(condition?: string) {
	return {
		data: { condition: condition || undefined },
		style: condition ? { strokeDasharray: "5 4" } : undefined,
		...EDGE_OPTIONS,
	};
}

/** Geometry of the guide line steps snap to. `centerY` is where ports sit. */
export const RAIL = { x0: 60, gap: 226, y: 300, centerY: 339 } as const;

export function railSlot(index: number): { x: number; y: number } {
	return { x: RAIL.x0 + index * RAIL.gap, y: RAIL.y };
}

export function executionOrder(nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const hasIncoming = new Set(edges.map((e) => e.target));
	const queue = nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id);
	const order: CanvasNode[] = [];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const id = queue.shift();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const node = byId.get(id);
		if (node) order.push(node);
		for (const edge of edges) if (edge.source === id) queue.push(edge.target);
	}
	for (const node of nodes) if (!seen.has(node.id)) order.push(node);
	return order;
}

export function railLayout(nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
	return executionOrder(nodes, edges).map((node, i) => ({ ...node, position: railSlot(i) }));
}

export function toCanvas(definition: FlowDefinition): { nodes: CanvasNode[]; edges: Edge[] } {
	const positions = autoLayout(definition);
	const nodes: CanvasNode[] = definition.nodes.map((def) => ({
		id: def.id,
		type: "flowNode",
		position: def.position ?? positions.get(def.id) ?? { x: 40, y: 40 },
		data: { def },
	}));
	const edges: Edge[] = definition.edges.map((edge, i) => ({
		id: `e${i}-${edge.from}-${edge.to}`,
		source: edge.from,
		target: edge.to,
		...edgeAppearance(edge.condition),
	}));
	return { nodes, edges };
}

function autoLayout(definition: FlowDefinition): Map<string, { x: number; y: number }> {
	const positions = new Map<string, { x: number; y: number }>();
	const hasIncoming = new Set(definition.edges.map((e) => e.to));
	const queue = definition.nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => ({ id: n.id, depth: 0 }));
	const rowsAtDepth = new Map<number, number>();
	const seen = new Set<string>();

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item || seen.has(item.id)) continue;
		seen.add(item.id);
		const row = rowsAtDepth.get(item.depth) ?? 0;
		rowsAtDepth.set(item.depth, row + 1);
		positions.set(item.id, { x: 60 + item.depth * 250, y: 80 + row * 150 });
		for (const edge of definition.edges.filter((e) => e.from === item.id)) {
			queue.push({ id: edge.to, depth: item.depth + 1 });
		}
	}
	let orphanRow = 0;
	for (const node of definition.nodes) {
		if (!positions.has(node.id)) positions.set(node.id, { x: 60, y: 380 + orphanRow++ * 150 });
	}
	return positions;
}

export function fromCanvas(
	meta: { name: string; description?: string },
	nodes: CanvasNode[],
	edges: Edge[],
): FlowDefinition {
	return {
		name: meta.name,
		...(meta.description ? { description: meta.description } : {}),
		nodes: nodes.map((node) => ({
			...node.data.def,
			id: node.id,
			position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
		})),
		edges: edges.map((edge) => {
			const condition = (edge.data as { condition?: string } | undefined)?.condition;
			return { from: edge.source, to: edge.target, ...(condition ? { condition } : {}) };
		}),
	};
}

export const NODE_TYPES: Array<{ type: NodeType; label: string; hint: string }> = [
	{ type: "worktree", label: "Worktree", hint: "Create the isolated git worktree" },
	{ type: "agent", label: "Agent", hint: "Run a Claude session with a skill" },
	{ type: "commit", label: "Commit", hint: "Deterministic engine-side commit" },
	{ type: "push", label: "Push", hint: "Push the branch to origin" },
	{ type: "openPR", label: "Open PR", hint: "Open a pull request" },
	{ type: "say", label: "Say", hint: "Post a status note mid-flow — doesn't end the session" },
	{ type: "respond", label: "Respond", hint: "Post the final message to Linear — ends the session" },
];

export function templateFor(type: NodeType, defaultSkill: string): FlowNodeDef {
	switch (type) {
		case "agent":
			return { id: "", type, skill: defaultSkill, git: { commit: true, push: false } };
		case "commit":
			return { id: "", type, message: "{identifier}: {title}" };
		case "say":
			return { id: "", type, message: "Starting work on {identifier}…" };
		case "openPR":
			return { id: "", type, draft: true };
		default:
			return { id: "", type };
	}
}

export function nextId(type: NodeType, nodes: CanvasNode[]): string {
	const taken = new Set(nodes.map((n) => n.id));
	for (let i = 1; ; i++) {
		const candidate = i === 1 ? type : `${type}-${i}`;
		if (!taken.has(candidate)) return candidate;
	}
}

export function starterFlow(label: string, defaultSkill: string): FlowDefinition {
	return {
		name: label,
		nodes: [
			{ id: "worktree", type: "worktree", position: railSlot(0) },
			{ id: "agent", type: "agent", skill: defaultSkill, git: { commit: true, push: false }, position: railSlot(1) },
		],
		edges: [{ from: "worktree", to: "agent" }],
	};
}
