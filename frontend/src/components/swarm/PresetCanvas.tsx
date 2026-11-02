import { useEffect, useId, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { parseDocument, isMap, isScalar, isSeq, type Document as YamlDocument, type YAMLMap, type YAMLSeq } from "yaml";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";

// Visual DAG editor for one preset's YAML. The yaml (eemeli) Document/CST keeps
// comments, key order, scalars and unknown fields: every interaction mutates
// only the corresponding node via localized setIn/deleteIn calls, so
// String(doc) re-renders the full document without lossy re-serialization.
// Anything that cannot be edited faithfully (parse errors, unexpected shape,
// aliases) blocks the visual mode with an explanation instead of guessing.

export interface CanvasIssue {
  taskId: string;
  key: string;
  source: string;
}

interface PresetCanvasProps {
  yamlText: string;
  onYamlChange: (text: string) => void;
  onFallbackToYaml?: () => void;
  toolOptions?: string[];
  skillOptions?: string[];
}

interface AgentEntry {
  index: number;
  id: string;
  role: string | null;
  systemPrompt: string | null;
  tools: string[] | null;
  skills: string[] | null;
  limits: { maxIterations: number | null; timeoutSeconds: number | null; maxRetries: number | null };
  referencedBy: string[];
}

interface TaskEntry {
  index: number;
  id: string;
  agentId: string | null;
  prompt: string | null;
  dependsOn: string[];
  // raw !== null means the original YAML used a single string input_from; the
  // visual editor keeps that exact shape instead of converting it to a mapping.
  inputFrom: { pairs: Array<{ key: string; source: string }>; raw: string | null; unsupported: boolean } | null;
}

interface CanvasModel {
  agents: AgentEntry[];
  tasks: TaskEntry[];
  blockedReason: "parse" | "structure" | "alias" | null;
}

function scalarText(node: unknown): string | null {
  return isScalar(node) && (typeof node.value === "string" || typeof node.value === "number" || typeof node.value === "boolean")
    ? String(node.value)
    : null;
}

function scalarNumber(node: unknown): number | null {
  return isScalar(node) && typeof node.value === "number" && Number.isFinite(node.value) ? node.value : null;
}

function readStringList(map: YAMLMap, key: string): string[] | null {
  const value = map.get(key, true);
  if (value === undefined) return null;
  if (!isSeq(value)) return null;
  const items = value.items.map((item) => scalarText(item)).filter((item): item is string => item !== null);
  return items.length === value.items.length ? items : null;
}

function hasAlias(node: unknown, seen: Set<object>): boolean {
  if (!node || typeof node !== "object") return false;
  if (seen.has(node)) return false;
  seen.add(node);
  if ((node as { type?: string }).type === "ALIAS") return true;
  const items = (node as { items?: unknown[] }).items;
  if (Array.isArray(items)) return items.some((item) => hasAlias(item, seen) || hasAlias((item as { value?: unknown }).value, seen));
  const value = (node as { value?: unknown }).value;
  if (value && typeof value === "object") return hasAlias(value, seen);
  const key = (node as { key?: unknown }).key;
  if (key && typeof key === "object") return hasAlias(key, seen);
  return false;
}

function readInputFrom(map: YAMLMap): TaskEntry["inputFrom"] {
  const value = map.get("input_from", true);
  if (value === undefined) return null;
  if (isScalar(value) && typeof value.value === "string") {
    return { pairs: [{ key: "", source: value.value }], raw: value.value, unsupported: false };
  }
  if (isMap(value)) {
    const pairs: Array<{ key: string; source: string }> = [];
    let complete = true;
    for (const pair of value.items) {
      const key = scalarText(pair.key);
      const source = scalarText(pair.value);
      if (key === null || source === null) {
        complete = false;
        break;
      }
      pairs.push({ key, source });
    }
    if (complete) return { pairs, raw: null, unsupported: false };
  }
  return { pairs: [], raw: null, unsupported: true };
}

function deriveModel(doc: YamlDocument): CanvasModel {
  if (doc.errors.length > 0 || doc.contents === null) return { agents: [], tasks: [], blockedReason: "parse" };
  if (!isMap(doc.contents)) return { agents: [], tasks: [], blockedReason: "structure" };
  const seen: Set<object> = new Set();
  if (hasAlias(doc.get("tasks", true), seen) || hasAlias(doc.get("agents", true), seen)) {
    return { agents: [], tasks: [], blockedReason: "alias" };
  }
  const tasksSeq = doc.get("tasks");
  const agentsSeq = doc.get("agents");
  if (tasksSeq !== undefined && !isSeq(tasksSeq)) return { agents: [], tasks: [], blockedReason: "structure" };
  if (agentsSeq !== undefined && !isSeq(agentsSeq)) return { agents: [], tasks: [], blockedReason: "structure" };

  const agents: AgentEntry[] = [];
  if (isSeq(agentsSeq)) {
    const seenAgentIds = new Set<string>();
    for (let index = 0; index < agentsSeq.items.length; index += 1) {
      const item = agentsSeq.items[index];
      if (!isMap(item)) return { agents: [], tasks: [], blockedReason: "structure" };
      const id = scalarText(item.get("id", true));
      if (id === null || id === "" || seenAgentIds.has(id)) return { agents: [], tasks: [], blockedReason: "structure" };
      seenAgentIds.add(id);
      agents.push({
        index,
        id,
        role: scalarText(item.get("role", true)),
        systemPrompt: scalarText(item.get("system_prompt", true)),
        tools: readStringList(item, "tools"),
        skills: readStringList(item, "skills"),
        // Source presets keep limits flat on the agent map (_preset_definitions
        // reads these keys); a nested limits map would be ignored by runtime.
        limits: {
          maxIterations: scalarNumber(item.get("max_iterations", true)),
          timeoutSeconds: scalarNumber(item.get("timeout_seconds", true)),
          maxRetries: scalarNumber(item.get("max_retries", true)),
        },
        referencedBy: [],
      });
    }
  }
  const agentIds = new Set(agents.map((agent) => agent.id));

  const tasks: TaskEntry[] = [];
  if (isSeq(tasksSeq)) {
    const ids = new Set<string>();
    for (let index = 0; index < tasksSeq.items.length; index += 1) {
      const item = tasksSeq.items[index];
      if (!isMap(item)) return { agents: [], tasks: [], blockedReason: "structure" };
      const id = scalarText(item.get("id", true));
      if (id === null || id === "" || ids.has(id)) return { agents: [], tasks: [], blockedReason: "structure" };
      ids.add(id);
      const agentId = scalarText(item.get("agent_id", true));
      if (agentId !== null && agentIds.has(agentId)) agents.find((agent) => agent.id === agentId)?.referencedBy.push(id);
      const dependsValue = item.get("depends_on", true);
      const dependsOn = isSeq(dependsValue) ? dependsValue.items.map((dep) => scalarText(dep)).filter((dep): dep is string => dep !== null) : [];
      tasks.push({ index, id, agentId, prompt: scalarText(item.get("prompt_template", true)), dependsOn, inputFrom: readInputFrom(item) });
    }
  }
  return { agents, tasks, blockedReason: null };
}

function upstreamOf(tasks: TaskEntry[], taskId: string): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const stack = [...(byId.get(taskId)?.dependsOn ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(byId.get(current)?.dependsOn ?? []));
  }
  return seen;
}

// Cycle-safe layout: a `visiting` set breaks dependency cycles instead of
// recursing forever, so cyclic presets (rejected later by validation) render
// with fallback columns rather than crashing the page.
function computeLayers(tasks: TaskEntry[]): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    const memoized = layers.get(id);
    if (memoized !== undefined) return memoized;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const target = byId.get(id);
    const value = !target || target.dependsOn.length === 0
      ? 0
      : 1 + Math.max(...target.dependsOn.map((dep) => layerOf(dep)));
    visiting.delete(id);
    layers.set(id, value);
    return value;
  };
  for (const task of tasks) layerOf(task.id);
  return layers;
}

function findIssues(tasks: TaskEntry[]): CanvasIssue[] {
  const issues: CanvasIssue[] = [];
  for (const task of tasks) {
    if (!task.inputFrom) continue;
    const upstream = upstreamOf(tasks, task.id);
    for (const pair of task.inputFrom.pairs) {
      if (!upstream.has(pair.source)) issues.push({ taskId: task.id, key: pair.key, source: pair.source });
    }
  }
  return issues;
}

// Pure derivation so parents (including the YAML-only mode, where the canvas
// is not mounted) can gate Save on the same non-upstream input_from check.
export function deriveGraphIssues(yamlText: string): CanvasIssue[] {
  const model = deriveModel(parseDocument(yamlText));
  return model.blockedReason === null ? findIssues(model.tasks) : [];
}

function uniqueId(existing: string[], prefix: string): string {
  const used = new Set(existing);
  let counter = 1;
  while (used.has(`${prefix}-${counter}`)) counter += 1;
  return `${prefix}-${counter}`;
}

const NEW_PRESET_TEMPLATE = "name: new_preset\ndescription: \"\"\nagents:\n  - id: analyst\n    role: \"\"\n    system_prompt: \"\"\ntasks:\n  - id: task-1\n    agent_id: analyst\n    depends_on: []\n";

type TaskNodeData = {
  taskId: string;
  agentId: string | null;
  agentRole: string | null;
  prompt: string | null;
  dependencyCount: number;
  isIssue: boolean;
  selected: boolean;
  otherTaskIds: string[];
  onSelect: () => void;
  onRemove: () => void;
  onAddDependency: (dependencyId: string) => void;
};

type TaskNodeType = Node<TaskNodeData, "task">;

function TaskNodeView({ data }: NodeProps<TaskNodeType>) {
  const { t } = useTranslation();
  const [dependencyMenuOpen, setDependencyMenuOpen] = useState(false);
  const selectId = useId();
  const issueBadge = data.isIssue ? <span className="ms-1 rounded bg-warning/15 px-1 text-[10px] font-semibold text-warning">!</span> : null;

  return (
    <div className={`w-56 rounded-lg border bg-card text-foreground shadow-md ${data.selected ? "border-primary ring-2 ring-primary/40" : "border-border/70"} ${data.isIssue ? "border-warning/60" : ""}`}>
      <Handle type="target" position={Position.Left} isConnectable />
      <Handle type="source" position={Position.Right} isConnectable />
      <div className="flex items-center justify-between gap-1 border-b border-border/60 px-2.5 py-1.5">
        <span className="truncate font-mono text-xs font-semibold">{data.taskId}{issueBadge}</span>
        <span className="shrink-0 rounded border border-border/60 px-1.5 text-[10px] text-muted-foreground" title={t("swarmTeams.agentLabel")}>{data.agentId ?? "?"}</span>
      </div>
      {data.prompt && <p className="line-clamp-2 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground">{data.prompt}</p>}
      <div className="flex flex-wrap items-center gap-1 border-t border-border/60 px-2 py-1.5">
        <button type="button" aria-pressed={data.selected} aria-label={`${t("swarmTeams.selectTask")}: ${data.taskId}`} onClick={data.onSelect} className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
          {t("swarmTeams.selectTask")}
        </button>
        {data.otherTaskIds.length > 0 && (
          <span className="relative">
            <button type="button" aria-expanded={dependencyMenuOpen} aria-controls={`${selectId}-menu`} onClick={() => setDependencyMenuOpen((open) => !open)} className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
              {t("swarmTeams.addDependency")}
            </button>
            {dependencyMenuOpen && (
              <ul id={`${selectId}-menu`} className="absolute start-0 top-full z-10 mt-1 max-h-40 w-40 overflow-auto rounded-md border border-border/70 bg-popover p-1 shadow-lg">
                {data.otherTaskIds.map((otherId) => (
                  <li key={otherId}>
                    <button type="button" onClick={() => { data.onAddDependency(otherId); setDependencyMenuOpen(false); }} className="w-full truncate rounded px-2 py-1 text-start font-mono text-[11px] hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                      {otherId}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </span>
        )}
        <button type="button" onClick={data.onRemove} className="ms-auto rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-warning hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40" aria-label={`${t("swarmTeams.removeTask")}: ${data.taskId}`}>
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ValueListEditor({ label, values, options, onChange, inputId }: {
  label: string;
  values: string[] | null;
  options: string[] | undefined;
  onChange: (values: string[]) => void;
  inputId: string;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const current = values ?? [];
  const commit = () => {
    const value = draft.trim();
    if (!value || current.includes(value)) {
      setDraft("");
      return;
    }
    onChange([...current, value]);
    setDraft("");
  };
  return (
    <div>
      <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {current.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {current.map((value) => (
            <li key={value} className="flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-2 py-0.5 font-mono text-xs">
              {value}
              <button type="button" onClick={() => onChange(current.filter((item) => item !== value))} aria-label={`${t("swarmTeams.removeValue")}: ${value}`} className="rounded text-muted-foreground hover:text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40">
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          id={inputId}
          list={`${inputId}-options`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }}
          className="min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 py-1.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        />
        {options && (
          <datalist id={`${inputId}-options`}>
            {options.map((option) => <option key={option} value={option} />)}
          </datalist>
        )}
        <button type="button" onClick={commit} className="rounded-md border border-border/60 px-2 py-1.5 text-xs font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" aria-label={t("swarmTeams.addValue")}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function PresetCanvas({ yamlText, onYamlChange, onFallbackToYaml, toolOptions, skillOptions }: PresetCanvasProps) {
  const { t } = useTranslation();
  const taskListId = useId();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});

  const model = useMemo(() => deriveModel(parseDocument(yamlText)), [yamlText]);
  const issues = useMemo(() => findIssues(model.tasks), [model.tasks]);

  useEffect(() => {
    if (selectedTaskId && !model.tasks.some((task) => task.id === selectedTaskId)) setSelectedTaskId(null);
    if (selectedAgentId && !model.agents.some((agent) => agent.id === selectedAgentId)) setSelectedAgentId(null);
  }, [model, selectedTaskId, selectedAgentId]);

  const mutate = (fn: (doc: YamlDocument) => void) => {
    const doc = parseDocument(yamlText);
    if (doc.errors.length > 0 || !isMap(doc.contents)) return;
    fn(doc);
    onYamlChange(String(doc));
  };

  const applyMutation = (fn: (doc: YamlDocument, tasksSeq: YAMLSeq, agentsSeq: YAMLSeq | null) => void) =>
    mutate((doc) => {
      let tasksSeq: YAMLSeq | undefined = doc.get("tasks") as YAMLSeq | undefined;
      if (!isSeq(tasksSeq)) {
        // A missing tasks key behaves like an empty list elsewhere in the
        // canvas, so creating it here keeps addTask consistent with the model.
        if (tasksSeq !== undefined) return;
        doc.set("tasks", doc.createNode([]));
        tasksSeq = doc.get("tasks") as YAMLSeq;
      }
      const agentsSeq = doc.get("agents");
      fn(doc, tasksSeq, isSeq(agentsSeq) ? agentsSeq : null);
    });

  const taskByIndex = (index: number, tasksSeq: YAMLSeq) => (isMap(tasksSeq.items[index]) ? (tasksSeq.items[index] as YAMLMap) : null);
  const agentByIndex = (index: number, agentsSeq: YAMLSeq | null) => (agentsSeq && isMap(agentsSeq.items[index]) ? (agentsSeq.items[index] as YAMLMap) : null);

  const setTaskField = (taskId: string, key: string, value: unknown) =>
    applyMutation((doc, tasksSeq) => {
      const task = model.tasks.find((entry) => entry.id === taskId);
      if (!task || !taskByIndex(task.index, tasksSeq)) return;
      if (value === null) doc.deleteIn(["tasks", task.index, key]);
      else doc.setIn(["tasks", task.index, key], value);
    });

  const setAgentField = (agentId: string, key: string, value: unknown) =>
    applyMutation((doc, _tasksSeq, agentsSeq) => {
      const agent = model.agents.find((entry) => entry.id === agentId);
      if (!agent || !agentByIndex(agent.index, agentsSeq)) return;
      if (value === null) doc.deleteIn(["agents", agent.index, key]);
      else doc.setIn(["agents", agent.index, key], value);
    });

  const setAgentLimit = (agentId: string, key: string, raw: string) => {
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    applyMutation((doc, _tasksSeq, agentsSeq) => {
      const agent = model.agents.find((entry) => entry.id === agentId);
      if (!agent || !agentByIndex(agent.index, agentsSeq)) return;
      // Flat key on the agent map, matching what _preset_definitions reads.
      if (value === null || !Number.isFinite(value)) doc.deleteIn(["agents", agent.index, key]);
      else doc.setIn(["agents", agent.index, key], value);
    });
  };

  const setTaskDependsOn = (taskId: string, list: string[]) =>
    applyMutation((doc, tasksSeq) => {
      const task = model.tasks.find((entry) => entry.id === taskId);
      const taskMap = task && taskByIndex(task.index, tasksSeq);
      if (!task || !taskMap) return;
      const seq = taskMap.get("depends_on", true);
      if (!isSeq(seq)) {
        doc.setIn(["tasks", task.index, "depends_on"], doc.createNode(list));
        return;
      }
      // Mutate items in place so per-item comments on surviving entries stay
      // attached; replacing the whole sequence would drop them.
      const missing = new Set(list);
      for (let i = seq.items.length - 1; i >= 0; i -= 1) {
        const id = scalarText(seq.items[i]);
        if (id !== null && missing.has(id)) missing.delete(id);
        else seq.delete(i);
      }
      for (const id of list) if (missing.has(id)) seq.add(doc.createNode(id));
    });

  const addTask = () =>
    applyMutation((doc, tasksSeq, agentsSeq) => {
      const newId = uniqueId(model.tasks.map((task) => task.id), "task");
      const newAgentId = model.agents[0]?.id ?? uniqueId(model.agents.map((agent) => agent.id), "agent");
      tasksSeq.add(doc.createNode({ id: newId, agent_id: newAgentId, depends_on: [] }));
      if (!agentsSeq || agentsSeq.items.length === 0) {
        if (agentsSeq === null) doc.set("agents", doc.createNode([{ id: newAgentId }]));
        else agentsSeq.add(doc.createNode({ id: newAgentId }));
      }
      setSelectedTaskId(newId);
    });

  const removeTask = (taskId: string) =>
    applyMutation((doc, tasksSeq) => {
      const task = model.tasks.find((entry) => entry.id === taskId);
      if (!task || !tasksSeq) return;
      // Clean dangling depends_on references so the document stays valid;
      // each change still touches only that task's depends_on items, keeping
      // comments on surviving entries.
      for (const other of model.tasks) {
        if (other.id !== taskId && other.dependsOn.includes(taskId)) {
          const otherMap = taskByIndex(other.index, tasksSeq);
          const seq = otherMap ? otherMap.get("depends_on", true) : null;
          if (!isSeq(seq)) continue;
          for (let i = seq.items.length - 1; i >= 0; i -= 1) {
            if (scalarText(seq.items[i]) === taskId) seq.delete(i);
          }
        }
      }
      doc.deleteIn(["tasks", task.index]);
      setSelectedTaskId(null);
    });

  const addAgent = () =>
    applyMutation((doc, _tasksSeq, agentsSeq) => {
      const newId = uniqueId(model.agents.map((agent) => agent.id), "agent");
      if (agentsSeq === null) doc.set("agents", doc.createNode([{ id: newId }]));
      else agentsSeq.add(doc.createNode({ id: newId }));
      setSelectedAgentId(newId);
    });

  const removeAgent = (agentId: string) =>
    applyMutation((doc, _tasksSeq, agentsSeq) => {
      const agent = model.agents.find((entry) => entry.id === agentId);
      if (!agent || agent.referencedBy.length > 0 || !agentsSeq) return;
      doc.deleteIn(["agents", agent.index]);
      setSelectedAgentId(null);
    });

  const addDependency = (taskId: string, dependencyId: string) => {
    const task = model.tasks.find((entry) => entry.id === taskId);
    if (!task || task.dependsOn.includes(dependencyId) || taskId === dependencyId) return;
    setTaskDependsOn(taskId, [...task.dependsOn, dependencyId]);
  };

  const removeDependency = (taskId: string, dependencyId: string) => {
    const task = model.tasks.find((entry) => entry.id === taskId);
    if (!task) return;
    setTaskDependsOn(taskId, task.dependsOn.filter((item) => item !== dependencyId));
  };

  const setInputPair = (taskId: string, pairIndex: number, patch: Partial<{ key: string; source: string }>) => {
    const task = model.tasks.find((entry) => entry.id === taskId);
    if (!task?.inputFrom) return;
    if (task.inputFrom.raw !== null) {
      // Preserve the original single-string shape of input_from.
      if (patch.source !== undefined) setTaskField(taskId, "input_from", patch.source);
      return;
    }
    applyMutation((_doc, tasksSeq) => {
      const taskMap = taskByIndex(task.index, tasksSeq);
      const map = taskMap ? taskMap.get("input_from", true) : null;
      const pair = task.inputFrom?.pairs[pairIndex];
      if (!isMap(map) || !pair) return;
      const entry = map.items.find((item) => scalarText(item.key) === pair.key && scalarText(item.value) === pair.source);
      if (!entry) return;
      // Mutate the existing scalar nodes so comments stay attached to this
      // pair and every other pair; rebuilding the map would drop them all.
      if (patch.key !== undefined && isScalar(entry.key)) entry.key.value = patch.key || "input";
      if (patch.source !== undefined && isScalar(entry.value)) entry.value.value = patch.source;
    });
  };

  const removeInputPair = (taskId: string, pairIndex: number) => {
    const task = model.tasks.find((entry) => entry.id === taskId);
    if (!task?.inputFrom) return;
    if (task.inputFrom.raw !== null) {
      setTaskField(taskId, "input_from", null);
      return;
    }
    applyMutation((doc, tasksSeq) => {
      const taskMap = taskByIndex(task.index, tasksSeq);
      const map = taskMap ? taskMap.get("input_from", true) : null;
      const pair = task.inputFrom?.pairs[pairIndex];
      if (!isMap(map) || !pair) return;
      // Removing the last mapping drops the key entirely; otherwise splice
      // only that pair so comments on the surviving ones survive.
      if (map.items.length === 1) doc.deleteIn(["tasks", task.index, "input_from"]);
      else map.items.splice(pairIndex, 1);
    });
  };

  const addInputPair = (taskId: string) => {
    const task = model.tasks.find((entry) => entry.id === taskId);
    if (!task || task.inputFrom?.unsupported || task.inputFrom?.raw !== null && task.inputFrom !== null) return;
    const upstream = [...upstreamOf(model.tasks, taskId)];
    if (upstream.length === 0) return;
    // First free input-N key: counting pairs would collide with gaps
    // (input-1 + input-3 would reuse input-3 and overwrite it).
    const newKey = uniqueId(task.inputFrom?.pairs.map((pair) => pair.key) ?? [], "input");
    applyMutation((doc, tasksSeq) => {
      const taskMap = taskByIndex(task.index, tasksSeq);
      if (!taskMap) return;
      // Nested setIn appends one pair to an existing input_from map (or
      // creates the map) without rebuilding it, so comments survive.
      doc.setIn(["tasks", task.index, "input_from", newKey], upstream[0] as string);
    });
  };

  const relinkIssue = (issue: CanvasIssue) => addDependency(issue.taskId, issue.source);
  const clearIssue = (issue: CanvasIssue) => {
    const task = model.tasks.find((entry) => entry.id === issue.taskId);
    if (!task?.inputFrom) return;
    if (task.inputFrom.raw !== null) {
      setTaskField(issue.taskId, "input_from", null);
      return;
    }
    applyMutation((doc, tasksSeq) => {
      const taskMap = taskByIndex(task.index, tasksSeq);
      const map = taskMap ? taskMap.get("input_from", true) : null;
      if (!isMap(map)) return;
      const victims = map.items.filter((item) => scalarText(item.key) === issue.key && scalarText(item.value) === issue.source);
      if (victims.length === 0) return;
      if (victims.length === map.items.length) doc.deleteIn(["tasks", task.index, "input_from"]);
      else map.items = map.items.filter((item) => !victims.includes(item));
    });
  };

  const layers = useMemo(() => computeLayers(model.tasks), [model.tasks]);

  const flowNodes: Node[] = model.tasks.map((task) => {
    const sameLayer = model.tasks.filter((entry) => layers.get(entry.id) === layers.get(task.id));
    return {
      id: task.id,
      type: "task" as const,
      position: positions[task.id] ?? { x: (layers.get(task.id) ?? 0) * 300, y: sameLayer.findIndex((entry) => entry.id === task.id) * 130 },
      selected: selectedTaskId === task.id,
      data: {
        taskId: task.id,
        agentId: task.agentId,
        agentRole: model.agents.find((agent) => agent.id === task.agentId)?.role ?? null,
        prompt: task.prompt,
        dependencyCount: task.dependsOn.length,
        isIssue: issues.some((issue) => issue.taskId === task.id),
        selected: selectedTaskId === task.id,
        otherTaskIds: model.tasks.filter((entry) => entry.id !== task.id).map((entry) => entry.id),
        onSelect: () => { setSelectedTaskId(task.id); setSelectedAgentId(task.agentId); },
        onRemove: () => removeTask(task.id),
        onAddDependency: (dependencyId: string) => addDependency(task.id, dependencyId),
      },
    };
  });

  const flowEdges: Edge[] = model.tasks.flatMap((task) =>
    task.dependsOn.map((dependencyId) => ({
      id: `e-${dependencyId}->${task.id}`,
      source: dependencyId,
      target: task.id,
    })),
  );

  const selectedTask = model.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const inspectorAgent = selectedAgentId
    ? model.agents.find((agent) => agent.id === selectedAgentId) ?? null
    : selectedTask?.agentId
      ? model.agents.find((agent) => agent.id === selectedTask.agentId) ?? null
      : null;

  if (model.blockedReason !== null) {
    const reasonKey = model.blockedReason === "parse" ? "swarmTeams.canvasUnavailableParse" : model.blockedReason === "alias" ? "swarmTeams.canvasUnavailableAlias" : "swarmTeams.canvasUnavailableStructure";
    return (
      <section role="alert" className="rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm">
        <p className="font-medium text-warning">{t("swarmTeams.canvasUnavailable")}</p>
        <p className="mt-1 text-muted-foreground">{t(reasonKey)}</p>
        <p className="mt-1 text-muted-foreground">{t("swarmTeams.canvasUnavailableHint")}</p>
        {onFallbackToYaml && (
          <button type="button" onClick={onFallbackToYaml} className="mt-3 rounded-md border border-border/60 px-3 py-2 text-sm font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            {t("swarmTeams.useYamlEditor")}
          </button>
        )}
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4 xl:flex-row">
      <div className="min-w-0 flex-1">
        {(issues.length > 0 || model.tasks.length === 0) && (
          <div className="mb-3 space-y-3">
            {issues.length > 0 && (
              <div role="alert" aria-live="polite" className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
                <p className="font-medium text-warning">{t("swarmTeams.graphConflict")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("swarmTeams.graphConflictHint")}</p>
                <ul className="mt-2 space-y-2">
                  {issues.map((issue) => {
                    const sourceExists = model.tasks.some((entry) => entry.id === issue.source);
                    return (
                      <li key={`${issue.taskId}:${issue.key}:${issue.source}`} className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-background p-2 text-xs">
                        <span className="font-mono">{issue.taskId}</span>
                        <span aria-hidden="true">·</span>
                        <span className="text-muted-foreground">{t("swarmTeams.inputFrom")}: <span className="font-mono">{issue.source}</span></span>
                        {sourceExists ? (
                          <button type="button" onClick={() => relinkIssue(issue)} className="rounded-md border border-border/60 px-2 py-1 font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">{t("swarmTeams.relinkDependency")}</button>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">{t("swarmTeams.graphConflictMissingSource")}</span>
                        )}
                        <button type="button" onClick={() => clearIssue(issue)} className="rounded-md border border-border/60 px-2 py-1 font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">{t("swarmTeams.removeMapping")}</button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {model.tasks.length === 0 && <p role="status" className="rounded-lg border border-dashed border-border/70 p-3 text-center text-sm text-muted-foreground">{t("swarmTeams.canvasEmptyTasks")}</p>}
          </div>
        )}
        <div role="group" aria-label={t("swarmTeams.canvasLabel")} className="h-[32rem] overflow-hidden rounded-lg border border-border/70 bg-background">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={{ task: TaskNodeView }}
            onNodeClick={(_, node) => { setSelectedTaskId(node.id); const task = model.tasks.find((entry) => entry.id === node.id); setSelectedAgentId(task?.agentId ?? null); }}
            onNodeDragStop={(_, node) => setPositions((current) => ({ ...current, [node.id]: node.position }))}
            onConnect={(connection: Connection) => { if (connection.source && connection.target) addDependency(connection.target, connection.source); }}
            nodesDraggable
            nodesConnectable
            elementsSelectable
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} />
            <Controls showInteractive={false} position="bottom-right" />
          </ReactFlow>
        </div>
      </div>

      <aside aria-label={t("swarmTeams.canvasInspector")} className="w-full shrink-0 rounded-lg border border-border/70 bg-card p-4 xl:w-80">
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" onClick={addTask} className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 px-2.5 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />{t("swarmTeams.addTask")}
          </button>
          <button type="button" onClick={addAgent} aria-pressed={inspectorAgent !== null && selectedTask === null} className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-xs font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />{t("swarmTeams.addAgent")}
          </button>
        </div>

        {!selectedTask && !inspectorAgent && <p className="text-sm text-muted-foreground">{t("swarmTeams.selectTaskHint")}</p>}

        {selectedTask && (
          <section aria-label={t("swarmTeams.taskDetails")} className="mb-4 rounded-md border border-border/60 bg-muted/10 p-3">
            <h3 className="break-all font-mono text-sm font-semibold">{selectedTask.id}</h3>
            <div className="mt-3">
              <label htmlFor={`${taskListId}-prompt`} className="mb-1 block text-xs font-medium text-muted-foreground">{t("swarmTeams.promptTemplate")}</label>
              <textarea
                id={`${taskListId}-prompt`}
                rows={4}
                value={selectedTask.prompt ?? ""}
                onChange={(event) => setTaskField(selectedTask.id, "prompt_template", event.target.value === "" ? null : event.target.value)}
                className="w-full resize-y rounded-md border border-border/70 bg-background p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              />
            </div>

            <div className="mt-3">
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t("swarmTeams.dependsOn")}</h4>
              {selectedTask.dependsOn.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {selectedTask.dependsOn.map((dependencyId) => (
                    <li key={dependencyId} className="flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-2 py-0.5 font-mono text-xs">
                      {dependencyId}
                      <button type="button" onClick={() => removeDependency(selectedTask.id, dependencyId)} aria-label={`${t("swarmTeams.removeDependency")}: ${dependencyId}`} className="rounded text-muted-foreground hover:text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40">
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-muted-foreground">{t("swarmTeams.none")}</p>}
            </div>

            <div className="mt-3">
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t("swarmTeams.inputFrom")}</h4>
              {selectedTask.inputFrom && selectedTask.inputFrom.raw !== null ? (
                <p className="break-words rounded-md border border-border/60 bg-muted/20 p-2 font-mono text-xs text-muted-foreground">{String(selectedTask.inputFrom.raw)}</p>
              ) : selectedTask.inputFrom && selectedTask.inputFrom.pairs.length > 0 ? (
                <ul className="space-y-2">
                  {selectedTask.inputFrom.pairs.map((pair, pairIndex) => (
                    <li key={`${pair.key}:${pairIndex}`} className="flex flex-wrap items-center gap-1.5">
                      <label className="sr-only" htmlFor={`${taskListId}-in-key-${pairIndex}`}>{t("swarmTeams.inputKeyLabel")}</label>
                      <input
                        id={`${taskListId}-in-key-${pairIndex}`}
                        value={pair.key}
                        onChange={(event) => setInputPair(selectedTask.id, pairIndex, { key: event.target.value })}
                        className="w-28 rounded-md border border-border/70 bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      />
                      <label className="sr-only" htmlFor={`${taskListId}-in-src-${pairIndex}`}>{t("swarmTeams.inputFrom")}</label>
                      <select
                        id={`${taskListId}-in-src-${pairIndex}`}
                        value={pair.source}
                        onChange={(event) => setInputPair(selectedTask.id, pairIndex, { source: event.target.value })}
                        className="min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        {model.tasks.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}</option>)}
                        {!model.tasks.some((entry) => entry.id === pair.source) && <option value={pair.source}>{pair.source}</option>}
                      </select>
                      <button type="button" onClick={() => removeInputPair(selectedTask.id, pairIndex)} aria-label={`${t("swarmTeams.removeMapping")}: ${pair.key || pair.source}`} className="rounded text-muted-foreground hover:text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40">
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {upstreamOf(model.tasks, selectedTask.id).size > 0 && (
                <button type="button" onClick={() => addInputPair(selectedTask.id)} className="mt-2 rounded-md border border-border/60 px-2 py-1 text-xs font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                  {t("swarmTeams.addInputMapping")}
                </button>
              )}
            </div>
          </section>
        )}

        {(inspectorAgent || selectedTask) && (
          <section aria-label={t("swarmTeams.agentSection")} className="rounded-md border border-border/60 bg-muted/10 p-3">
            <div className="mb-3">
              <label htmlFor={`${taskListId}-agent`} className="mb-1 block text-xs font-medium text-muted-foreground">{t("swarmTeams.agentSelect")}</label>
              <div className="flex gap-2">
                <select
                  id={`${taskListId}-agent`}
                  value={inspectorAgent?.id ?? ""}
                  onChange={(event) => {
                    const agentId = event.target.value;
                    setSelectedAgentId(agentId === "__new__" ? null : agentId);
                    if (agentId === "__new__") addAgent();
                    else if (selectedTask && agentId) setTaskField(selectedTask.id, "agent_id", agentId);
                  }}
                  className="min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 py-1.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {model.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id}</option>)}
                  {inspectorAgent === null && selectedTask?.agentId && <option value={selectedTask.agentId}>{selectedTask.agentId}</option>}
                  <option value="__new__">{t("swarmTeams.newAgentOption")}</option>
                </select>
                <button
                  type="button"
                  onClick={() => inspectorAgent && removeAgent(inspectorAgent.id)}
                  disabled={!inspectorAgent || inspectorAgent.referencedBy.length > 0}
                  aria-describedby={inspectorAgent && inspectorAgent.referencedBy.length > 0 ? `${taskListId}-agent-blocked` : undefined}
                  className="rounded-md border border-border/60 px-2 py-1.5 text-xs font-medium text-warning hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40"
                >
                  {t("swarmTeams.removeAgent")}
                </button>
              </div>
              {inspectorAgent && inspectorAgent.referencedBy.length > 0 && (
                <p id={`${taskListId}-agent-blocked`} className="mt-1 text-[11px] text-muted-foreground">{t("swarmTeams.removeAgentBlocked")}</p>
              )}
            </div>

            {inspectorAgent && (
              <>
                <div className="mb-3">
                  <label htmlFor={`${taskListId}-role`} className="mb-1 block text-xs font-medium text-muted-foreground">{t("swarmTeams.roleLabel")}</label>
                  <input
                    id={`${taskListId}-role`}
                    value={inspectorAgent.role ?? ""}
                    onChange={(event) => setAgentField(inspectorAgent.id, "role", event.target.value === "" ? null : event.target.value)}
                    className="w-full rounded-md border border-border/70 bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  />
                </div>
                <div className="mb-3">
                  <label htmlFor={`${taskListId}-sysprompt`} className="mb-1 block text-xs font-medium text-muted-foreground">{t("swarmTeams.systemPromptLabel")}</label>
                  <textarea
                    id={`${taskListId}-sysprompt`}
                    rows={4}
                    value={inspectorAgent.systemPrompt ?? ""}
                    onChange={(event) => setAgentField(inspectorAgent.id, "system_prompt", event.target.value === "" ? null : event.target.value)}
                    className="w-full resize-y rounded-md border border-border/70 bg-background p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  />
                </div>
                <div className="mb-3">
                  <ValueListEditor
                    label={t("swarmTeams.tools")}
                    values={inspectorAgent.tools}
                    options={toolOptions}
                    onChange={(values) => setAgentField(inspectorAgent.id, "tools", values.length === 0 ? null : values)}
                    inputId={`${taskListId}-tools`}
                  />
                </div>
                <div className="mb-3">
                  <ValueListEditor
                    label={t("swarmTeams.skills")}
                    values={inspectorAgent.skills}
                    options={skillOptions}
                    onChange={(values) => setAgentField(inspectorAgent.id, "skills", values.length === 0 ? null : values)}
                    inputId={`${taskListId}-skills`}
                  />
                </div>
                <fieldset>
                  <legend className="mb-1 block text-xs font-medium text-muted-foreground">{t("swarmTeams.limits")}</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {([["max_iterations", "maxIterations", inspectorAgent.limits.maxIterations], ["timeout_seconds", "timeoutSeconds", inspectorAgent.limits.timeoutSeconds], ["max_retries", "maxRetries", inspectorAgent.limits.maxRetries]] as const).map(([yamlKey, labelKey, value]) => (
                      <div key={yamlKey}>
                        <label htmlFor={`${taskListId}-${yamlKey}`} className="mb-1 block text-[11px] text-muted-foreground">{t(`swarmTeams.${labelKey}`)}</label>
                        <input
                          id={`${taskListId}-${yamlKey}`}
                          type="number"
                          value={value ?? ""}
                          onChange={(event) => setAgentLimit(inspectorAgent.id, yamlKey, event.target.value)}
                          className="w-full rounded-md border border-border/70 bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        />
                      </div>
                    ))}
                  </div>
                </fieldset>
              </>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}

export { NEW_PRESET_TEMPLATE };
