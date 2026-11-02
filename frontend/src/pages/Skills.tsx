import { useEffect, useState } from "react";
import { AlertTriangle, BookOpen, Lock, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  api,
  ApiError,
  type SkillCatalogItem,
  type SkillSource,
} from "@/lib/api";

const NEW_SKILL_TEMPLATE = "---\nname: my_skill\ndescription: What this skill does.\ncategory: other\n---\nBody text.\n";

interface SkillAction {
  /** Aria-label for the alert region so tests and screen readers find it. */
  kind: "name_collision" | "revision_stale" | "auxiliary_files_present" | "invalid" | "generic";
  message: string;
}

function toActionError(cause: unknown, fallback: string): SkillAction {
  const code = cause instanceof ApiError ? cause.code : undefined;
  const message = cause instanceof Error && cause.message ? cause.message : fallback;
  if (code === "name_collision" || code === "revision_stale" || code === "auxiliary_files_present") {
    return { kind: code, message };
  }
  if (code === "invalid_skill") {
    return { kind: "invalid", message };
  }
  return { kind: "generic", message };
}

/** Untyped translation lookup: this page's keys land with Lume's locales. */
type LooseT = (key: string, options?: Record<string, unknown>) => string;

function ErrorAlert({ action, onReloadLatest, onDismiss, t }: {
  action: SkillAction;
  onReloadLatest?: () => void;
  onDismiss: () => void;
  t: LooseT;
}) {
  const keyMap: Record<SkillAction["kind"], string | null> = {
    name_collision: "skills.error.nameCollision",
    revision_stale: "skills.error.revisionStale",
    auxiliary_files_present: "skills.error.auxiliaryFiles",
    invalid: null,
    generic: null,
  };
  const explanation = keyMap[action.kind];
  return (
    <div role="alert" aria-live="assertive" className="rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm">
      <div className="flex items-center gap-2 font-medium text-warning">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        {t("skills.actionFailed")}
      </div>
      {explanation && <p className="mt-1 text-muted-foreground">{t(explanation)}</p>}
      {action.kind === "invalid" && <p className="mt-1 text-muted-foreground">{action.message}</p>}
      {action.kind === "generic" && <p className="mt-1 text-muted-foreground">{action.message}</p>}
      {action.kind === "revision_stale" && onReloadLatest && (
        <button type="button" onClick={onReloadLatest}
          className="mt-2 rounded-md border border-border/60 px-2.5 py-1.5 text-xs font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
          {t("skills.discardDraftReload")}
        </button>
      )}
      <button type="button" onClick={onDismiss}
        className="ms-2 mt-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
        {t("skills.dismiss")}
      </button>
    </div>
  );
}

export function Skills() {
  const { t } = useTranslation();
  // Translation keys for this page land with the i18n locales (Lume); the
  // TFunction cast keeps the untyped keys compiling until they are merged.
  const tr = t as unknown as LooseT;
  const [catalog, setCatalog] = useState<SkillCatalogItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [selected, setSelected] = useState<SkillSource | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<SkillAction | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.listSkillCatalog(controller.signal)
      .then(setCatalog)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : tr("skills.unavailable"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload, t]);

  const openSkill = (name: string) => {
    setSourceLoading(true);
    setNotice(null);
    setActionError(null);
    api.getSkillSource(name)
      .then((source) => {
        setSelected(source);
        setDraft(null);
      })
      .catch((cause: unknown) => {
        setActionError(toActionError(cause, tr("skills.unavailable")));
      })
      .finally(() => setSourceLoading(false));
  };

  const afterMutation = (refreshedName: string | null) => {
    setDraft(null);
    setReload((attempt) => attempt + 1);
    if (refreshedName) {
      // Reload the exact bytes so the next edit carries the fresh revision.
      api.getSkillSource(refreshedName)
        .then((source) => setSelected(source))
        .catch(() => setSelected(null));
    } else {
      setSelected(null);
    }
  };

  const runMutation = (work: () => Promise<unknown>, successNotice: string, refreshedName: string | null) => {
    setBusy(true);
    setNotice(null);
    setActionError(null);
    work()
      .then(() => {
        setNotice(successNotice);
        afterMutation(refreshedName);
      })
      .catch((cause: unknown) => {
        setActionError(toActionError(cause, tr("skills.actionFailed")));
      })
      .finally(() => setBusy(false));
  };

  const startCreate = () => {
    setSelected(null);
    setDraft(NEW_SKILL_TEMPLATE);
    setNotice(null);
    setActionError(null);
  };

  const startEdit = () => {
    if (selected) setDraft(selected.content);
  };

  const createSkill = () =>
    runMutation(
      () => api.createSkill(draft ?? ""),
      tr("skills.created"),
      null,
    );

  const saveSkill = () =>
    selected &&
    runMutation(
      () => api.saveSkillSource(selected.name, draft ?? "", selected.revision),
      tr("skills.saved"),
      selected.name,
    );

  const deleteSkill = () =>
    selected &&
    runMutation(
      () => api.deleteSkillSource(selected.name, selected.revision),
      tr("skills.deleted"),
      null,
    );

  const creating = draft !== null && !selected;
  const editingSelected = draft !== null && selected !== null;
  const skills = catalog ?? [];

  return (
    <div className="min-h-screen p-4 md:p-6 lg:p-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="border-b border-border/60 pb-6">
          <div className="mb-3 inline-flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
            {tr("skills.badge")}
          </div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{tr("skills.title")}</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{tr("skills.subtitle")}</p>
        </header>

        <div className="flex items-center justify-end">
          <button type="button" onClick={startCreate}
            className="inline-flex items-center gap-2 rounded-md border border-primary/30 px-3 py-2 text-sm font-semibold text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            <Plus className="h-4 w-4" aria-hidden="true" />{tr("skills.newSkill")}
          </button>
        </div>

        {notice && (
          <p role="status" className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">{notice}</p>
        )}
        {actionError && (
          <ErrorAlert
            action={actionError}
            onReloadLatest={actionError.kind === "revision_stale" && selected
              ? () => openSkill(selected.name)
              : undefined}
            onDismiss={() => setActionError(null)}
            t={tr}
          />
        )}

        {creating && (
          <section aria-label={tr("skills.creatingTitle")} className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
            <h2 className="text-lg font-semibold">{tr("skills.creatingTitle")}</h2>
            <label htmlFor="skill-content" className="mt-3 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {tr("skills.contentLabel")}
            </label>
            <textarea
              id="skill-content"
              aria-label={tr("skills.contentLabel")}
              className="mt-1 h-72 w-full rounded-lg border border-border/60 bg-background p-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              value={draft ?? ""}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={busy || !(draft ?? "").trim()} onClick={createSkill}
                className="rounded-md border border-primary/30 px-3 py-2 text-sm font-semibold text-primary hover:bg-primary/5 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                {tr("skills.create")}
              </button>
              <button type="button" onClick={() => setDraft(null)}
                className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                {tr("skills.cancel")}
              </button>
            </div>
          </section>
        )}

        {selected && (
          <section aria-label={editingSelected ? tr("skills.editingTitle", { name: selected.name }) : tr("skills.viewingTitle", { name: selected.name })}
            className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="break-all font-mono text-lg font-semibold">{selected.name}</h2>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
                  {selected.source === "user" ? tr("skills.source.user") : tr("skills.source.bundled")}
                </span>
                {selected.source === "bundled" && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3" aria-hidden="true" />{tr("skills.readOnly")}
                  </span>
                )}
              </div>
            </div>

            {sourceLoading ? (
              <p role="status" className="mt-4 text-sm text-muted-foreground">{tr("skills.loadingSource")}</p>
            ) : (
              <>
                <label htmlFor="skill-content" className="mt-4 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {tr("skills.contentLabel")}
                </label>
                <textarea
                  id="skill-content"
                  aria-label={tr("skills.contentLabel")}
                  readOnly={!editingSelected || selected.source !== "user"}
                  className="mt-1 h-72 w-full rounded-lg border border-border/60 bg-background p-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 read-only:text-muted-foreground"
                  value={editingSelected ? (draft ?? "") : selected.content}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  {selected.source === "user" && !editingSelected && (
                    <button type="button" onClick={startEdit} disabled={busy}
                      className="inline-flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                      <Pencil className="h-4 w-4" aria-hidden="true" />{tr("skills.edit")}
                    </button>
                  )}
                  {editingSelected && (
                    <>
                      <button type="button" onClick={saveSkill} disabled={busy || (draft ?? "") === selected.content}
                        className="rounded-md border border-primary/30 px-3 py-2 text-sm font-semibold text-primary hover:bg-primary/5 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                        {tr("skills.save")}
                      </button>
                      <button type="button" onClick={() => setDraft(null)} disabled={busy}
                        className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                        {tr("skills.cancel")}
                      </button>
                    </>
                  )}
                  {selected.source === "user" && (
                    <button type="button" onClick={deleteSkill} disabled={busy}
                      className="inline-flex items-center gap-2 rounded-md border border-warning/40 px-3 py-2 text-sm font-medium text-warning hover:bg-warning/5 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40">
                      <Trash2 className="h-4 w-4" aria-hidden="true" />{tr("skills.delete")}
                    </button>
                  )}
                  <button type="button" onClick={() => { setSelected(null); setDraft(null); }}
                    className="ms-auto rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                    {tr("skills.close")}
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {loading ? (
          <div role="status" aria-label={tr("skills.loading")} className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((item) => <div key={item} className="h-28 animate-pulse rounded-xl border border-border/60 bg-card" />)}
            <span className="sr-only">{tr("skills.loading")}</span>
          </div>
        ) : error ? (
          <section role="alert" className="rounded-xl border border-warning/30 bg-warning/5 p-5">
            <div className="flex items-center gap-2 font-medium text-warning"><AlertTriangle className="h-5 w-5" aria-hidden="true" />{tr("skills.unavailable")}</div>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            <button type="button" onClick={() => setReload((attempt) => attempt + 1)}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
              <RefreshCw className="h-4 w-4" aria-hidden="true" />{tr("skills.retry")}
            </button>
          </section>
        ) : skills.length ? (
          <section aria-label={tr("skills.title")} className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {skills.map((skill) => (
              <article key={`${skill.source}:${skill.name}`} className="flex flex-col rounded-xl border border-border/60 bg-card p-5 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="break-all font-mono text-sm font-semibold">{skill.name}</h3>
                  <span className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
                    {skill.source === "user" ? tr("skills.source.user") : tr("skills.source.bundled")}
                  </span>
                </div>
                {skill.description && <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted-foreground">{skill.description}</p>}
                <button type="button" onClick={() => openSkill(skill.name)}
                  className="mt-4 self-start rounded-md border border-border/60 px-2.5 py-1.5 text-xs font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                  {tr("skills.open")}
                </button>
              </article>
            ))}
          </section>
        ) : (
          <p role="status" className="rounded-xl border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">{tr("skills.emptyCatalog")}</p>
        )}
      </div>
    </div>
  );
}
