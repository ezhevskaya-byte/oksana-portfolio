import { DEFAULT_MODEL, LIMITS } from "./config.js";
import { RUNTIME_INSTRUCTIONS } from "./prompt.js";
import {
  enforceGates,
  pickMissingFocus,
  evaluateBriefReady,
  buildUserTurns,
  formatUserTurnsBlock,
  selectClarifyMessage,
  mergeBriefCoverage,
  isFirstUserTurn,
  selectFirstTurnMessage,
  READY_REPAIR_FALLBACK
} from "./gate.js";
import {
  callProviderForTurn,
  extractOutputText as providerExtractOutputText,
  buildResponsesBody,
  buildResponsesHeaders,
  resolveProviderConfig
} from "./provider.js";

function emptyCoverageSkeleton() {
  return {
    business: { status: "unknown", sources: [] },
    goal: { status: "unknown", sources: [] },
    audienceInput: { status: "unknown", sources: [] },
    customerJourney: { status: "unknown", sources: [] },
    friction: { status: "unknown", sources: [] },
    existingTools: { status: "unknown", sources: [] },
    desiredFlow: { status: "unknown", sources: [] }
  };
}

function throwCoded(message, code) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function extractOutputText(payload) {
  return providerExtractOutputText(payload);
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

const turnParsers = {
  extractOutputText: extractOutputText,
  parseJsonObject: parseJsonObject,
  normalizeModelTurn: normalizeModelTurn
};

/**
 * Legacy OpenAI-only call (kept for inject tests + OpenAI default path).
 */
async function callOpenAI({ apiKey, model, input, instructions }) {
  const config = {
    ok: true,
    name: "openai",
    apiKey: apiKey,
    model: model || DEFAULT_MODEL,
    baseUrl: "https://api.openai.com/v1",
    temperature: null,
    timeoutMs: LIMITS.openaiTimeoutMs,
    structuredOutput: "json_schema"
  };
  return callProviderForTurn(config, { instructions, input }, turnParsers);
}

/**
 * Soft degrade after the sole provider call produced unusable output.
 * Preserves briefState continuum; never invents recommend/expertPlan; no 2nd provider call.
 */
function softDegradeFromPrior(priorBriefState, userTurns) {
  const merged = mergeBriefCoverage(priorBriefState, emptyCoverageSkeleton(), userTurns);
  const ready = evaluateBriefReady(merged.coverage, userTurns);
  if (ready.ready) {
    return readyUnpublishableFallback(merged.briefState);
  }
  return toClarifyPublic(
    {
      assistantMessage: "",
      phase: "clarify",
      done: false,
      briefCoverage: merged.coverage,
      nextInformationNeed: { focus: "none", reason: "empty_model_output" },
      clarifyFallbackMessage: "",
      recommendationMode: "none",
      lowEngagement: false,
      expertPlan: null
    },
    ready.missing,
    merged.briefState,
    merged.coverage,
    userTurns
  );
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
 * INVARIANT: at most ONE provider model call per POST /api/chat.
 */
function readyUnpublishableFallback(briefState) {
  return toReadyFallbackPublic(briefState);
}

/**
 * Main chat generation with B′ grounding, D′ briefState merge, server-owned routing.
 * Optional callOpenAI inject for deterministic tests (legacy name preserved).
 *
 * Provider call budget: exactly one `await callModel(...)` in this function.
 *
 * Accepts either legacy { apiKey, model } or { providerConfig } from resolveProviderConfig.
 */
export async function createSmartBriefReply({
  apiKey,
  model,
  providerConfig,
  history,
  message,
  briefState: priorBriefState,
  callOpenAI: callOpenAIInject
}) {
  const callModel =
    callOpenAIInject ||
    async function (args) {
      if (providerConfig && providerConfig.ok) {
        return callProviderForTurn(providerConfig, args, turnParsers);
      }
      return callOpenAI({
        apiKey: apiKey,
        model: model,
        input: args.input,
        instructions: args.instructions
      });
    };

  const userTurns = buildUserTurns(history, message);
  const firstTurn = isFirstUserTurn(history);
  const input = history.concat([{ role: "user", content: message }]).map(function (item) {
    return { role: item.role, content: item.content };
  });
  const instructions = buildInstructions(RUNTIME_INSTRUCTIONS, userTurns, firstTurn);

  // Sole provider round-trip for this request.
  let turn;
  try {
    turn = await callModel({ apiKey, model, input, instructions });
  } catch (err) {
    if (err && err.code === "empty_or_invalid_model_output") {
      return softDegradeFromPrior(priorBriefState, userTurns);
    }
    throw err;
  }

  const merged = mergeBriefCoverage(priorBriefState, turn.briefCoverage, userTurns);
  turn.briefCoverage = merged.coverage;
  const briefState = merged.briefState;

  if (isFirstUserTurn(history)) {
    return {
      assistantMessage: clipAssistant(selectFirstTurnMessage(turn, message)),
      phase: "clarify",
      done: false,
      briefState: briefState
    };
  }

  const decision = enforceGates(turn, { history, message });

  if (isRecommendDecision(decision)) {
    return toRecommendPublic(decision.publicTurn, briefState);
  }

  if (decision.action === "allow" && isCoverageReady(decision)) {
    console.error("[smart-brief] ready_fallback", {
      reason: "model_not_publishable_recommend",
      phase: turn.phase,
      recommendationMode: turn.recommendationMode,
      hasPlan: Boolean(turn.expertPlan)
    });
    return readyUnpublishableFallback(briefState);
  }

  if (decision.action === "allow") {
    return toClarifyPublic(
      turn,
      decision.coverageEval && decision.coverageEval.missing,
      briefState,
      decision.coverageEval && decision.coverageEval.coverage,
      userTurns
    );
  }

  if (decision.reason === "gate2_fail" && isCoverageReady(decision)) {
    console.error("[smart-brief] ready_fallback", {
      reason: "gate2_fail",
      issues: decision.gate2Issues || []
    });
    return readyUnpublishableFallback(briefState);
  }

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
  softDegradeFromPrior,
  buildInstructions,
  createSmartBriefReply,
  buildResponsesBody,
  buildResponsesHeaders,
  resolveProviderConfig
};
