import { useEffect, useId, useState } from "react";
import { AlertTriangle, Bot, RefreshCw, Users } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { api, type SwarmPresetCatalog, type SwarmPresetCatalogAgent, type SwarmPresetCatalogTask } from "@/lib/api";

type CatalogView = "teams" | "agents";

function formatValue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function AgentTitle({ agent }: { agent: SwarmPresetCatalogAgent }) {
  return (
    <div className="min-w-0">
      {agent.id && <p className="truncate font-mono text-sm font-semibold">{agent.id}</p>}
      {agent.role && <p className="mt-1 text-sm text-muted-foreground">{agent.role}</p>}
    </div>
  );
}

function TaskCard({ task, index, agents, t }: {
  task: SwarmPresetCatalogTask;
  index: number;
  agents: SwarmPresetCatalogAgent[];
  t: TFunction;
}) {
  const owner = task.agent_id ? agents.find((agent) => agent.id === task.agent_id) : undefined;
  const inputFrom = formatValue(task.input_from);

  return (
    <article className="relative ms-5 border-s border-border/70 pb-5 ps-6 last:border-s-transparent last:pb-0">
      <span className="absolute -start-3.5 top-0 flex h-7 w-7 items-center justify-center rounded-full border border-primary/30 bg-background font-mono text-xs text-primary">
        {String(index + 1).padStart(2, "0")}
      </span>
      <div className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {task.id && <h3 className="break-all font-mono text-sm font-semibold">{task.id}</h3>}
            {task.agent_id && (
              <div className="mt-2 flex items-start gap-2 text-sm">
                <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <div>
                  <span className="font-mono">{task.agent_id}</span>
                  {owner?.role && <span className="ms-2 text-muted-foreground">{owner.role}</span>}
                </div>
              </div>
            )}
          </div>
          {task.depends_on && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">{t("swarmTeams.dependsOn")}:</span>{" "}
              {task.depends_on.length ? task.depends_on.join(", ") : t("swarmTeams.none")}
            </p>
          )}
        </div>
        {task.prompt_template && (
          <div className="mt-4 border-t border-border/60 pt-3">
            <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("swarmTeams.promptTemplate")}</h4>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{task.prompt_template}</p>
          </div>
        )}
        {inputFrom && (
          <div className="mt-3 border-t border-border/60 pt-3">
            <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("swarmTeams.inputFrom")}</h4>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{inputFrom}</pre>
          </div>
        )}
      </div>
    </article>
  );
}

function AgentCard({ agent, preset, t }: {
  agent: SwarmPresetCatalogAgent;
  preset: SwarmPresetCatalog;
  t: TFunction;
}) {
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const instructionsId = useId();
  const limits = [
    agent.limits?.max_iterations != null && { label: t("swarmTeams.maxIterations"), value: agent.limits.max_iterations },
    agent.limits?.timeout_seconds != null && { label: t("swarmTeams.timeoutSeconds"), value: agent.limits.timeout_seconds },
    agent.limits?.max_retries != null && { label: t("swarmTeams.maxRetries"), value: agent.limits.max_retries },
  ].filter((limit): limit is { label: string; value: number } => Boolean(limit));

  const renderList = (label: string, values: string[] | undefined) => values !== undefined && (
    <div>
      <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</h4>
      {values.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {values.map((value, index) => <li key={`${value}:${index}`} className="rounded-md border border-border/60 bg-muted/40 px-2 py-1 font-mono text-xs">{value}</li>)}
        </ul>
      ) : <p className="text-sm text-muted-foreground">{t("swarmTeams.none")}</p>}
    </div>
  );

  return (
    <article className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
      <header className="flex items-start justify-between gap-3 border-b border-border/60 pb-4">
        <AgentTitle agent={agent} />
        <span className="shrink-0 rounded-md border border-primary/25 bg-primary/5 px-2 py-1 text-xs text-primary">{preset.title || preset.name}</span>
      </header>
      {agent.instructions && (
        <div className="mt-4">
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("swarmTeams.instructions")}</h4>
          <p id={instructionsId} className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${instructionsExpanded ? "" : "line-clamp-3"}`}>
            {agent.instructions}
          </p>
          <button type="button" aria-controls={instructionsId} aria-expanded={instructionsExpanded}
            onClick={() => setInstructionsExpanded((expanded) => !expanded)}
            className="mt-1 rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            {t(instructionsExpanded ? "swarmTeams.showLessInstructions" : "swarmTeams.showFullInstructions")}
          </button>
        </div>
      )}
      {(agent.tools !== undefined || agent.skills !== undefined || !!limits?.length) && (
        <div className="mt-4 grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-2">
          {renderList(t("swarmTeams.tools"), agent.tools)}
          {renderList(t("swarmTeams.skills"), agent.skills)}
          {!!limits?.length && (
            <div className="sm:col-span-2">
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("swarmTeams.limits")}</h4>
              <dl className="grid gap-2 sm:grid-cols-3">
                {limits.map(({ label, value }) => (
                  <div key={label} className="rounded-lg bg-muted/40 p-3">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-1 font-mono text-sm">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function SwarmTeams() {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<SwarmPresetCatalog[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<CatalogView>("teams");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.listSwarmPresetCatalog(controller.signal)
      .then(setCatalog)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("swarmTeams.unavailable"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload, t]);

  const presets = catalog ?? [];
  const agentCount = presets.reduce((sum, preset) => sum + (preset.agents?.length ?? 0), 0);

  return (
    <div className="min-h-screen p-4 md:p-6 lg:p-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="border-b border-border/60 pb-6">
          <div className="mb-3 inline-flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            {t("swarmTeams.catalog")}
          </div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{t("swarmTeams.title")}</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{t("swarmTeams.subtitle")}</p>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="group" className="inline-flex rounded-lg border border-border/60 bg-card p-1" aria-label={t("swarmTeams.areas")}>
            <button type="button" aria-pressed={view === "teams"} onClick={() => setView("teams")}
              className={`rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${view === "teams" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}>
              {t("swarmTeams.teams")}
            </button>
            <button type="button" aria-pressed={view === "agents"} onClick={() => setView("agents")}
              className={`rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${view === "agents" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}>
              {t("swarmTeams.agents")}
            </button>
          </div>
        </div>

        {loading ? (
          <div role="status" aria-label={t("swarmTeams.loading")} className="grid gap-4 md:grid-cols-2">
            {[0, 1, 2, 3].map((item) => <div key={item} className="h-40 animate-pulse rounded-xl border border-border/60 bg-card" />)}
            <span className="sr-only">{t("swarmTeams.loading")}</span>
          </div>
        ) : error ? (
          <section role="alert" className="rounded-xl border border-warning/30 bg-warning/5 p-5">
            <div className="flex items-center gap-2 font-medium text-warning"><AlertTriangle className="h-5 w-5" aria-hidden="true" />{t("swarmTeams.unavailable")}</div>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            <button type="button" onClick={() => setReload((attempt) => attempt + 1)} className="mt-4 inline-flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
              <RefreshCw className="h-4 w-4" aria-hidden="true" />{t("swarmTeams.retry")}
            </button>
          </section>
        ) : view === "teams" ? (
          presets.length ? (
            <section aria-label={t("swarmTeams.teams")} className="grid gap-4">
              {presets.map((preset, presetIndex) => (
                <article key={`${preset.name}:${presetIndex}`} className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
                  <header className="border-s-2 border-primary/70 p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="break-words text-lg font-semibold">{preset.title || preset.name}</h2>
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{preset.name}</p>
                        {preset.description && <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">{preset.description}</p>}
                      </div>
                      {preset.source && <span className="shrink-0 rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">{preset.source === "user" ? t("swarmTeams.userSource") : preset.source === "bundled" ? t("swarmTeams.bundledSource") : preset.source}</span>}
                    </div>
                  </header>
                  {preset.tasks !== undefined && (
                    <div className="border-t border-border/60 p-5">
                      <h3 className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><span className="font-mono text-primary">{String(preset.tasks.length).padStart(2, "0")}</span>{t("swarmTeams.stages")}</h3>
                      {preset.tasks.length ? (
                        <div>{preset.tasks.map((task, index) => <TaskCard key={`${task.id ?? "stage"}:${index}`} task={task} index={index} agents={preset.agents ?? []} t={t} />)}</div>
                      ) : <p className="text-sm text-muted-foreground">{t("swarmTeams.noStages")}</p>}
                    </div>
                  )}
                </article>
              ))}
            </section>
          ) : <p role="status" className="rounded-xl border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">{t("swarmTeams.noTeams")}</p>
        ) : agentCount ? (
          <section aria-label={t("swarmTeams.agents")} className="grid gap-4 md:grid-cols-2">
            {presets.flatMap((preset, presetIndex) => (preset.agents ?? []).map((agent, agentIndex) => (
              <AgentCard key={`${preset.name}:${agent.id ?? "agent"}:${presetIndex}:${agentIndex}`} agent={agent} preset={preset} t={t} />
            )))}
          </section>
        ) : <p role="status" className="rounded-xl border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">{t("swarmTeams.noAgents")}</p>}
      </div>
    </div>
  );
}
