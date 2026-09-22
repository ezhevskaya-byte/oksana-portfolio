/**
 * AI provider abstraction for Smart Brief.
 * Providers: openai (default) | yandex (Yandex AI Studio / YandexGPT).
 * Gate/MVB logic stays provider-independent in gate.js + openai.js orchestration.
 */
import { DEFAULT_MODEL, LIMITS } from "./config.js";
import { TEXT_FORMAT, MODEL_TURN_SCHEMA } from "./schema.js";

export const DEFAULT_AI_PROVIDER = "openai";
export const YANDEX_BASE_URL = "https://ai.api.cloud.yandex.net/v1";
export const DEFAULT_YANDEX_MODEL = "yandexgpt-5.1/latest";
/** Default Yandex temperature per AI Studio docs for YandexGPT 5.1 Pro. */
export const DEFAULT_YANDEX_TEMPERATURE = 0.3;

/**
 * Yandex structured-output mode.
 * Official AI Studio OpenAI-compat docs confirm Responses API fields
 * (model/instructions/input/max_output_tokens) but do NOT document
 * OpenAI `text.format` json_schema support for YandexGPT.
 * Default: prompt_json — enforce JSON via instructions; server still validates.
 * Optional: json_schema — attempt OpenAI-compatible TEXT_FORMAT (experimental).
 */
export const DEFAULT_YANDEX_STRUCTURED_OUTPUT = "prompt_json";

function throwCoded(message, code) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Build gpt://<folder>/<model> URI. Accepts full URI or short model id.
 */
export function buildYandexModelUri(folderId, model) {
  const folder = String(folderId || "").trim();
  const raw = String(model || DEFAULT_YANDEX_MODEL).trim() || DEFAULT_YANDEX_MODEL;
  if (raw.indexOf("gpt://") === 0) return raw;
  if (!folder) return "";
  return "gpt://" + folder + "/" + raw.replace(/^\/+/, "");
}

/**
 * Resolve provider config from Worker env / .dev.vars.
 * Never returns secret material in error messages.
 */
export function resolveProviderConfig(env) {
  const source = env && typeof env === "object" ? env : {};
  const name = String(source.AI_PROVIDER || DEFAULT_AI_PROVIDER)
    .trim()
    .toLowerCase();

  if (name === "yandex") {
    const apiKey = source.YANDEX_API_KEY;
    const folderId = String(source.YANDEX_FOLDER_ID || "").trim();
    const modelShort = String(source.YANDEX_MODEL || DEFAULT_YANDEX_MODEL).trim();
    const structuredOutput = String(
      source.YANDEX_STRUCTURED_OUTPUT || DEFAULT_YANDEX_STRUCTURED_OUTPUT
    )
      .trim()
      .toLowerCase();
    if (!nonEmpty(apiKey) || !folderId) {
      return { ok: false, name: "yandex", error: "missing_yandex_config" };
    }
    const modelUri = buildYandexModelUri(folderId, modelShort);
    if (!modelUri) {
      return { ok: false, name: "yandex", error: "missing_yandex_config" };
    }
    return {
      ok: true,
      name: "yandex",
      apiKey: String(apiKey).trim(),
      folderId: folderId,
      model: modelUri,
      baseUrl: YANDEX_BASE_URL,
      temperature: DEFAULT_YANDEX_TEMPERATURE,
      timeoutMs: LIMITS.openaiTimeoutMs,
      // Extra headroom: coverage sources + full expertPlan under prompt_json.
      maxOutputTokens: Math.max(LIMITS.maxOutputTokens, 2800),
      structuredOutput:
        structuredOutput === "json_schema" ? "json_schema" : "prompt_json"
    };
  }

  if (name && name !== "openai") {
    return { ok: false, name: name, error: "unknown_ai_provider" };
  }

  const apiKey = source.OPENAI_API_KEY;
  if (!nonEmpty(apiKey)) {
    return { ok: false, name: "openai", error: "missing_openai_config" };
  }
  const model =
    String(source.OPENAI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  return {
    ok: true,
    name: "openai",
    apiKey: String(apiKey).trim(),
    model: model,
    baseUrl: "https://api.openai.com/v1",
    temperature: null,
    timeoutMs: LIMITS.openaiTimeoutMs,
    structuredOutput: "json_schema"
  };
}

/** Headers for Responses API. Never log these. */
export function buildResponsesHeaders(config) {
  const headers = {
    Authorization: "Bearer " + config.apiKey,
    "Content-Type": "application/json"
  };
  // OpenAI SDK `project=` maps to OpenAI-Project; Yandex AI Studio uses folder id.
  if (config.name === "yandex" && config.folderId) {
    headers["OpenAI-Project"] = config.folderId;
  }
  return headers;
}

/**
 * Compact schema reminder for providers without verified json_schema support.
 * Does not replace server-side validation.
 * Dual-mode: clarify vs READY recommend — Yandex previously over-anchored on expertPlan=null.
 */
export function buildJsonOutputReminder() {
  const keys = Object.keys(MODEL_TURN_SCHEMA.properties || {});
  return (
    "\n\nOUTPUT FORMAT (server, provider=yandex): Return ONLY one JSON object with top-level keys: " +
    keys.join(", ") +
    ".\n" +
    "briefCoverage: use exact USER_TURNS quotes (turnId u1…). " +
    "If a critical field is already fully stated in USER_TURNS, mark it known with grounded sources " +
    "(or empty sources when repeating prior evidence — server holds briefState). " +
    "Never leave business/goal unknown if USER_TURNS already name them.\n" +
    "MODE SELECTION:\n" +
    "A) Still missing critical evidence → phase=clarify, recommendationMode=none, expertPlan=null, " +
    "one clarifying question in clarifyFallbackMessage.\n" +
    "B) ALL seven critical fields are grounded from USER_TURNS (business, goal, audienceInput, " +
    "customerJourney, friction, existingTools, desiredFlow) → you MUST output phase=recommend, " +
    "recommendationMode=normal, nextInformationNeed.focus=none, and a COMPLETE expertPlan object " +
    "with ALL non-empty string fields: realProblem, audienceHypothesis, primarySolution, alternative, " +
    "whyPrimary, reuseNote, startNow, addLater, doNotBuildYet, insight. " +
    "alternative = real alternative OR 'none: <why>'. " +
    "existingTools known → reuseNote must say what to reuse (tables, WhatsApp, booking module, etc.). " +
    "assistantMessage = natural Russian recommendation for the entrepreneur (not JSON dump): " +
    "insight (не «просто сайт»), primary solution + why, alternative, minimum first stage (startNow), " +
    "what later (addLater), what NOT to build yet (doNotBuildYet), reuse of existing tools. " +
    "Do NOT ask another MVB question when recommending.\n" +
    "No markdown fences."
  );
}

/**
 * Build Responses API JSON body. Provider-specific differences are intentional.
 */
export function buildResponsesBody(config, { instructions, input }) {
  let instr = typeof instructions === "string" ? instructions : "";
  if (config.name === "yandex" && config.structuredOutput === "prompt_json") {
    instr += buildJsonOutputReminder();
  }

  const maxOut =
    typeof config.maxOutputTokens === "number"
      ? config.maxOutputTokens
      : LIMITS.maxOutputTokens;

  const body = {
    model: config.model,
    instructions: instr,
    input: input,
    max_output_tokens: maxOut
  };

  if (typeof config.temperature === "number") {
    body.temperature = config.temperature;
  }

  if (config.name === "openai") {
    body.store = false;
    body.text = { format: TEXT_FORMAT };
  } else if (config.name === "yandex") {
    if (config.structuredOutput === "json_schema") {
      body.text = { format: TEXT_FORMAT };
    }
  }

  return body;
}

export function extractOutputText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks = [];

  for (let i = 0; i < output.length; i += 1) {
    const item = output[i];
    if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (let j = 0; j < item.content.length; j += 1) {
      const part = item.content[j];
      if (part && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

/**
 * Safe log fields only — never includes Authorization or apiKey.
 */
export function safeUpstreamLogFields(status, upstreamError) {
  const out = { status: status };
  if (upstreamError && typeof upstreamError === "object") {
    if (typeof upstreamError.type === "string") out.type = upstreamError.type;
    if (typeof upstreamError.code === "string") out.code = upstreamError.code;
    if (typeof upstreamError.param === "string") out.param = upstreamError.param;
    if (typeof upstreamError.message === "string") {
      out.message = upstreamError.message.slice(0, 200);
    }
  }
  return out;
}

/**
 * Assert a serialized log / response body never contains the API key.
 */
export function assertNoSecretLeak(text, apiKey) {
  if (!apiKey || !text) return true;
  return String(text).indexOf(String(apiKey)) === -1;
}

/**
 * One Responses API call for the configured provider.
 * Optional fetchImpl for deterministic tests.
 */
export async function callProvider(
  config,
  { instructions, input },
  options
) {
  if (!config || !config.ok) {
    throwCoded("provider_config_missing", "unavailable");
  }

  const fetchImpl =
    options && typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const parseTurn =
    options && typeof options.parseTurn === "function" ? options.parseTurn : null;

  const controller = new AbortController();
  const timeoutMs =
    typeof config.timeoutMs === "number" ? config.timeoutMs : LIMITS.openaiTimeoutMs;
  const timer = setTimeout(function () {
    controller.abort();
  }, timeoutMs);

  const url = String(config.baseUrl || "").replace(/\/$/, "") + "/responses";
  const headers = buildResponsesHeaders(config);
  const body = buildResponsesBody(config, { instructions, input });

  let response;
  try {
    try {
      response = await fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: headers,
        body: JSON.stringify(body)
      });
    } catch (fetchErr) {
      const aborted =
        Boolean(fetchErr) &&
        (fetchErr.name === "AbortError" ||
          fetchErr.code === 20 ||
          /aborted/i.test(String(fetchErr.message || "")));
      console.error("[smart-brief] provider_fetch_failed", {
        provider: config.name,
        aborted: aborted,
        name: fetchErr && fetchErr.name
      });
      throwCoded(
        aborted ? "provider_timeout" : "provider_fetch_failed",
        aborted ? "provider_timeout" : "unavailable"
      );
    }
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let upstreamError = null;
    try {
      const errorPayload = await response.json();
      upstreamError =
        errorPayload && typeof errorPayload === "object" ? errorPayload.error : null;
    } catch (_parseErr) {
      // Ignore non-JSON error bodies.
    }
    console.error(
      "[smart-brief] provider_upstream_error",
      Object.assign({ provider: config.name }, safeUpstreamLogFields(response.status, upstreamError))
    );
    throwCoded("provider_http_" + response.status, "provider_upstream");
  }

  const payload = await response.json();
  if (payload && payload.status === "incomplete") {
    const reason =
      payload.incomplete_details && typeof payload.incomplete_details.reason === "string"
        ? payload.incomplete_details.reason
        : "unknown";
    console.error("[smart-brief] provider_incomplete", {
      provider: config.name,
      reason: reason
    });
  }

  if (parseTurn) {
    return parseTurn(payload);
  }

  // Default: return raw payload; openai.js parses via extractOutputText + normalize.
  return payload;
}

/**
 * Full provider round-trip → model turn object using shared parsers from openai.js.
 * Kept separate so openai.js can inject parse helpers without circular init issues.
 */
export async function callProviderForTurn(config, args, parsers, options) {
  const t0 = Date.now();
  const payload = await callProvider(config, args, options);
  const rawText = parsers.extractOutputText(payload);
  const parsed = parsers.parseJsonObject(rawText);
  const turn = parsers.normalizeModelTurn(parsed);
  const hasClientText =
    turn && (turn.assistantMessage || turn.clarifyFallbackMessage);

  let planFilled = 0;
  if (turn && turn.expertPlan && typeof turn.expertPlan === "object") {
    const keys = Object.keys(turn.expertPlan);
    for (let i = 0; i < keys.length; i += 1) {
      const v = turn.expertPlan[keys[i]];
      if (typeof v === "string" && v.trim()) planFilled += 1;
    }
  }

  console.error("[smart-brief] provider_turn_meta", {
    provider: config.name,
    ms: Date.now() - t0,
    incomplete: payload && payload.status === "incomplete" ? true : false,
    incompleteReason:
      payload &&
      payload.incomplete_details &&
      typeof payload.incomplete_details.reason === "string"
        ? payload.incomplete_details.reason
        : null,
    outputChars: rawText ? rawText.length : 0,
    parsed: Boolean(parsed),
    phase: turn ? turn.phase : null,
    recommendationMode: turn ? turn.recommendationMode : null,
    planFilled: planFilled,
    hasClientText: Boolean(hasClientText)
  });

  if (!hasClientText) {
    throwCoded("empty_or_invalid_model_output", "empty_or_invalid_model_output");
  }
  return turn;
}
