import { DEFAULT_MODEL, LIMITS } from "./config.js";
import { RUNTIME_INSTRUCTIONS } from "./prompt.js";
import { TEXT_FORMAT } from "./schema.js";
import {
  enforceGates,
  pickMissingFocus,
  buildUserTurns,
  formatUserTurnsBlock,
  selectClarifyMessage,
  mergeBriefCoverage,
  isFirstUserTurn,
  selectFirstTurnMessage,
  READY_REPAIR_FALLBACK
} from "./gate.js";

function extractOutputText(payload) {
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

function parseJsonObject(text) {
  if (!text) return null;
  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (_err) {
    return null;
  }
}

function clipAssistant(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (text.length > LIMITS.maxAssistantChars) {
    return text.slice(0, LIMITS.maxAssistantChars).trim();
  }
  return text;
}

function normalizeSources(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(function (s) {
    if (!s || typeof s !== "object") {
      return { turnId: "", quote: "", aspect: "", operation: "support" };
    }
    return {
      turnId: typeof s.turnId === "string" ? s.turnId.trim() : "",
      quote: typeof s.quote === "string" ? s.quote.trim() : "",
      aspect: typeof s.aspect === "string" ? s.aspect.trim() : "",
      operation: s.operation === "replace" ? "replace" : "support"
    };
  });
}

function normalizeCoverage(raw) {
  const keys = [
    "business",
    "goal",
    "audienceInput",
    "customerJourney",
    "friction",
    "existingTools",
    "desiredFlow"
  ];
  const out = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const item = raw && raw[key] ? raw[key] : {};
    const status =
      item.status === "known" || item.status === "partial" || item.status === "unknown"
        ? item.status
        : "unknown";
    out[key] = { status, sources: normalizeSources(item.sources) };
  }
  return out;
}

function normalizeModelTurn(raw) {
  if (!raw || typeof raw !== "object") return null;

  const phase =
    raw.phase === "clarify" || raw.phase === "recommend" || raw.phase === "handoff"
      ? raw.phase
      : "clarify";
  const recommendationMode =
    raw.recommendationMode === "normal" ||
    raw.recommendationMode === "preliminary" ||
    raw.recommendationMode === "none"
      ? raw.recommendationMode
      : "none";

  const need = raw.nextInformationNeed && typeof raw.nextInformationNeed === "object"
    ? raw.nextInformationNeed
    : { focus: "none", reason: "" };

  return {
    assistantMessage: clipAssistant(raw.assistantMessage),
    phase,
    done: Boolean(raw.done),
    briefCoverage: normalizeCoverage(raw.briefCoverage),
    nextInformationNeed: {
      focus: typeof need.focus === "string" ? need.focus : "none",
      reason: typeof need.reason === "string" ? need.reason : ""
    },
    clarifyFallbackMessage:
      typeof raw.clarifyFallbackMessage === "string" ? raw.clarifyFallbackMessage.trim() : "",
    recommendationMode,
    lowEngagement: Boolean(raw.lowEngagement),
    expertPlan: raw.expertPlan && typeof raw.expertPlan === "object" ? raw.expertPlan : null
  };
}

function buildInstructions(base, userTurns, firstTurn) {
  let text = (base || RUNTIME_INSTRUCTIONS) + "\n\n" + formatUserTurnsBlock(userTurns);
  if (firstTurn) {
    text +=
      "\n\nFIRST_TURN_MODE (server): welcome + free discovery only. " +
      "Put full client-visible welcome in clarifyFallbackMessage. " +
      "Do NOT ask a narrow MVB quiz question (audience/journey/tools). " +
      "recommendationMode=none, expertPlan=null, phase=clarify.";
  }
  return text;
}

async function callOpenAI({ apiKey, model, input, instructions }) {
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, LIMITS.openaiTimeoutMs);

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        instructions: instructions || RUNTIME_INSTRUCTIONS,
        input,
        store: false,
        max_output_tokens: LIMITS.maxOutputTokens,
        text: { format: TEXT_FORMAT }
      })
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let upstreamType = null;
    let upstreamCode = null;
    let upstreamParam = null;
    let upstreamMessage = null;
    try {
      const errorPayload = await response.json();
      const upstreamError =
        errorPayload && typeof errorPayload === "object" ? errorPayload.error : null;
      if (upstreamError && typeof upstreamError === "object") {
        if (typeof upstreamError.type === "string") upstreamType = upstreamError.type;
        if (typeof upstreamError.code === "string") upstreamCode = upstreamError.code;
        if (typeof upstreamError.param === "string") upstreamParam = upstreamError.param;
        if (typeof upstreamError.message === "string") {
          upstreamMessage = upstreamError.message.slice(0, 200);
        }
      }
    } catch (_parseErr) {
      // Ignore non-JSON error bodies; still log status below.
    }
    console.error("[smart-brief] openai_upstream_error", {
      status: response.status,
      type: upstreamType,
      code: upstreamCode,
      param: upstreamParam,
      message: upstreamMessage
    });
    const err = new Error("openai_http_" + response.status);
    err.code = "unavailable";
    throw err;
  }

  const payload = await response.json();
  const rawText = extractOutputText(payload);
  const parsed = parseJsonObject(rawText);
  const turn = normalizeModelTurn(parsed);
  const hasClientText =
    turn &&
    (turn.assistantMessage || turn.clarifyFallbackMessage);
  if (!hasClientText) {
    const err = new Error("empty_or_invalid_model_output");
    err.code = "unavailable";
    throw err;
  }
  return turn;
}

/** Clarify repair when Gate1 still has real missing fields. */
function buildClarifyRepairInstructions(reason, missing, userTurns) {
  const focus = pickMissingFocus(missing);
  const focusHint = focus
    ? "Prefer focus=" + focus + "."
    : "Ask about the first real missing critical field only.";
  return buildInstructions(
    RUNTIME_INSTRUCTIONS +
      "\n\nREPAIR MODE (server): previous turn violated readiness gates (" +
      reason +
      "). Do NOT recommend. recommendationMode MUST be none. phase MUST be clarify. expertPlan MUST be null. " +
      "Ask ONE natural high-information clarifying question. " +
      focusHint +
      " Put that full client-visible question in clarifyFallbackMessage. Update briefCoverage sources honestly from USER_TURNS only. " +
      "Never claim the solution is ready. Never re-ask a field that is already grounded+sufficient.",
    userTurns
  );
}

/**
 * Recommendation repair when Gate1 READY but model stayed on clarify
 * or Expert Gate failed. Must produce recommend + expertPlan; no MVB quiz.
 */
function buildRecommendRepairInstructions(reason, userTurns) {
  return buildInstructions(
    RUNTIME_INSTRUCTIONS +
      "\n\nRECOMMEND REPAIR MODE (server): Gate1 coverage is READY (all critical fields grounded+sufficient). " +
      "Previous output failed recommendation path (" +
      reason +
      "). " +
      "You MUST output phase=recommend, recommendationMode=normal, done=false or true, " +
      "a complete expertPlan (all fields non-empty), and assistantMessage with the client-facing recommendation. " +
      "nextInformationNeed.focus MUST be none. Do NOT ask clarifying MVB questions. " +
      "clarifyFallbackMessage may be empty. " +
      "REUSE BEFORE BUILD: if USER_TURNS / grounded tools show an existing booking system, calendar, prices, " +
      "or embeddable online-booking module, primarySolution and reuseNote MUST integrate/reuse it — " +
      "do NOT propose building booking from scratch. WhatsApp/phone are channels, not a reason to ignore the module. " +
      "briefCoverage: emit only genuinely new sources this turn; prior evidence is already held server-side.",
    userTurns
  );
}

function toRecommendPublic(turn, briefState) {
  return {
    assistantMessage: clipAssistant(turn.assistantMessage),
    phase: turn.phase === "handoff" ? "handoff" : "recommend",
    done: Boolean(turn.done),
    briefState: briefState
  };
}

function toClarifyPublic(turn, missing, briefState, coverage, userTurns) {
  return {
    assistantMessage: clipAssistant(
      selectClarifyMessage(turn, missing, coverage, userTurns)
    ),
    phase: "clarify",
    done: false,
    briefState: briefState
  };
}

function toReadyFallbackPublic(briefState) {
  return {
    assistantMessage: clipAssistant(READY_REPAIR_FALLBACK),
    phase: "clarify",
    done: false,
    briefState: briefState
  };
}

function isRecommendDecision(decision) {
  return (
    decision &&
    decision.action === "allow" &&
    decision.publicTurn &&
    (decision.publicTurn.phase === "recommend" || decision.publicTurn.phase === "handoff")
  );
}

function isCoverageReady(decision) {
  return Boolean(decision && decision.coverageEval && decision.coverageEval.ready);
}

/**
 * INVARIANT: at most ONE OpenAI provider call per POST /api/chat.
 * When coverage is READY but the first model turn is not publishable
 * (clarify / Gate2 fail), never call the provider again — return a
 * deterministic server fallback that does not invent architecture,
 * does not re-ask closed MVB fields, and never publishes ungated text.
 */
function readyUnpublishableFallback(briefState) {
  return toReadyFallbackPublic(briefState);
}

/**
 * Main chat generation with B′ grounding, D′ briefState merge, server-owned routing.
 * Optional callOpenAI inject for deterministic tests.
 *
 * Provider call budget: exactly one `await callModel(...)` in this function.
 * No repair / second-round provider paths remain.
 */
export async function createSmartBriefReply({
  apiKey,
  model,
  history,
  message,
  briefState: priorBriefState,
  callOpenAI: callOpenAIInject
}) {
  const callModel = callOpenAIInject || callOpenAI;
  const userTurns = buildUserTurns(history, message);
  const firstTurn = isFirstUserTurn(history);
  const input = history.concat([{ role: "user", content: message }]).map(function (item) {
    return { role: item.role, content: item.content };
  });
  const instructions = buildInstructions(RUNTIME_INSTRUCTIONS, userTurns, firstTurn);

  // Sole provider round-trip for this request.
  let turn = await callModel({ apiKey, model, input, instructions });

  const merged = mergeBriefCoverage(priorBriefState, turn.briefCoverage, userTurns);
  turn.briefCoverage = merged.coverage;
  const briefState = merged.briefState;

  // Welcome / free-discovery: first user turn must not become MVB FOCUS_PROMPT.
  // Gate/merge still run; recommendation never publishes here.
  if (isFirstUserTurn(history)) {
    return {
      assistantMessage: clipAssistant(selectFirstTurnMessage(turn, message)),
      phase: "clarify",
      done: false,
      briefState: briefState
    };
  }

  let decision = enforceGates(turn, { history, message });

  // Successful recommendation path (Gate1 + Gate2 already passed inside enforceGates).
  if (isRecommendDecision(decision)) {
    return toRecommendPublic(decision.publicTurn, briefState);
  }

  // Gate1 READY but model still on clarify / none → server fallback (no 2nd provider call).
  if (decision.action === "allow" && isCoverageReady(decision)) {
    return readyUnpublishableFallback(briefState);
  }

  // Clarify with real missing fields.
  if (decision.action === "allow") {
    return toClarifyPublic(
      turn,
      decision.coverageEval && decision.coverageEval.missing,
      briefState,
      decision.coverageEval && decision.coverageEval.coverage,
      userTurns
    );
  }

  // Expert Gate failed while coverage READY → server fallback (never publish raw text).
  if (decision.reason === "gate2_fail" && isCoverageReady(decision)) {
    return readyUnpublishableFallback(briefState);
  }

  // Gate1 fail (or other block): server synthesize clarify from `missing`.
  // No second OpenAI round-trip — openaiTimeoutMs × 2 exceeds clientTimeoutMs.
  return toClarifyPublic(
    turn,
    decision.missing || (decision.coverageEval && decision.coverageEval.missing),
    briefState,
    (decision.coverageEval && decision.coverageEval.coverage) || turn.briefCoverage,
    userTurns
  );
}

/** Test helpers (not used by production client). */
export const __test__ = {
  normalizeModelTurn,
  parseJsonObject,
  extractOutputText,
  callOpenAI,
  buildClarifyRepairInstructions,
  buildRecommendRepairInstructions,
  buildRepairInstructions: buildClarifyRepairInstructions,
  toRecommendPublic,
  toClarifyPublic,
  toReadyFallbackPublic,
  readyUnpublishableFallback,
  buildInstructions,
  createSmartBriefReply
};
