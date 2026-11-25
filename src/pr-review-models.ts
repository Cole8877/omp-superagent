import type { LaneModel } from "./contracts";
import { acceptsRestrictedModelSelector, isLaneModel } from "./lane-models";

const inferenceApis = new Set(["openai-completions", "openai-responses", "openai-codex-responses",
  "azure-openai-responses", "anthropic-messages"]);

/** A tool-free inference API, not an external agent harness. */
export function isPrReviewInferenceModel(model: unknown): boolean {
  return typeof model === "object" && model !== null
    && "api" in model && typeof model.api === "string" && inferenceApis.has(model.api)
    && "provider" in model && typeof model.provider === "string" && model.provider !== "gitlab-duo"
    && (!("transport" in model) || model.transport !== "pi-native");
}

/** New selections must be exact, unique chat models in the native available catalogue. */
export function prReviewModelChoices<T>(catalog: readonly T[]): (T & LaneModel)[] {
  const choices = new Map<string, (T & LaneModel) | undefined>();
  for (const model of catalog) {
    if (!isLaneModel(model)) continue;
    const key = JSON.stringify([model.provider, model.id]);
    // Track rejected entries too: another row with this identity is ambiguous.
    const allowed = !choices.has(key) && isPrReviewInferenceModel(model)
      && acceptsRestrictedModelSelector(model)
      && (!("kind" in model) || model.kind === undefined || model.kind === "chat");
    choices.set(key, allowed ? model : undefined);
  }
  return [...choices.values()].filter(model => model !== undefined);
}
