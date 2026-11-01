import { useEffect, useId, useState } from "react";
import { ArrowDown, Check, LoaderCircle, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type SwarmPresetCatalog, type SwarmPresetSource, type SwarmPresetValidation } from "@/lib/api";

type PresetIdentity = Pick<SwarmPresetCatalog, "name" | "title" | "source">;

interface PresetYamlEditorProps {
  preset?: PresetIdentity;
  onCancel: () => void;
  onSaved: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validationFromError(error: unknown): SwarmPresetValidation | null {
  if (!isRecord(error)) return null;
  const detail = error.detail;
  if (!isRecord(detail) || !Array.isArray(detail.errors) || !Array.isArray(detail.warnings)) return null;
  const layers = Array.isArray(detail.layers) ? detail.layers : [];

  return {
    valid: detail.valid === true,
    errors: detail.errors.filter((item): item is string => typeof item === "string"),
    warnings: detail.warnings.filter((item): item is string => typeof item === "string"),
    layers: layers.map((layer) => Array.isArray(layer) ? layer.flatMap((item) => {
      if (!isRecord(item) || typeof item.task_id !== "string" || typeof item.agent_id !== "string") return [];
      return [{ task_id: item.task_id, agent_id: item.agent_id }];
    }) : []),
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return isRecord(error) && typeof error.message === "string" ? error.message : fallback;
}

export function PresetYamlEditor({ preset, onCancel, onSaved }: PresetYamlEditorProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const hintId = useId();
  const [yamlText, setYamlText] = useState("");
  const [source, setSource] = useState<SwarmPresetSource | null>(null);
  const [loadingSource, setLoadingSource] = useState(Boolean(preset));
  const [sourceError, setSourceError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [validation, setValidation] = useState<SwarmPresetValidation | null>(null);
  const [validatedYaml, setValidatedYaml] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [latestSource, setLatestSource] = useState<SwarmPresetSource | null>(null);

  useEffect(() => {
    if (!preset) {
      setLoadingSource(false);
      return;
    }
    const controller = new AbortController();
    setLoadingSource(true);
    setSourceError(false);
    api.getSwarmPresetSource(preset.name, controller.signal)
      .then((result) => {
        setSource(result);
        setYamlText(result.yaml_text);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSourceError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingSource(false);
      });
    return () => controller.abort();
  }, [preset?.name, loadAttempt]);

  const handleYamlChange = (value: string) => {
    setYamlText(value);
    setValidation(null);
    setValidatedYaml(null);
    setSaveError(null);
  };

  const validate = async () => {
    setValidating(true);
    setSaveError(null);
    setValidation(null);
    setValidatedYaml(null);
    try {
      const result = await api.validateSwarmPreset(yamlText);
      setValidation(result);
      if (result.valid && result.errors.length === 0) setValidatedYaml(yamlText);
    } catch (cause: unknown) {
      const result = validationFromError(cause);
      if (result) setValidation(result);
      else setSaveError(errorMessage(cause, t("swarmTeams.validationFailed")));
    } finally {
      setValidating(false);
    }
  };

  const refreshLatest = async (): Promise<SwarmPresetSource | null> => {
    if (!preset) return null;
    try {
      const result = await api.getSwarmPresetSource(preset.name);
      setLatestSource(result);
      return result;
    } catch (cause: unknown) {
      setSaveError(errorMessage(cause, t("swarmTeams.sourceLoadFailed")));
      return null;
    }
  };

  const save = async (revisionOverride?: string) => {
    if (!validatedYaml || validatedYaml !== yamlText || !validation?.valid || validation.errors.length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (preset) {
        const revision = revisionOverride ?? source?.revision;
        if (!revision) return;
        await api.saveSwarmPresetSource(preset.name, yamlText, revision);
      } else {
        await api.createSwarmPreset(yamlText);
      }
      onSaved();
    } catch (cause: unknown) {
      if (isRecord(cause) && cause.status === 409) {
        if (preset) {
          setConflict(true);
          setLatestSource(null);
          await refreshLatest();
        } else {
          setSaveError(errorMessage(cause, t("swarmTeams.conflict")));
        }
      } else {
        setSaveError(errorMessage(cause, t("swarmTeams.saveFailed")));
      }
    } finally {
      setSaving(false);
    }
  };

  const readyToSave = Boolean(
    !loadingSource && !sourceError && !saving && !validating && !conflict && validatedYaml === yamlText &&
    validation?.valid && validation.errors.length === 0 && (!preset || source?.revision),
  );

  return (
    <section aria-labelledby={headingId} aria-busy={loadingSource || validating || saving} className="rounded-xl border border-primary/30 bg-card shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 p-5">
        <div>
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-primary">{t("swarmTeams.yamlEditor")}</p>
          <h2 id={headingId} className="text-lg font-semibold">{t("swarmTeams.editorTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {preset ? `${preset.title || preset.name} · ${preset.name}` : t("swarmTeams.newPresetHint")}
          </p>
          {preset?.source === "bundled" && <p className="mt-2 text-xs text-muted-foreground">{t("swarmTeams.bundledEditHint")}</p>}
        </div>
        <button type="button" onClick={onCancel} className="rounded-md border border-border/60 px-3 py-2 text-sm font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
          {t("swarmTeams.cancelEdit")}
        </button>
      </header>

      <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(16rem,0.8fr)]">
        <div className="min-w-0">
          {loadingSource ? (
            <div role="status" className="flex min-h-48 items-center gap-2 rounded-lg border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />{t("swarmTeams.loadingSource")}
            </div>
          ) : sourceError ? (
            <div role="alert" className="rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm">
              <p className="text-warning">{t("swarmTeams.sourceLoadFailed")}</p>
              <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)} className="mt-3 rounded-md border border-border/60 px-3 py-2 font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                {t("swarmTeams.retry")}
              </button>
            </div>
          ) : (
            <>
              <label htmlFor={`${headingId}-yaml`} className="mb-2 block text-sm font-medium">{t("swarmTeams.yamlLabel")}</label>
              <textarea
                id={`${headingId}-yaml`}
                aria-label={t("swarmTeams.yamlLabel")}
                aria-describedby={hintId}
                aria-invalid={validation !== null && (!validation.valid || validation.errors.length > 0)}
                disabled={validating || saving}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                rows={20}
                value={yamlText}
                onChange={(event) => handleYamlChange(event.target.value)}
                className="min-h-[24rem] w-full resize-y rounded-lg border border-border/70 bg-background p-4 font-mono text-xs leading-relaxed text-foreground shadow-inner outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              />
              <p id={hintId} className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("swarmTeams.yamlHint")}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={validate} disabled={validating || saving || loadingSource} className="inline-flex items-center gap-2 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                  {validating ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
                  {validating ? t("swarmTeams.validating") : t("swarmTeams.validate")}
                </button>
                <button type="button" onClick={() => void save()} disabled={!readyToSave} className="rounded-md border border-primary/30 px-3.5 py-2 text-sm font-semibold text-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                  {saving ? t("swarmTeams.saving") : t("swarmTeams.savePreset")}
                </button>
              </div>
            </>
          )}

          {saveError && <p role="alert" className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning">{saveError}</p>}
          {conflict && (
            <div role="alert" className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
              <p className="font-medium text-warning">{t("swarmTeams.conflict")}</p>
              <p className="mt-1 text-muted-foreground">{t("swarmTeams.conflictDraftPreserved")}</p>
              {latestSource && (
                <>
                  <details className="mt-3">
                    <summary className="cursor-pointer font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">{t("swarmTeams.latestSource")}</summary>
                    <pre aria-label={t("swarmTeams.latestSource")} className="mt-2 max-h-56 overflow-auto rounded-md border border-border/60 bg-background p-3 font-mono text-xs leading-relaxed">{latestSource.yaml_text}</pre>
                  </details>
                  <button type="button" onClick={() => void save(latestSource.revision)} disabled={!validatedYaml || validatedYaml !== yamlText || saving} className="mt-3 rounded-md border border-warning/30 px-3 py-2 font-medium text-warning hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40">
                    {t("swarmTeams.saveDraftOverLatest")}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <section aria-label={t("swarmTeams.validationPreview")} className="rounded-lg border border-border/60 bg-muted/15 p-4">
          <h3 className="font-mono text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">{t("swarmTeams.validationPreview")}</h3>
          {!validation ? (
            <p className="mt-3 text-sm text-muted-foreground">{t("swarmTeams.validateBeforePreview")}</p>
          ) : (
            <div aria-live="polite" className="mt-3 space-y-4">
              {validation.valid && validation.errors.length === 0 && <p className="text-sm font-medium text-primary">{t("swarmTeams.validationComplete")}</p>}
              {validation.errors.length > 0 && (
                <div>
                  <h4 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-warning"><TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />{t("swarmTeams.validationErrors")}</h4>
                  <ul className="list-inside list-disc space-y-1 text-sm text-warning">{validation.errors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}</ul>
                </div>
              )}
              {validation.warnings.length > 0 && (
                <div>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("swarmTeams.validationWarnings")}</h4>
                  <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">{validation.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>
                </div>
              )}
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("swarmTeams.dagPreview")}</h4>
                {validation.layers.length ? (
                  <ol className="space-y-2">
                    {validation.layers.map((layer, index) => (
                      <li key={`layer:${index}`}>
                        {index > 0 && <div className="my-1 flex justify-center text-primary/60"><ArrowDown className="h-4 w-4" aria-hidden="true" /></div>}
                        <div className="rounded-md border border-border/60 bg-background p-3">
                          <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{t("swarmTeams.layer", { number: index + 1 })}</p>
                          <ul className="space-y-2">
                            {layer.map(({ task_id, agent_id }, taskIndex) => (
                              <li key={`${task_id}:${taskIndex}`} className="min-w-0 rounded border border-primary/15 bg-primary/5 px-2.5 py-2 text-xs">
                                <span className="break-all font-mono font-semibold">{task_id}</span>
                                <span className="block truncate pt-1 text-muted-foreground">{t("swarmTeams.agentLabel")}: <span className="font-mono">{agent_id}</span></span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : <p className="text-sm text-muted-foreground">{t("swarmTeams.noLayers")}</p>}
              </div>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
