import { createHash } from "node:crypto";
import type { HeadRecoveryAttempt } from "./contracts";

export interface HeadQuotaFailure {
  readonly model: { readonly provider: "openai-codex"; readonly id: string };
  readonly failedAt: number;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

const codexFailureCode = /^Codex (?:error event|response failed)(?:: [\s\S]+)? \(code=([a-z_]+)(?:, status=[a-z_]+)?\)$/;
// AssistantMessage.errorId uses the SDK's public wire bits. Read them without
// requiring the installed CLI to expose a particular SDK error submodule.
const transientErrorBit = 0x0002_0000;
const usageLimitErrorBit = 0x0008_0000;

function googleQuotaError(message: string, status: unknown): boolean {
  const http = /^(Google API|Cloud Code Assist API) error \((402|429)\)(?: resuming a long generation)?: /.exec(message);
  const prefix = http ?? /^(?:Google API|Cloud Code Assist) stream error: /.exec(message);
  if (!prefix || (http ? status !== Number(http[2]) : status !== undefined && status !== 429 && status !== 402)) return false;
  // Cloud Code Assist HTTP preserves the whole response body. Google/Vertex HTTP
  // and both streaming adapters can append a JSON.stringify'd RPC status suffix.
  const detail = message.slice(prefix[0].length).trim();
  const suffix = http?.[1] === "Cloud Code Assist API" ? -1 : detail.lastIndexOf(' {"error":{"status":');
  if (!http && (suffix < 0 || !/(?: \(RESOURCE_EXHAUSTED\)|^RESOURCE_EXHAUSTED)$/.test(detail.slice(0, suffix)))) return false;
  try {
    const error = object(object(JSON.parse(detail.slice(suffix + 1))).error);
    if (error.status !== "RESOURCE_EXHAUSTED" || !Array.isArray(error.details)
      || (suffix >= 0 && Object.keys(error).length !== 2)) return false;
    const reasons = error.details.map(object).filter(part => part["@type"] === "type.googleapis.com/google.rpc.ErrorInfo");
    return reasons.some(part => part.reason === "QUOTA_EXHAUSTED" || part.reason === "INSUFFICIENT_G1_CREDITS_BALANCE")
      && !reasons.some(part => part.reason === "MODEL_CAPACITY_EXHAUSTED" || part.reason === "MODEL_CAPACITY_EXCEEDED");
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/**
 * Classify only the error metadata of an owned native prompt receipt or
 * terminal assistant message. A bare HTTP status or SDK UsageLimit flag can
 * also represent a throttle; neither is evidence of account quota exhaustion.
 */
export function laneQuotaExhausted(error: unknown): boolean {
  const failure = object(error);
  const assistant = failure.role === "assistant" && failure.stopReason === "error";
  if (failure.role !== undefined && !assistant) return false;
  const errorId = assistant && typeof failure.errorId === "number" ? failure.errorId : 0;
  const transient = failure.retryable === true || (errorId & transientErrorBit) !== 0;
  const detail = assistant ? failure.errorClassificationMessage ?? failure.errorMessage : failure.message;
  // DashScope uses the same code and billing wording for a transient TPM/TPS cap.
  const lower = typeof detail === "string" ? detail.toLowerCase() : "";
  if (lower.includes("you exceeded your current quota, please check your plan and billing details")
    && lower.includes("error-code") && lower.includes("#token-limit")) return false;
  const code = failure.code ?? failure.type;
  if (code !== undefined) return !transient && (code === "usage_limit_reached" || code === "insufficient_quota");
  if (typeof detail !== "string" || typeof failure.provider !== "string" || !failure.provider
    || (!assistant && typeof failure.retryable !== "boolean")) return false;

  // Stock OMP 19.1.1 strips structured provider codes in RPC prompt errors.
  // Its native formatters can still preserve one in a dedicated position.
  const message = detail.replace(/ retry-after-ms=\d+$/, "");
  const status = assistant ? failure.errorStatus : failure.httpStatus;
  // The stock SDK can mark any ProviderHttpError 429 transient, even when
  // its provider-specific machine code proves a persistent quota failure.
  if (failure.provider === "cursor" && (failure.api === undefined || failure.api === "cursor-agent")) {
    return status === 429 && /^Cursor USAGE_PRICING_REQUIRED: \S/.test(message);
  }
  const googleWire = failure.api === undefined
    ? ["google", "google-vertex", "google-antigravity", "google-gemini-cli"].includes(failure.provider)
    : failure.api === "google-generative-ai" || failure.api === "google-vertex" || failure.api === "google-gemini-cli";
  if (googleWire) return googleQuotaError(message, status);
  if (failure.provider === "openai-codex" || failure.api === "openai-codex-responses") {
    if (transient) return false;
    const nativeCode = codexFailureCode.exec(message)?.[1];
    if (nativeCode !== undefined) return nativeCode === "usage_limit_reached" || nativeCode === "insufficient_quota";
    // Codex's HTTP adapter uses the same friendly text for usage_not_included.
    // The stock SDK marks that HTTP 429 transient, while usage_limit_reached
    // is non-transient. Require the native classification, not the phrase alone.
    return status === 429 && (!assistant || (errorId & usageLimitErrorBit) !== 0)
      && /^You have hit your ChatGPT usage limit(?: \([a-z0-9_-]+ plan\))?\.(?: Try again in ~\d+ min\.)?$/.test(message);
  }
  const openAiApi = failure.api === "openai-responses" || failure.api === "azure-openai-responses"
    || failure.api === "openai-completions";
  if (failure.api !== undefined && !openAiApi) return false;
  const knownOpenAiWire = openAiApi || ["openai", "openai-api", "azure"].includes(failure.provider);
  // Responses-API event and failed-response errors prefix the machine code.
  if (knownOpenAiWire && !transient && /^(?:Error Code )?insufficient_quota: [\s\S]+$/.test(message)) return true;
  // The captured HTTP formatter renders type, param and code in order but
  // re-labels after omitting null fields. A lone param is not a machine code.
  const http = /^(402|429) [\s\S]+ \(type=([a-z_]+)(?: param=([\w.-]+)(?: code=([\w.-]+))?)?\)$/.exec(message);
  if (!http || (status === undefined ? !knownOpenAiWire : status !== Number(http[1]))
    || (transient && status !== 429)) return false;
  const [, , type, param, httpCode] = http;
  // Stock SDK text classification adds Transient for the literal status prefix
  // "429", even on HTTP billing caps. Override it only with the captured code
  // or corroborating type and relabeled code, never the status or a lone type.
  return httpCode === "insufficient_quota" || (httpCode === undefined && type === "insufficient_quota"
    && (param === "insufficient_quota" || (param === undefined && knownOpenAiWire && !transient)));
}

function sessionExitWithoutPendingTools(entry: Record<string, unknown>): boolean {
  if (entry.type !== "custom" || entry.customType !== "session_exit") return false;
  const { reason, kind, pendingToolCalls } = object(entry.data);
  return typeof reason === "string" && (kind === "normal" || kind === "signal" || kind === "fatal" || kind === "process_exit")
    && (pendingToolCalls === undefined || (Array.isArray(pendingToolCalls) && pendingToolCalls.length === 0));
}

/** Recover one settled prompt from the journal suffix after its authenticated cursor. */
export function settledLaneReceipt(entries: unknown[], owner: {
  readonly sessionId: string; readonly sessionFile: string; readonly requestId: string; readonly hostPid: number;
}): { frame: Record<string, unknown>; assistant?: Record<string, unknown> } | null {
  if (!Number.isSafeInteger(owner.hostPid) || owner.hostPid <= 0) return null;
  const owned = (data: Record<string, unknown>) => data.hostPid === owner.hostPid
    && data.sessionId === owner.sessionId && data.sessionFile === owner.sessionFile;
  let start: Record<string, unknown> | undefined;
  let frame: Record<string, unknown> | undefined;
  let assistant: Record<string, unknown> | undefined;
  let userSeen = false;
  for (const value of entries) {
    const entry = object(value);
    if (typeof entry.id !== "string" || typeof entry.type !== "string") return null;
    if (frame) {
      if (entry.type === "model_usage" || sessionExitWithoutPendingTools(entry)) continue;
      // A later run, user/assistant, tool, or unknown effect prevents recovery.
      return null;
    }
    if (entry.type === "custom" && entry.customType === "rpc_agent_start") {
      const data = object(entry.data);
      if (start || !owned(data) || typeof data.instanceKey !== "string" || !data.instanceKey
        || typeof data.runOrdinal !== "number" || !Number.isSafeInteger(data.runOrdinal) || data.runOrdinal <= 0) return null;
      start = data;
    } else if (entry.type === "custom" && entry.customType === "rpc_prompt_result") {
      const data = object(entry.data);
      const receipt = object(data.frame);
      if (!start || !userSeen || !owned(data) || data.instanceKey !== start.instanceKey
        || data.runOrdinal !== start.runOrdinal || receipt.id !== owner.requestId || receipt.sessionSettled !== true
        || receipt.agentInvoked !== true) return null;
      frame = receipt;
    } else if (entry.type === "custom" && entry.customType === "tool_execution_start" && (!start || !userSeen)) {
      return null;
    } else if (entry.type === "message") {
      const message = object(entry.message);
      if (message.role === "user") {
        if (userSeen) return null;
        userSeen = true;
      } else if (message.role === "assistant") {
        if (!start || !userSeen) return null;
        assistant = message;
      } else if (message.role === "toolResult" && (!start || !userSeen)) return null;
    }
  }
  if (!frame) return null;
  switch (frame.status) {
    case "completed":
      return assistant?.stopReason === "stop" || assistant?.stopReason === "length" ? { frame, assistant } : null;
    case "aborted":
      if (assistant?.stopReason === "aborted") return { frame, assistant };
      // An owned abort can settle before the provider replies or while tools run.
      return !assistant || assistant.stopReason === "toolUse" ? { frame } : null;
    case "error":
      return assistant?.stopReason === "error" ? { frame, assistant } : { frame };
    default:
      return null;
  }
}

// Stock Usage.server counts provider-side tool requests, independently of
// whether the provider retained a tool block in the journal.
function usedServerTools(usage: unknown): boolean {
  return Object.values(object(object(usage).server)).some(count => typeof count === "number" && count > 0);
}

// Opaque provider history can contain effects outside content. In content
// allow only passive blocks, not tools, images, or unknown future variants.
function passiveAssistantOutput({ content, providerPayload, usage }: Record<string, unknown>): boolean {
  return providerPayload === undefined && !usedServerTools(usage) && Array.isArray(content) && content.every(part => {
    const block = object(part);
    switch (block.type) {
      case "text": return typeof block.text === "string";
      case "thinking": return typeof block.thinking === "string";
      case "redactedThinking": return typeof block.data === "string";
      case "fallback": return typeof object(block.from).model === "string" && typeof object(block.to).model === "string";
      default: return false;
    }
  });
}

/** Only journal identities and native outcome fields leave this evidence reader. */
export function headRecoveryEvidence(entries: unknown[], owner: Pick<HeadRecoveryAttempt,
  "sessionId" | "sessionFile" | "requestId" | "cursor">, boundary?: string) {
  const journal = entries.map(object);
  const start = owner.cursor === null ? -1 : journal.findIndex(entry => entry.id === owner.cursor);
  const end = boundary === undefined ? journal.length - 1 : journal.findIndex(entry => entry.id === boundary);
  if (owner.cursor !== null && start < 0 || end <= start || typeof journal[end]?.id !== "string") return null;
  const slice = journal.slice(start + 1, end + 1);
  const matches = (entry: Record<string, unknown>, type: string) => entry.type === "custom" && entry.customType === type
    && object(entry.data).sessionId === owner.sessionId && object(entry.data).sessionFile === owner.sessionFile;
  const receipts = slice.filter(entry => matches(entry, "rpc_prompt_result"));
  const receiptsForRequest = receipts.filter(entry => object(object(entry.data).frame).id === owner.requestId);
  if (receiptsForRequest.length !== 1 || receipts.length !== 1) return null;
  const receipt = receiptsForRequest[0]!;
  const frame = object(object(receipt.data).frame);
  const starts = slice.filter(entry => matches(entry, "rpc_agent_start"));
  const latestStart = starts.at(-1);
  const latestStartIndex = latestStart ? slice.indexOf(latestStart) : -1;
  // Another submitted user message is an ownership boundary, even if its RPC
  // receipt has not arrived. Do not borrow its assistant outcome.
  const users = slice.filter(entry => entry.type === "message" && object(entry.message).role === "user");
  const firstAssistantIndex = slice.findIndex(entry => entry.type === "message" && object(entry.message).role === "assistant");
  if (users.length > 1 || users.some(entry => firstAssistantIndex >= 0 && slice.indexOf(entry) > firstAssistantIndex)) return null;
  const assistants = slice.slice(latestStartIndex + 1).filter(entry => entry.type === "message"
    && object(entry.message).role === "assistant");
  const latestAssistant = assistants.at(-1);
  const latestRunStatus = object(latestAssistant?.message).stopReason;
  let outcome: "done" | "cancelled" | undefined;
  const receiptData = object(receipt.data);
  const startData = object(latestStart?.data);
  const receiptAfterStart = typeof receiptData.runOrdinal === "number" && typeof startData.runOrdinal === "number"
    && receiptData.hostPid === startData.hostPid
    ? receiptData.runOrdinal >= startData.runOrdinal
    : slice.indexOf(receipt) > latestStartIndex;
  if (frame.status === "aborted" && (!latestStart || receiptAfterStart)) outcome = "cancelled";
  if (frame.status === "completed") {
    if (frame.agentInvoked === false && !latestStart) outcome = "done";
    else if (latestStart && (latestRunStatus === "stop" || latestRunStatus === "length")) outcome = "done";
    else if (latestStart && latestRunStatus === "aborted") outcome = "cancelled";
  }
  const error = object(frame.error);
  const failedAt = typeof receipt.timestamp === "string" ? Date.parse(receipt.timestamp) : NaN;
  const receiptIndex = slice.indexOf(receipt);
  const sameRun = typeof receiptData.hostPid === "number" && Number.isSafeInteger(receiptData.hostPid)
    && receiptData.hostPid > 0 && typeof receiptData.instanceKey === "string" && receiptData.instanceKey !== ""
    && typeof receiptData.runOrdinal === "number" && Number.isSafeInteger(receiptData.runOrdinal) && receiptData.runOrdinal > 0
    && receiptData.hostPid === startData.hostPid && receiptData.instanceKey === startData.instanceKey
    && receiptData.runOrdinal === startData.runOrdinal;
  // The exact settled run failed before any tool started: only its prompt,
  // passive failed model/refusal output and usage records exist. An earlier
  // tool, another request or unknown journal entry leaves effects unproven.
  const settledToolFreeError = frame.status === "error" && frame.sessionSettled === true && frame.agentInvoked === true
    && sameRun && users.length === 1 && receiptIndex > latestStartIndex
    && slice.every((entry, index) => {
      if (typeof entry.id !== "string") return false;
      if (entry.type === "model_usage") return !usedServerTools(entry.usage);
      if (entry === receipt) return true;
      // These stock restart records don't start work. Arbitrary custom
      // messages can trigger another turn; unknown custom entries prove nothing.
      if (index > receiptIndex) {
        if (entry.type === "custom_message" && entry.customType === "eval-state-context") return typeof entry.content === "string";
        return sessionExitWithoutPendingTools(entry) && typeof object(entry.data).recordedAt === "string";
      }
      if (matches(entry, "rpc_agent_start")) {
        const start = object(entry.data);
        return start.hostPid === receiptData.hostPid && start.instanceKey === receiptData.instanceKey
          && typeof start.runOrdinal === "number" && Number.isSafeInteger(start.runOrdinal)
          && start.runOrdinal > 0 && start.runOrdinal <= Number(receiptData.runOrdinal);
      }
      if (entry.type === "custom" && entry.customType === "provider_refusal") {
        const refusal = object(entry.data);
        return (refusal.stopType === "refusal" || refusal.stopType === "sensitive") && passiveAssistantOutput(refusal);
      }
      if (entry.type !== "message") return false;
      const message = object(entry.message);
      return message.role === "user" || message.role === "assistant" && message.stopReason === "error" && passiveAssistantOutput(message);
    });
  const quotaLikeText = (value: unknown): boolean => typeof value === "string"
    && /(?:usage_limit_reached|insufficient_quota|quota_exceeded|usage_limit|usage limit|quota)/i.test(value);
  const quotaLikeFailure = laneQuotaExhausted(error) || quotaLikeText(error.message) || quotaLikeText(error.code) || quotaLikeText(error.type)
    || slice.some(entry => {
      if (entry.type !== "message") return false;
      const message = object(entry.message);
      return message.role === "assistant"
        && (laneQuotaExhausted(message) || quotaLikeText(message.errorMessage) || quotaLikeText(message.error));
    });
  // The exact provider refused the entire turn for quota. A partial answer or
  // another provider's reply makes it something other than a quota hold.
  const quotaFailure: HeadQuotaFailure | null = settledToolFreeError
    && error.provider === "openai-codex" && typeof error.model === "string" && error.model !== ""
    && error.retryable === false && typeof error.message === "string"
    // Stock OMP's RPC error lacks a structured quota code. Match either
    // native Codex formatter, but require the exact code in its metadata.
    && codexFailureCode.exec(error.message)?.[1] === "usage_limit_reached"
    && Number.isFinite(failedAt) && latestRunStatus === "error"
    && slice.slice(receiptIndex + 1).every(entry => entry.type === "model_usage")
    && slice.every(entry => {
      if (entry.type === "custom") return entry.customType !== "provider_refusal";
      const message = object(entry.message);
      return entry.type !== "message" || message.role !== "assistant" || message.provider === error.provider
        && message.model === error.model && Array.isArray(message.content) && message.content.length === 0;
    })
    ? { failedAt, model: { provider: error.provider, id: error.model } } : null;
  // Quota-like refusals stay held unless native quota recovery proves safe release.
  const toolFreeFailure = settledToolFreeError && !quotaFailure && !quotaLikeFailure;
  const selected = [receipt, ...starts, ...assistants];
  if (selected.some(entry => typeof entry.id !== "string")) return null;
  const entryIds = [...new Set(selected.map(entry => String(entry.id)))];
  const proof = { entryIds, receiptStatus: String(frame.status), latestRunStatus: latestRunStatus ?? null,
    outcome: outcome ?? null };
  return { ...proof, settledToolFreeError, toolFreeFailure, quotaFailure, boundary: String(journal[end]!.id),
    fingerprint: createHash("sha256").update(JSON.stringify(slice.map(entry => [
      entry.id, entry.type, entry.customType,
      matches(entry, "rpc_prompt_result") ? object(entry.data).frame : null,
      matches(entry, "rpc_prompt_result") || matches(entry, "rpc_agent_start")
        ? [object(entry.data).hostPid ?? null, object(entry.data).instanceKey ?? null, object(entry.data).runOrdinal ?? null] : null,
      entry.type === "message" ? object(entry.message).role : null,
      entry.type === "message" ? object(entry.message).stopReason : null,
    ]))).digest("hex") };
}
