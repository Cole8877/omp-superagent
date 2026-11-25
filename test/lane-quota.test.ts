import { expect, spyOn, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { create, finalize, Flag, GeminiCliApiError, GoogleApiError, is as hasErrorFlag } from "@oh-my-pi/pi-ai/error";
import { CONNECT_END_STREAM_FLAG, frameConnectMessage } from "@oh-my-pi/pi-ai/providers/connect-frame";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import { extractGoogleErrorMessage, googleStreamChunkError } from "@oh-my-pi/pi-ai/providers/google-shared";
import { CodexApiError } from "@oh-my-pi/pi-ai/providers/openai-codex/response-handler";
import { captureOpenAIHttpError } from "@oh-my-pi/pi-ai/utils/openai-http";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ErrorDetailsSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create as proto, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { CURSOR_BIDI_APPEND_PATH, CURSOR_RUN_SSE_PATH } from "@oh-my-pi/pi-catalog/wire/cursor";
import { RpcPromptResults } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-prompt-results";
import type { RpcPromptResultFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { providerRefusalData } from "@oh-my-pi/pi-coding-agent/session/provider-refusal";
import type { ModelUsageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { headRecoveryEvidence, laneQuotaExhausted, settledLaneReceipt } from "../src/head-recovery";

const codexMessage = "Codex error event: The usage limit has been reached (code=usage_limit_reached)";
const codexError = { provider: "openai-codex", model: "gpt-5.4", message: codexMessage, retryable: false };
const assistantError = { role: "assistant", provider: "openai-codex", stopReason: "error" };
const billingError = { provider: "openai", httpStatus: 429, retryable: false };
const billingDetail = "You exceeded your current quota, please check your plan and billing details.";
const cursorQuotaMessage = "Cursor USAGE_PRICING_REQUIRED: Your prepaid balance is used up";
const googleErrorInfo = "type.googleapis.com/google.rpc.ErrorInfo";
const googleQuotaBody = JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED",
  details: [{ "@type": googleErrorInfo, reason: "QUOTA_EXHAUSTED" }] } });

test.each<{ name: string; failure: unknown }>([
  { name: "exact Codex code", failure: { code: "usage_limit_reached", httpStatus: 429 } },
  { name: "OpenAI structured error type", failure: { type: "insufficient_quota", httpStatus: 429 } },
  { name: "native Codex error event", failure: codexError },
  { name: "native Codex response failure", failure: { ...codexError,
    message: "Codex response failed (code=usage_limit_reached, status=failed)" } },
  { name: "Codex assistant continuation with a native retry hint", failure: { ...assistantError,
    errorMessage: `${codexMessage} retry-after-ms=45000`, errorId: create(Flag.UsageLimit) } },
  { name: "OpenAI Responses error event", failure: { ...billingError,
    message: `Error Code insufficient_quota: ${billingDetail}` } },
  { name: "OpenAI Responses failed response", failure: { ...billingError,
    message: `insufficient_quota: ${billingDetail}` } },
  { name: "stock HTTP formatter omitting null param", failure: { ...billingError,
    message: `429 ${billingDetail} (type=insufficient_quota param=insufficient_quota)` } },
  { name: "stock HTTP formatter preserving code", failure: { ...billingError,
    message: `429 ${billingDetail} (type=invalid_request_error param=model code=insufficient_quota)` } },
  { name: "OpenAI assistant continuation", failure: { ...assistantError, provider: "openai",
    errorMessage: `429 ${billingDetail} (type=insufficient_quota param=insufficient_quota)`, errorStatus: 429 } },
  { name: "custom model using native Responses API", failure: { ...assistantError, provider: "my-responses",
    api: "openai-responses", errorMessage: `insufficient_quota: ${billingDetail}` } },
])("recognizes provider quota evidence: $name", ({ failure }) => {
  expect(laneQuotaExhausted(failure)).toBe(true);
});

test.each<{ name: string; failure: unknown }>([
  { name: "bare status", failure: billingError },
  { name: "bare native UsageLimit flag", failure: { ...assistantError, errorId: create(Flag.UsageLimit), errorStatus: 429 } },
  { name: "transient assistant error", failure: { ...assistantError,
    errorId: create(Flag.Transient | Flag.UsageLimit), errorMessage: codexMessage } },
  { name: "transient receipt error", failure: { ...codexError, retryable: true, code: "usage_limit_reached" } },
  { name: "Codex retry code, with quota words in its detail", failure: { ...codexError,
    message: "Codex error event: insufficient_quota was mentioned (code=rate_limit_exceeded)" } },
  { name: "local session cost cap", failure: { ...codexError, code: "cost_cap" } },
  { name: "generic quota code", failure: { code: "quota_exceeded", httpStatus: 429 } },
  { name: "transient code outranks a quota-like type", failure: { code: "rate_limit_error", type: "insufficient_quota" } },
  { name: "DashScope per-minute throttle", failure: { type: "insufficient_quota", httpStatus: 429,
    message: `${billingDetail} See https://help.aliyun.com/error-code#token-limit` } },
  { name: "OpenAI billing prose without any code", failure: { ...billingError, message: `429 ${billingDetail}` } },
  { name: "quota only in a diagnostic param", failure: { ...billingError,
    message: `429 ${billingDetail} (type=rate_limit_error param=insufficient_quota)` } },
  { name: "ambiguous type on a transient receipt", failure: { ...billingError, retryable: true,
    message: `429 ${billingDetail} (type=insufficient_quota)` } },
  { name: "contradictory HTTP status", failure: { ...billingError, httpStatus: 503,
    message: `429 ${billingDetail} (type=insufficient_quota)` } },
  { name: "non-Codex provider quoting Codex", failure: { ...codexError, provider: "openai" } },
  { name: "an incompatible API with matching prose", failure: { ...assistantError, provider: "custom",
    api: "anthropic-messages", errorMessage: "429 Gateway (type=insufficient_quota param=insufficient_quota)", errorStatus: 429 } },
  { name: "Google plain quota prose", failure: { ...billingError, provider: "google",
    message: "Google API error (429): RESOURCE_EXHAUSTED: QUOTA_EXHAUSTED" } },
  { name: "Google RPC JSON pasted into an unrelated error", failure: { ...billingError, provider: "google",
    message: `Google API returned the following example: ${googleQuotaBody}` } },
  { name: "Google RPC suffix followed by a pasted quotation", failure: { ...billingError, provider: "google",
    message: `Google API error (429): the docs say "${googleQuotaBody}"` } },
  { name: "Google RPC response with a contradictory transport status", failure: { ...billingError, provider: "google-antigravity",
    message: `Cloud Code Assist API error (429): ${googleQuotaBody}`, httpStatus: 503 } },
  { name: "foreign provider quoting Google's native error", failure: { ...billingError,
    message: `Cloud Code Assist API error (429): ${googleQuotaBody}` } },
  { name: "Google quota text in assistant content rather than error data", failure: { ...assistantError, provider: "google",
    api: "google-generative-ai", errorStatus: 429, errorMessage: "Generic error",
    content: [{ type: "text", text: `Google API error (429): Balance exhausted ${googleQuotaBody}` }] } },
  { name: "Cursor generic 429", failure: { ...billingError, provider: "cursor", message: "Cursor RunSSE failed with HTTP 429" } },
  { name: "Cursor Connect diagnostic rather than decoded code", failure: { ...billingError, provider: "cursor",
    message: `Connect error resource_exhausted: ${cursorQuotaMessage}` } },
  { name: "Cursor machine text without native HTTP status", failure: { provider: "cursor", retryable: true, message: cursorQuotaMessage } },
  { name: "foreign provider quoting Cursor's native error", failure: { ...billingError, message: cursorQuotaMessage } },
  { name: "quoted provider error", failure: { ...codexError, message: `The user quoted "${codexMessage}"` } },
  { name: "Codex HTTP prose without a native status", failure: { ...codexError, message: "You have hit your ChatGPT usage limit." } },
  { name: "Codex assistant without native classification", failure: { ...assistantError,
    errorMessage: "You have hit your ChatGPT usage limit.", errorStatus: 429 } },
  { name: "raw prose", failure: codexMessage },
  { name: "formatted detail without native receipt metadata", failure: { provider: codexError.provider, message: codexMessage } },
  { name: "user message", failure: { ...codexError, role: "user", code: "usage_limit_reached" } },
  { name: "assistant text instead of error metadata", failure: { ...assistantError,
    content: [{ type: "text", text: codexMessage }], errorMessage: "Connection closed" } },
  { name: "aborted assistant", failure: { ...assistantError, errorMessage: codexMessage, stopReason: "aborted" } },
])("leaves non-quota failure recovery to HEAD: $name", ({ failure }) => {
  expect(laneQuotaExhausted(failure)).toBe(false);
});

test.each([
  ["usage_limit_reached", true],
  ["usage_not_included", false],
  ["rate_limit_exceeded", false],
] as const)("uses stock Codex HTTP classification, not its friendly wording (%s)", async (type, exhausted) => {
  const http = new Response(JSON.stringify({ error: { type, plan_type: "plus" } }), { status: 429 });
  const native = await finalize(await CodexApiError.fromResponse(http), {
    api: "openai-codex-responses", provider: codexError.provider,
  });
  expect(laneQuotaExhausted({ ...assistantError, stopReason: native.stopReason,
    errorMessage: native.message, errorStatus: native.status, errorId: native.id })).toBe(exhausted);
  expect(laneQuotaExhausted({ ...codexError, message: native.message, httpStatus: native.status,
    retryable: hasErrorFlag(native.id, Flag.Transient) })).toBe(exhausted);
});

test.each([
  ["insufficient_quota", true],
  ["rate_limit_exceeded", false],
] as const)("distinguishes billing from throttling in a stock OpenAI 429 (%s)", async (code, exhausted) => {
  const http = new Response(JSON.stringify({ error: { type: code, param: null, code, message: billingDetail } }), { status: 429 });
  const error = await captureOpenAIHttpError(http);
  const native = await finalize(error, {
    provider: "openai", api: "openai-responses", capturedErrorResponse: error.captured,
    rawRequestDump: { provider: "openai", api: "openai-responses", model: "gpt-5.4" },
  });
  expect(laneQuotaExhausted({ ...billingError, provider: "openai-api", message: native.message, httpStatus: native.status,
    retryable: hasErrorFlag(native.id, Flag.Transient) })).toBe(exhausted);
});

const emptyUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function expectNativeQuota(message: AssistantMessage, exhausted: boolean) {
  const receipt = Promise.withResolvers<RpcPromptResultFrame>();
  const prompts = new RpcPromptResults({
    isRunActive: false, isStreaming: false, hasAdmittedSubmission: false, queuedMessageCount: 0,
  }, receipt.resolve);
  const ticket = prompts.begin("native-quota");
  prompts.observe({ type: "agent_start" });
  prompts.observe({ type: "agent_end", messages: [message] });
  prompts.settle(ticket);
  const frame = await receipt.promise;
  expect(frame.status).toBe("error");
  expect({ receipt: laneQuotaExhausted(frame.error), continuation: laneQuotaExhausted(message) })
    .toEqual({ receipt: exhausted, continuation: exhausted });
}

test.each([
  { reason: "QUOTA_EXHAUSTED", api: "google-generative-ai", provider: "google", wire: "http", exhausted: true },
  { reason: "INSUFFICIENT_G1_CREDITS_BALANCE", api: "google-gemini-cli", provider: "google-antigravity", wire: "cloud", exhausted: true },
  { reason: "QUOTA_EXHAUSTED", api: "google-vertex", provider: "google-vertex", wire: "stream", exhausted: true },
  { reason: "QUOTA_EXHAUSTED", api: "google-generative-ai", provider: "google", wire: "stream", noHttpStatus: true, exhausted: true },
  { reason: "RATE_LIMIT_EXCEEDED", api: "google-gemini-cli", provider: "google-antigravity", wire: "cloud", exhausted: false },
  { reason: "MODEL_CAPACITY_EXHAUSTED", api: "google-vertex", provider: "google-vertex", wire: "stream", exhausted: false },
  { reason: "MODEL_CAPACITY_EXCEEDED", api: "google-generative-ai", provider: "google", wire: "http", simultaneousQuota: true, exhausted: false },
  { reason: "QUOTA_EXHAUSTED", api: "google-generative-ai", provider: "google", wire: "http",
    type: "type.googleapis.com/google.rpc.QuotaFailure", exhausted: false },
  { reason: "QUOTA_EXHAUSTED_WINDOW", api: "google-generative-ai", provider: "google", wire: "http", exhausted: false },
] as const)("classifies Google $wire ErrorInfo $reason for receipts and continuations (quota=$exhausted)", async row => {
  const info = { "@type": "type" in row ? row.type : googleErrorInfo, reason: row.reason, domain: "googleapis.com" };
  const details = "simultaneousQuota" in row ? [{ ...info, reason: "QUOTA_EXHAUSTED" }, info] : [info];
  const failure = { ...("noHttpStatus" in row ? {} : { code: 429 }), status: "RESOURCE_EXHAUSTED", message: "Request blocked", details };
  const body = JSON.stringify({ error: failure }, null, 2);
  const error = row.wire === "cloud"
    ? new GeminiCliApiError(`Cloud Code Assist API error (429): ${body}`, 429, { headers: new Headers({ "retry-after": "1" }) })
    : row.wire === "stream" ? googleStreamChunkError(failure, row.provider)
      : new GoogleApiError(`Google API error (429): ${extractGoogleErrorMessage(body, 429)}`, 429);
  const native = await finalize(error, { api: row.api, provider: row.provider });
  await expectNativeQuota({
    role: "assistant", provider: row.provider, api: row.api, model: "google-fixture", timestamp: 0, usage: emptyUsage, content: [],
    stopReason: native.stopReason, errorMessage: native.message, errorStatus: native.status, errorId: native.id,
  }, row.exhausted);
});

test.each([[44, true], [45, false], [50, false]] as const)(
  "classifies stock Cursor Connect code %d for receipts and continuations", async (code, exhausted) => {
    const detail = toBinary(ErrorDetailsSchema, proto(ErrorDetailsSchema, { error: code }));
    const trailer = { error: { code: "resource_exhausted", message: "Request blocked",
      details: [{ type: "aiserver.v1.ErrorDetails", value: Buffer.from(detail).toString("base64") }] } };
    const frame = frameConnectMessage(Buffer.from(JSON.stringify(trailer)), CONNECT_END_STREAM_FLAG);
    const baseUrl = "http://127.0.0.1";
    const model = buildModel({ api: "cursor-agent", provider: "cursor", id: "composer-2.5", name: "Composer fixture",
      baseUrl, input: ["text"], reasoning: false, contextWindow: 65_536, maxTokens: 4096, cost: emptyUsage.cost });
    const fetchStub = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      if (url.origin === baseUrl && url.pathname === CURSOR_RUN_SSE_PATH) return new Response(new Uint8Array(frame));
      if (url.origin === baseUrl && url.pathname === CURSOR_BIDI_APPEND_PATH) return new Response(null);
      throw new Error("Unexpected request from the isolated Cursor fixture");
    }, { preconnect() { throw new Error("Unexpected preconnect from the isolated Cursor fixture"); } }));
    try {
      const message = await streamCursor(model, { messages: [{ role: "user", timestamp: 0, content: "Work" }] }, {
        apiKey: "fixture-only", transport: "http1", providerRetryWait: async () => {},
      }).result();
      expect(message.errorStatus).toBe(429);
      await expectNativeQuota(message, exhausted);
    } finally {
      fetchStub.mockRestore();
    }
  },
);

test("a settled quota failure proves no tool effects without relaxing the HEAD quota hold", () => {
  const owner = { sessionId: "lane-session", sessionFile: "/private/lane.jsonl", requestId: "lane-prompt", cursor: null };
  const run = { sessionId: owner.sessionId, sessionFile: owner.sessionFile, hostPid: 42, instanceKey: "host", runOrdinal: 1 };
  const entries = [
    { id: "start", type: "custom", customType: "rpc_agent_start", data: run },
    { id: "prompt", type: "message", message: { role: "user" } },
    { id: "assistant", type: "message", message: { ...assistantError, model: codexError.model,
      errorMessage: codexMessage, content: [] } },
    { id: "receipt", timestamp: "2026-01-01T00:00:00Z", type: "custom", customType: "rpc_prompt_result",
      data: { ...run, frame: { id: owner.requestId, status: "error", agentInvoked: true, sessionSettled: true, error: codexError } } },
  ];
  expect(headRecoveryEvidence(entries, owner)).toMatchObject({
    settledToolFreeError: true, toolFreeFailure: false, quotaFailure: { model: { provider: codexError.provider, id: codexError.model } },
  });
  const tool = { id: "tool", type: "custom", customType: "tool_execution_start" };
  expect(headRecoveryEvidence([...entries.slice(0, 2), tool, ...entries.slice(2)], owner)).toMatchObject({
    settledToolFreeError: false, toolFreeFailure: false, quotaFailure: null,
  });
});

const receiptOwner = {
  sessionId: "lane-session", sessionFile: "/private/lane.jsonl", requestId: "lane-prompt", hostPid: 42,
};
const receiptRun = { ...receiptOwner, instanceKey: "host", runOrdinal: 1 };
const startEntry = { id: "start", type: "custom", customType: "rpc_agent_start", data: receiptRun };
const userEntry = { id: "prompt", type: "message", message: { role: "user" } };
const assistantEntry = { id: "assistant", type: "message", message: { ...assistantError, errorMessage: codexMessage } };
const receiptTicket = { type: "prompt_result", id: receiptOwner.requestId, sessionSettled: true, agentInvoked: true };
const receiptFrame = { ...receiptTicket, status: "error", error: codexError };
const receiptEntry = { id: "receipt", type: "custom", customType: "rpc_prompt_result", data: { ...receiptRun, frame: receiptFrame } };
const settledEntries = [startEntry, userEntry, assistantEntry, receiptEntry];

const effectOwner = { ...receiptOwner, cursor: null };
const refusalAssistant: AssistantMessage = {
  role: "assistant", stopReason: "error", stopDetails: { type: "refusal" }, content: [],
  provider: "anthropic", api: "anthropic-messages", model: "refusal-fixture", timestamp: 0, usage: emptyUsage,
  errorMessage: "Refusal (reasoning_extraction): blocked by provider policy",
};
const refusalReceipt = { ...receiptEntry, data: { ...receiptEntry.data, frame: { ...receiptFrame,
  error: { provider: refusalAssistant.provider, model: refusalAssistant.model, message: refusalAssistant.errorMessage, retryable: false },
} } };
const passiveRefusalContent: AssistantMessage["content"] = [
  { type: "thinking", thinking: "Partial reasoning" },
  { type: "redactedThinking", data: "opaque" },
  { type: "fallback", from: { model: "original" }, to: { model: "fallback" } },
  { type: "text", text: "Partial response" },
];
const refusalEntry = { id: "refusal", type: "custom", customType: "provider_refusal",
  data: providerRefusalData({ ...refusalAssistant, content: passiveRefusalContent }) };
const passiveExit = { id: "exit", type: "custom", customType: "session_exit",
  data: { kind: "normal", reason: "dispose", recordedAt: "2026-01-01T00:00:00Z" } };

test("a native pre-tool refusal with passive output remains tool-free across restart bookkeeping", () => {
  const snapshot = { id: "snapshot", type: "custom_message", customType: "eval-state-context", content: "Kernel state", display: false };
  expect(headRecoveryEvidence([startEntry, userEntry, refusalEntry, refusalReceipt, passiveExit, snapshot], effectOwner))
    .toMatchObject({ settledToolFreeError: true, toolFreeFailure: true, quotaFailure: null });
});

test.each([
  { type: "anthropicServerTool", block: { type: "server_tool_use", name: "web_search", id: "srvtoolu_lookup", input: { query: "weather" } } },
  { type: "anthropicServerTool", block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_lookup", content: [] } },
  { type: "toolCall", id: "tool-call", name: "lookup", arguments: {} },
  { type: "image", data: "cG5n", mimeType: "image/png" },
] satisfies AssistantMessage["content"])("a failed turn with $type is not tool-free in either native journal projection", part => {
  const failed = { ...refusalAssistant, content: [...passiveRefusalContent, part] };
  const assistant = { id: "failed", type: "message", message: failed };
  const refusal = { ...refusalEntry, data: providerRefusalData(failed) };
  expect([assistant, refusal].map(entry =>
    headRecoveryEvidence([startEntry, userEntry, entry, refusalReceipt], effectOwner)?.settledToolFreeError))
    .toEqual([false, false]);
});

test.each([
  { name: "one web search", server: { webSearch: 1, webFetch: 0 }, toolFree: false },
  { name: "one web fetch", server: { webSearch: 0, webFetch: 1 }, toolFree: false },
  { name: "both counters zero", server: { webSearch: 0, webFetch: 0 }, toolFree: true },
])("classifies $name from native usage without any retained tool blocks", ({ server, toolFree }) => {
  const failed = { ...refusalAssistant, content: passiveRefusalContent,
    usage: { ...emptyUsage, input: 12, output: 4, totalTokens: 16, server } };
  const assistant = { id: "failed", type: "message", message: failed };
  const refusal = { ...refusalEntry, data: providerRefusalData(failed) };
  const usage = { id: "usage", type: "model_usage", parentId: userEntry.id, timestamp: "2026-01-01T00:00:00Z",
    purpose: "recap", api: failed.api, provider: failed.provider, model: failed.model, usage: failed.usage,
    stopReason: failed.stopReason } satisfies ModelUsageEntry;
  const prove = (...entries: readonly unknown[]) =>
    headRecoveryEvidence([startEntry, userEntry, ...entries], effectOwner)?.settledToolFreeError;

  expect({
    assistant: prove(assistant, refusalReceipt),
    refusal: prove(refusal, refusalReceipt),
    usageOnlyBeforeReceipt: prove(usage, refusalReceipt),
    usageOnlyAfterReceipt: prove(refusalReceipt, usage),
  }).toEqual({ assistant: toolFree, refusal: toolFree, usageOnlyBeforeReceipt: toolFree, usageOnlyAfterReceipt: toolFree });
});

test.each<{ name: string; before?: unknown; after?: unknown }>([
  { name: "a future assistant block",
    before: { id: "assistant", type: "message", message: { ...refusalAssistant, content: [{ type: "futureToolResult" }] } } },
  { name: "an opaque provider history payload", before: { id: "assistant", type: "message", message: { ...refusalAssistant,
    providerPayload: { type: "openaiResponsesHistory", items: [{ type: "web_search_call", status: "completed" }] },
  } } },
  { name: "a refusal without retained content", before: { ...refusalEntry, data: { stopType: "refusal" } } },
  { name: "a future refusal block", before: { ...refusalEntry, data: { ...refusalEntry.data, content: [{ type: "futureToolResult" }] } } },
  { name: "an unknown custom entry", after: { id: "marker", type: "custom", customType: "extension-work-start" } },
  { name: "an unknown custom message", after: { id: "message", type: "custom_message", customType: "extension-prompt", content: "Continue" } },
  { name: "a later provider refusal", after: { ...refusalEntry, id: "later-refusal" } },
  { name: "a later exit with pending tools", after: { ...passiveExit,
    data: { ...passiveExit.data, pendingToolCalls: [{ toolName: "lookup", toolCallId: "late-tool" }] } } },
])("does not prove a tool-free failure with $name", ({ before, after }) => {
  const entries = [startEntry, userEntry, before ?? refusalEntry, refusalReceipt, ...(after ? [after] : [])];
  expect(headRecoveryEvidence(entries, effectOwner)).toMatchObject({ settledToolFreeError: false, toolFreeFailure: false, quotaFailure: null });
});

test.each([
  { provider: "cursor", model: "composer-2.5", message: cursorQuotaMessage },
  { provider: "google-antigravity", model: "gemini-fixture",
    message: `Cloud Code Assist API error (429): ${googleQuotaBody.replace("QUOTA_EXHAUSTED", "INSUFFICIENT_G1_CREDITS_BALANCE")}` },
])("$provider quota leaves HEAD held without granting Codex auto-release", error => {
  const receipt = { ...refusalReceipt, data: { ...receiptRun, frame: { ...receiptFrame,
    error: { ...error, httpStatus: 429, retryable: true },
  } } };
  expect(headRecoveryEvidence([startEntry, userEntry, receipt], effectOwner))
    .toMatchObject({ settledToolFreeError: true, toolFreeFailure: false, quotaFailure: null });
});

test("recovers the owned terminal receipt after tools without borrowing an intermediate assistant response", () => {
  const intermediate = { id: "intermediate", type: "message", message: { role: "assistant", stopReason: "toolUse" } };
  const tool = { id: "tool", type: "message", message: { role: "toolResult" } };
  const usage = { id: "usage", type: "model_usage" };
  const exit = { id: "exit", type: "custom", customType: "session_exit", data: { kind: "normal", reason: "dispose" } };
  expect(settledLaneReceipt([startEntry, userEntry, intermediate, tool, assistantEntry, receiptEntry, usage, exit], receiptOwner))
    .toEqual({ frame: receiptFrame, assistant: assistantEntry.message });
});

test.each<{ name: string; journal: unknown[] }>([
  { name: "wrong PID", journal: [...settledEntries.slice(0, 3), { ...receiptEntry, data: { ...receiptEntry.data, hostPid: 43 } }] },
  { name: "wrong instance", journal: [...settledEntries.slice(0, 3), { ...receiptEntry, data: { ...receiptEntry.data, instanceKey: "different" } }] },
  { name: "wrong ordinal", journal: [...settledEntries.slice(0, 3), { ...receiptEntry, data: { ...receiptEntry.data, runOrdinal: 2 } }] },
  { name: "foreign start", journal: [{ ...startEntry, data: { ...receiptRun, sessionFile: "/private/other.jsonl" } }, ...settledEntries.slice(1)] },
  { name: "different request", journal: [...settledEntries.slice(0, 3),
    { ...receiptEntry, data: { ...receiptEntry.data, frame: { ...receiptFrame, id: "other-prompt" } } }] },
  { name: "unsettled receipt", journal: [...settledEntries.slice(0, 3),
    { ...receiptEntry, data: { ...receiptEntry.data, frame: { ...receiptFrame, sessionSettled: false } } }] },
  { name: "no original user message", journal: [startEntry, assistantEntry, receiptEntry] },
  { name: "overlapping user", journal: [startEntry, userEntry, { ...userEntry, id: "second-user" }, assistantEntry, receiptEntry] },
  { name: "second run before receipt", journal: [startEntry, userEntry,
    { ...startEntry, id: "second-run", data: { ...receiptRun, runOrdinal: 2 } }, assistantEntry, receiptEntry] },
  { name: "second receipt", journal: [...settledEntries, { ...receiptEntry, id: "second-receipt" }] },
  { name: "later assistant", journal: [...settledEntries, { ...assistantEntry, id: "later-assistant" }] },
  { name: "later tool execution", journal: [...settledEntries, { id: "later-tool", type: "custom", customType: "tool_execution_start" }] },
])("refuses to recover when receipt ownership is uncertain: $name", ({ journal }) => {
  expect(settledLaneReceipt(journal, receiptOwner)).toBeNull();
});

test("a completed receipt cannot return a prior assistant's text when the last response was a tool call", () => {
  const completed = { ...receiptEntry, data: { ...receiptEntry.data, frame: { ...receiptTicket, status: "completed" } } };
  const earlier = { id: "prior", type: "message", message: { role: "assistant", stopReason: "stop" } };
  const toolCall = { ...assistantEntry, message: { role: "assistant", stopReason: "toolUse" } };
  expect(settledLaneReceipt([startEntry, userEntry, earlier, toolCall, completed], receiptOwner)).toBeNull();
});

test("recovers a completed receipt with the final native answer", () => {
  const final = { role: "assistant", stopReason: "length", content: [{ type: "text", text: "Final output" }] };
  const frame = { ...receiptTicket, status: "completed" };
  const receipt = { ...receiptEntry, data: { ...receiptEntry.data, frame } };
  expect(settledLaneReceipt([startEntry, userEntry, { ...assistantEntry, message: final }, receipt], receiptOwner))
    .toEqual({ frame, assistant: final });
});

test("recovers an exact aborted receipt without inventing an assistant response", () => {
  const frame = { ...receiptTicket, status: "aborted" };
  const receipt = { ...receiptEntry, data: { ...receiptEntry.data, frame } };
  expect(settledLaneReceipt([startEntry, userEntry, receipt], receiptOwner)).toEqual({ frame });
});
