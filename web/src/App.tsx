import {
	addEdge,
	applyEdgeChanges,
	applyNodeChanges,
	Background,
	BackgroundVariant,
	BaseEdge,
	type Connection,
	type Edge,
	type EdgeChange,
	EdgeLabelRenderer,
	type EdgeProps,
	type EdgeTypes,
	getSmoothStepPath,
	Handle,
	type NodeChange,
	type NodeTypes,
	Position,
	ReactFlow,
	type ReactFlowInstance,
	ViewportPortal,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddProject } from "./AddProject";
import { api } from "./api";
import {
	type CanvasNode,
	edgeAppearance,
	fromCanvas,
	NODE_TYPES,
	nextId,
	RAIL,
	railLayout,
	railSlot,
	starterFlow,
	templateFor,
	toCanvas,
} from "./graph";
import { EdgeInspector, NodeInspector } from "./Inspector";
import { Glyph, SearchIcon } from "./icons";
import { ProjectSettings } from "./ProjectSettings";
import type { AgentStatus, FlowListing, FlowNodeDef, NodeType, RepoInfo, SkillInfo } from "./types";

const KIND_LABEL: Record<NodeType, string> = {
	worktree: "worktree",
	agent: "agent",
	commit: "commit",
	push: "push",
	openPR: "open pr",
	say: "say",
	respond: "respond",
};

function nodeCopy(def: FlowNodeDef): { title: string; detail: string } {
	switch (def.type) {
		case "worktree":
			return {
				title: "Isolated worktree",
				detail: def.branch || def.dir ? [def.branch, def.dir].filter(Boolean).join(" · ") : "from ticket directives",
			};
		case "agent": {
			const parts = [def.session === "continue" ? "⟲ continue" : (def.model ?? "default")];
			if (def.tools?.length) parts.push(`${def.tools.length} tools`);
			else if (def.maxTurns) parts.push(`${def.maxTurns} turns`);
			return { title: def.skill ?? "agent", detail: parts.join(" · ") };
		}
		case "commit":
			return { title: "Commit", detail: def.message ?? "{identifier}: {title}" };
		case "push":
			return { title: "Push to origin", detail: "deterministic" };
		case "openPR":
			return { title: def.draft ? "Draft pull request" : "Pull request", detail: def.title ?? "{identifier}: {title}" };
		case "say":
			return { title: "Say", detail: def.message ?? "" };
		case "respond":
			return { title: "Respond", detail: def.template ?? "{lastText}" };
	}
}

function FlowNodeCard({ data, selected }: { data: { def: FlowNodeDef }; selected?: boolean }) {
	const { def } = data;
	const { title, detail } = nodeCopy(def);
	return (
		<div className={`node sig-${def.type}${selected ? " selected" : ""}`}>
			<Handle type="target" position={Position.Left} />
			<div className="node-kind">
				<Glyph type={def.type} size={13} />
				<span>{KIND_LABEL[def.type]}</span>
			</div>
			<div className="node-title">{title}</div>
			{detail && <div className="node-detail">{detail}</div>}
			<Handle type="source" position={Position.Right} />
		</div>
	);
}

const nodeTypes = { flowNode: FlowNodeCard } as unknown as NodeTypes;

// The gap between cards is too narrow for an inline SVG edge label, so the
// condition renders in the HTML overlay.

function FlowEdge(props: EdgeProps) {
	const { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition } = props;
	const [path, labelX, labelY] = getSmoothStepPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
	});
	const condition = (props.data as { condition?: string } | undefined)?.condition;
	return (
		<>
			<BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd as string | undefined} />
			{condition && (
				<EdgeLabelRenderer>
					<div
						className={`edge-pill${props.selected ? " selected" : ""}`}
						style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 58}px)` }}
					>
						if {condition}
					</div>
				</EdgeLabelRenderer>
			)}
		</>
	);
}

const edgeTypes = { flowEdge: FlowEdge } as unknown as EdgeTypes;

function CommandMenu(props: { onPick: (type: NodeType) => void; onClose: () => void }) {
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const q = query.trim().toLowerCase();
	const matches = NODE_TYPES.filter((t) => !q || t.label.toLowerCase().includes(q) || t.hint.toLowerCase().includes(q));

	useEffect(() => setActive(0), [q]);

	const onKey = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((a) => Math.min(a + 1, matches.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((a) => Math.max(a - 1, 0));
		} else if (e.key === "Enter" && matches[active]) {
			e.preventDefault();
			props.onPick(matches[active].type);
		}
	};

	return (
		<div className="cmdk-backdrop" onClick={props.onClose} onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
			<div className="cmdk" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add step">
				<input
					// biome-ignore lint/a11y/noAutofocus: the menu exists to be typed in
					autoFocus
					value={query}
					placeholder="Add a step…"
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={onKey}
				/>
				<ul>
					{matches.map((t, i) => (
						<li key={t.type}>
							<button
								type="button"
								className={`cmdk-row sig-${t.type}${i === active ? " active" : ""}`}
								onMouseEnter={() => setActive(i)}
								onClick={() => props.onPick(t.type)}
							>
								<span className="cmdk-glyph">
									<Glyph type={t.type} size={13} />
								</span>
								<span className="cmdk-label">{t.label}</span>
								<span className="cmdk-hint">{t.hint}</span>
							</button>
						</li>
					))}
					{matches.length === 0 && <li className="cmdk-empty">No step matches “{query.trim()}”.</li>}
				</ul>
			</div>
		</div>
	);
}

export default function App() {
	const [repos, setRepos] = useState<RepoInfo[]>([]);
	const [repo, setRepo] = useState("");
	const [skills, setSkills] = useState<SkillInfo[]>([]);
	const [flows, setFlows] = useState<FlowListing[]>([]);
	const [current, setCurrent] = useState<{ label: string } | null>(null);
	const [meta, setMeta] = useState<{ name: string; description?: string }>({ name: "" });
	const [nodes, setNodes] = useState<CanvasNode[]>([]);
	const [edges, setEdges] = useState<Edge[]>([]);
	const [selected, setSelected] = useState<{ nodeId?: string; edgeId?: string }>({});
	const [newLabel, setNewLabel] = useState("");
	const [skillQuery, setSkillQuery] = useState("");
	const [status, setStatus] = useState<{ text: string; kind: "ok" | "warn" | "error" } | null>(null);
	const [dirty, setDirty] = useState(false);
	const [addingProject, setAddingProject] = useState(false);
	const [editingProject, setEditingProject] = useState(false);
	const [skillView, setSkillView] = useState<(SkillInfo & { content: string }) | null>(null);
	const [pickedPath, setPickedPath] = useState<string | undefined>(undefined);
	const [picking, setPicking] = useState(false);
	const [autoArrange, setAutoArrange] = useState(true);
	const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
	const [cmdOpen, setCmdOpen] = useState(false);
	const flowRef = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null);

	// Re-center after the canvas has laid the (possibly re-railed) nodes out.
	// Padding keeps the rail clear of the floating dock, inspector and toolbar.
	const refit = useCallback(() => {
		requestAnimationFrame(() =>
			flowRef.current?.fitView({ padding: { left: "270px", right: "310px", top: "90px", bottom: "70px" }, maxZoom: 1 }),
		);
	}, []);

	useEffect(() => {
		api
			.status()
			.then(setAgentStatus)
			.catch(() => setAgentStatus(null));
	}, []);

	const repoInfo = repos.find((r) => r.name === repo);

	const onProjectAdded = (name: string) => {
		setAddingProject(false);
		api
			.repos()
			.then((list) => {
				setRepos(list);
				setRepo(name);
				say(`Project "${name}" registered`);
			})
			.catch((err) => say(String(err), "error"));
	};

	const onProjectRemoved = (name: string) => {
		setEditingProject(false);
		api
			.repos()
			.then((list) => {
				setRepos(list);
				setRepo((list.find((r) => r.isDefault) ?? list[0])?.name ?? "");
				say(`Project "${name}" removed from the agent`);
			})
			.catch((err) => say(String(err), "error"));
	};

	const removeProject = () => {
		if (!repoInfo) return;
		if (
			!window.confirm(
				`Remove "${repoInfo.name}" from the agent?\n\nThe repository on disk is not touched — only the registration, so its flows and skills stay in the repo.`,
			)
		)
			return;
		api
			.removeRepo(repoInfo.name)
			.then(() => onProjectRemoved(repoInfo.name))
			.catch((err) => say(String(err), "error"));
	};

	const addProject = () => {
		setPicking(true);
		api
			.pickDirectory()
			.then((result) => {
				if (result.canceled) return;
				setPickedPath(result.unsupported || !result.path ? undefined : result.path);
				setAddingProject(true);
			})
			.catch((err) => say(String(err), "error"))
			.finally(() => setPicking(false));
	};

	const say = (text: string, kind: "ok" | "warn" | "error" = "ok") => setStatus({ text, kind });

	useEffect(() => {
		if (!status) return;
		const timer = setTimeout(() => setStatus(null), status.kind === "error" ? 8000 : 4000);
		return () => clearTimeout(timer);
	}, [status]);

	useEffect(() => {
		api
			.repos()
			.then((list) => {
				setRepos(list);
				const initial = list.find((r) => r.isDefault) ?? list[0];
				if (initial) setRepo(initial.name);
			})
			.catch((err) => say(String(err), "error"));
	}, []);

	const refreshFlows = useCallback(() => {
		if (!repo) return;
		api
			.flows(repo)
			.then(setFlows)
			.catch((err) => say(String(err), "error"));
	}, [repo]);

	useEffect(() => {
		if (!repo) return;
		api
			.skills(repo)
			.then(setSkills)
			.catch((err) => say(String(err), "error"));
		refreshFlows();
		setCurrent(null);
		setNodes([]);
		setEdges([]);
		setSelected({});
		setDirty(false);
	}, [repo, refreshFlows]);

	const openFlow = (label: string) => {
		api
			.flow(repo, label)
			.then(({ definition }) => {
				const canvas = toCanvas(definition);
				setMeta({ name: definition.name, description: definition.description });
				setNodes(autoArrange ? railLayout(canvas.nodes, canvas.edges) : canvas.nodes);
				setEdges(canvas.edges);
				setCurrent({ label });
				setSelected({});
				setDirty(false);
				refit();
				say(`Opened flow "${label}"`);
			})
			.catch((err) => say(String(err), "error"));
	};

	const createFlow = () => {
		const label = newLabel.trim();
		if (!/^[\w-]{1,64}$/.test(label)) return say("Label must be letters/digits/dashes", "error");
		const defaultSkill = skills[0]?.name ?? "implement";
		const canvas = toCanvas(starterFlow(label, defaultSkill));
		setMeta({ name: label });
		setNodes(canvas.nodes);
		setEdges(canvas.edges);
		setCurrent({ label });
		setSelected({});
		setNewLabel("");
		setDirty(true);
		refit();
		say(`New flow "${label}" — not saved yet`, "warn");
	};

	const save = () => {
		if (!current) return;
		const definition = fromCanvas(meta, nodes, edges);
		api
			.saveFlow(repo, current.label, definition)
			.then(({ warnings }) => {
				setDirty(false);
				refreshFlows();
				say(warnings.length ? `Saved with warnings: ${warnings.join("; ")}` : "Saved", warnings.length ? "warn" : "ok");
			})
			.catch((err) => say(String(err), "error"));
	};

	const removeFlow = () => {
		if (!current) return;
		if (!window.confirm(`Delete flow "${current.label}" from ${repo}?`)) return;
		api
			.deleteFlow(repo, current.label)
			.then(() => {
				setCurrent(null);
				setNodes([]);
				setEdges([]);
				refreshFlows();
				say("Deleted");
			})
			.catch((err) => say(String(err), "error"));
	};

	useEffect(() => {
		if (!autoArrange || !current) return;
		setNodes((cur) => {
			const laid = railLayout(cur, edges);
			const same = laid.every(
				(n, i) => n.id === cur[i]?.id && n.position.x === cur[i].position.x && n.position.y === cur[i].position.y,
			);
			return same ? cur : laid;
		});
	}, [autoArrange, edges, current]);

	const onNodeDragStop = useCallback(() => {
		if (autoArrange) setNodes((cur) => railLayout(cur, edges));
	}, [autoArrange, edges]);

	const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
		setNodes((n) => applyNodeChanges(changes, n));
		if (changes.some((c) => c.type !== "select" && c.type !== "dimensions")) setDirty(true);
	}, []);
	const onEdgesChange = useCallback((changes: EdgeChange[]) => {
		setEdges((e) => applyEdgeChanges(changes, e));
		if (changes.some((c) => c.type !== "select")) setDirty(true);
	}, []);
	const onConnect = useCallback((connection: Connection) => {
		setEdges((e) => addEdge({ ...connection, ...edgeAppearance() }, e));
		setDirty(true);
	}, []);

	// Memoized with a bail-out: xyflow re-fires selection on handler identity
	// changes, so an inline handler + fresh state object loops forever.
	const onSelectionChange = useCallback(({ nodes: n, edges: e }: { nodes: CanvasNode[]; edges: Edge[] }) => {
		setSelected((prev) => {
			const nodeId = n[0]?.id;
			const edgeId = n.length === 0 ? e[0]?.id : undefined;
			return prev.nodeId === nodeId && prev.edgeId === edgeId ? prev : { nodeId, edgeId };
		});
	}, []);

	const addNode = useCallback(
		(type: NodeType) => {
			const id = nextId(type, nodes);
			const def = { ...templateFor(type, skills[0]?.name ?? "implement"), id };
			const maxX = nodes.reduce((m, n) => Math.max(m, n.position.x), RAIL.x0 - RAIL.gap);
			const position = autoArrange ? railSlot(nodes.length) : { x: maxX + RAIL.gap, y: RAIL.y };
			setNodes((n) => [...n, { id, type: "flowNode", position, data: { def } }]);
			setSelected({ nodeId: id });
			setCmdOpen(false);
			setDirty(true);
		},
		[nodes, skills, autoArrange],
	);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				if (current) setCmdOpen((v) => !v);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [current]);

	const updateNodeDef = (id: string, def: FlowNodeDef) => {
		setNodes((n) => n.map((node) => (node.id === id ? { ...node, data: { def } } : node)));
		setDirty(true);
	};

	const updateEdgeCondition = (id: string, condition: string) => {
		setEdges((e) => e.map((edge) => (edge.id === id ? { ...edge, ...edgeAppearance(condition) } : edge)));
		setDirty(true);
	};

	const deleteSelected = () => {
		if (selected.nodeId) {
			setNodes((n) => n.filter((node) => node.id !== selected.nodeId));
			setEdges((e) => e.filter((edge) => edge.source !== selected.nodeId && edge.target !== selected.nodeId));
		}
		if (selected.edgeId) setEdges((e) => e.filter((edge) => edge.id !== selected.edgeId));
		setSelected({});
		setDirty(true);
	};

	const closeInspector = () => {
		setSelected({});
		setNodes((n) => n.map((node) => (node.selected ? { ...node, selected: false } : node)));
		setEdges((e) => e.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)));
	};

	const selectedNode = useMemo(() => nodes.find((n) => n.id === selected.nodeId), [nodes, selected]);
	const selectedEdge = useMemo(() => edges.find((e) => e.id === selected.edgeId), [edges, selected]);

	const visibleSkills = useMemo(() => {
		const q = skillQuery.trim().toLowerCase();
		if (!q) return skills;
		return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
	}, [skills, skillQuery]);

	return (
		<div className="app">
			{agentStatus && !agentStatus.linear.connected && (
				<div className="connectbar">
					No Linear workspace connected — flows will not run. <a href={agentStatus.setupUrl}>Open setup</a>
				</div>
			)}
			<div className="canvas">
				<ReactFlow
					nodes={nodes}
					edges={edges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					onInit={(instance) => {
						flowRef.current = instance;
					}}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					onConnect={onConnect}
					onNodeDragStop={onNodeDragStop}
					onSelectionChange={onSelectionChange}
					fitView
					fitViewOptions={{ padding: { left: "270px", right: "310px", top: "90px", bottom: "70px" }, maxZoom: 1 }}
					deleteKeyCode={null}
				>
					<Background variant={BackgroundVariant.Dots} gap={26} size={1.2} color="rgba(240, 234, 228, 0.07)" />
					{current && autoArrange && (
						<ViewportPortal>
							<div className="rail-guide" style={{ top: RAIL.centerY }} />
						</ViewportPortal>
					)}
				</ReactFlow>

				{!current && (
					<div className="empty">
						<h2>No flow open</h2>
						<p className="hint">
							A flow runs when an issue with its label is delegated to the agent in Linear. Steps execute left to right
							along the rail; edge conditions pick the path. Open a flow from the panel, or type a label there to create
							one.
						</p>
						<div className="legend">
							{NODE_TYPES.map((t) => (
								<div className={`legend-row sig-${t.type}`} key={t.type}>
									<span className="legend-glyph">
										<Glyph type={t.type} />
									</span>
									<div>
										<strong>{t.label}</strong>
										<span>{t.hint}</span>
									</div>
								</div>
							))}
						</div>
					</div>
				)}
			</div>

			{current && (
				<div className="toolbar">
					<input
						className="flow-name"
						value={meta.name}
						aria-label="Flow name"
						onChange={(e) => {
							setMeta({ ...meta, name: e.target.value });
							setDirty(true);
						}}
					/>
					<span
						className="tb-scope"
						title={`Saved in ${repo}/.claude/flows/${current.label}.json — flows belong to one project`}
					>
						{repo}
					</span>
					<span className="tb-div" />
					<span className="tb-palette">
						{NODE_TYPES.map((t) => (
							<button
								type="button"
								key={t.type}
								className={`tb-add sig-${t.type}`}
								title={`${t.label} — ${t.hint}`}
								onClick={() => addNode(t.type)}
							>
								<Glyph type={t.type} size={13} />
							</button>
						))}
					</span>
					<span className="tb-div" />
					<button
						type="button"
						className={`tb-chip${autoArrange ? " on" : ""}`}
						title="Keep steps on one left→right rail, in execution order"
						onClick={() => setAutoArrange((v) => !v)}
					>
						<svg
							width="11"
							height="11"
							viewBox="0 0 14 14"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.3"
							strokeLinecap="round"
							aria-hidden="true"
						>
							<path d="M2 7h10M2 3.5h6M2 10.5h6" />
						</svg>
						auto-arrange
					</button>
					<button type="button" className="tb-save" onClick={save} disabled={!dirty}>
						{dirty ? "Save" : "Saved"}
					</button>
				</div>
			)}

			<aside className="dock">
				<div className="dock-head">
					<select value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Project" title={repoInfo?.path}>
						{repos.map((r) => (
							<option key={r.name} value={r.name}>
								{r.name}
								{r.isDefault ? " (default)" : ""}
							</option>
						))}
					</select>
					<button
						type="button"
						className="dock-plus"
						title="Add a project from a directory on this machine"
						disabled={picking}
						onClick={addProject}
					>
						{picking ? "…" : "+"}
					</button>
					<button
						type="button"
						className="dock-plus"
						title="Project settings — name, base branch, routing label, default"
						disabled={!repoInfo}
						onClick={() => setEditingProject(true)}
					>
						⚙
					</button>
					<button
						type="button"
						className="dock-plus dock-remove"
						title={
							repoInfo?.source === "config"
								? "Defined in agent.config.ts — remove it there"
								: "Remove this project from the agent (the repo on disk is left untouched)"
						}
						aria-label="Remove project"
						disabled={!repoInfo || repoInfo.source === "config"}
						onClick={removeProject}
					>
						✕
					</button>
				</div>
				{repoInfo && (
					<div className="dock-meta" title={repoInfo.path}>
						base <code>{repoInfo.baseBranch}</code>
						{repoInfo.routingLabel ? (
							<span className="badge badge-global" title="Linear issues with this label route to this repo">
								label: {repoInfo.routingLabel}
							</span>
						) : (
							!repoInfo.isDefault && (
								<span
									className="badge badge-shadowed"
									title="No routing label — issues can only reach this repo as the default"
								>
									no label
								</span>
							)
						)}
						{repoInfo.contract && "error" in repoInfo.contract && (
							<span className="badge badge-error">broken contract</span>
						)}
						{repoInfo.contract && "directives" in repoInfo.contract && (
							<span className="badge badge-project">
								contract: {repoInfo.contract.directives.join(", ") || "commit only"}
							</span>
						)}
					</div>
				)}

				<div className="dock-label">Flows</div>
				<ul className="flow-list">
					{flows.map((f) => (
						<li key={f.label}>
							<button
								type="button"
								className={current?.label === f.label ? "active" : ""}
								title={f.description || f.label}
								onClick={() => openFlow(f.label)}
							>
								<strong>{f.label}</strong>
								{f.error && <span className="badge badge-error">broken</span>}
							</button>
						</li>
					))}
					{flows.length === 0 && <li className="hint">No flows yet — label handlers from agent.config.ts apply.</li>}
				</ul>
				<div className="new-flow">
					<input
						value={newLabel}
						placeholder="+ new label…"
						aria-label="New flow label"
						onChange={(e) => setNewLabel(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && createFlow()}
					/>
				</div>
				{current && (
					<button type="button" className="dock-delete" onClick={removeFlow}>
						delete flow “{current.label}”
					</button>
				)}

				<div className="dock-label">
					Skills · {skillQuery.trim() ? `${visibleSkills.length}/${skills.length}` : skills.length}
				</div>
				<div className="search">
					<SearchIcon />
					<input
						value={skillQuery}
						placeholder="Search skills"
						aria-label="Search skills"
						onChange={(e) => setSkillQuery(e.target.value)}
						onKeyDown={(e) => e.key === "Escape" && setSkillQuery("")}
					/>
					{skillQuery && (
						<button type="button" className="search-clear" title="Clear search" onClick={() => setSkillQuery("")}>
							✕
						</button>
					)}
				</div>
				<ul className="skill-list">
					{visibleSkills.map((s) => (
						<li key={`${s.source}:${s.name}`}>
							<button
								type="button"
								className="skill-row"
								title={`${s.description}${s.shadows ? ` (overrides ${s.shadows})` : ""} — click to view`}
								onClick={() =>
									api
										.skillContent(repo, s.name)
										.then(setSkillView)
										.catch((err) => say(String(err), "error"))
								}
							>
								<code>{s.name}</code>
								<span className={`src-tag src-${s.source}`}>{s.source === "global" ? "~/.claude" : s.source}</span>
							</button>
						</li>
					))}
					{visibleSkills.length === 0 && skills.length > 0 && (
						<li className="hint">No skills match “{skillQuery.trim()}”.</li>
					)}
				</ul>
			</aside>

			{current && (selectedNode || selectedEdge) && (
				<aside className="panel">
					{selectedNode && (
						<NodeInspector
							def={selectedNode.data.def}
							skills={skills}
							onChange={(def) => updateNodeDef(selectedNode.id, def)}
							onDelete={deleteSelected}
							onClose={closeInspector}
						/>
					)}
					{!selectedNode && selectedEdge && (
						<EdgeInspector
							condition={((selectedEdge.data as { condition?: string } | undefined)?.condition ?? "") as string}
							onChange={(c) => updateEdgeCondition(selectedEdge.id, c)}
							onDelete={deleteSelected}
							onClose={closeInspector}
						/>
					)}
				</aside>
			)}

			{current && (
				<div className="hintbar">
					<span className={autoArrange ? "hb-accent" : ""}>auto-arrange: {autoArrange ? "on" : "off"}</span>
					<span className="hb-sep">·</span>
					<span>{autoArrange ? "new steps snap to the rail" : "drag freely, connect by port"}</span>
					<span className="hb-sep">·</span>
					<span>⌘K add step</span>
					<span className="hb-sep">·</span>
					<span className="hb-strong">executes left → right</span>
				</div>
			)}

			{cmdOpen && current && <CommandMenu onPick={addNode} onClose={() => setCmdOpen(false)} />}

			{addingProject && (
				<AddProject initialPath={pickedPath} onClose={() => setAddingProject(false)} onAdded={onProjectAdded} />
			)}

			{skillView && (
				<div
					className="modal-backdrop"
					onClick={() => setSkillView(null)}
					onKeyDown={(e) => e.key === "Escape" && setSkillView(null)}
				>
					<div
						className="modal skill-modal"
						onClick={(e) => e.stopPropagation()}
						role="dialog"
						aria-label={skillView.name}
					>
						<header>
							<h2>
								<code>{skillView.name}</code>
								<span className={`src-tag src-${skillView.source}`}>
									{skillView.source === "global" ? "~/.claude" : skillView.source}
								</span>
							</h2>
							<button type="button" onClick={() => setSkillView(null)}>
								✕
							</button>
						</header>
						<p className="hint skill-path">{skillView.path}</p>
						<pre className="skill-content">{skillView.content}</pre>
					</div>
				</div>
			)}

			{editingProject && repoInfo && (
				<ProjectSettings
					repo={repoInfo}
					onClose={() => setEditingProject(false)}
					onSaved={(newName) => {
						setEditingProject(false);
						api
							.repos()
							.then((list) => {
								setRepos(list);
								setRepo(newName);
								say("Project settings saved");
							})
							.catch((err) => say(String(err), "error"));
					}}
					onRemoved={() => onProjectRemoved(repoInfo.name)}
				/>
			)}

			{status && <div className={`status status-${status.kind}`}>{status.text}</div>}
		</div>
	);
}
