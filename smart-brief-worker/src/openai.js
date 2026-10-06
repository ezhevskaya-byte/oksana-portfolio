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
  READY_REPAIR_FALLBACK,
  evaluateSolutionReady,
  needsSolutionDiscriminator,
  buildEvidenceBackedRecommendation,
  evaluateExpertPlan,
  pickSolutionDiscriminatorQuestion,
  publishClarifyQuestion
} from "./gate.js";
import {
  callProviderForTurn,
  extractOutputText as providerExtractOutputText,
  buildResponsesBody,
  buildResponsesHeaders,
  resolveProviderConfig
} from "./provider.js";
import { trimHistoryForModel } from "./validate.js";

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
 * BRIEF_READY + !SOLUTION_READY → contextual discriminator.
 * BRIEF_READY + SOLUTION_READY → evidence-backed safe recommend (never READY_REPAIR text).
 */
function softDegradeFromPrior(priorBriefState, userTurns, history) {
  const merged = mergeBriefCoverage(priorBriefState, emptyCoverageSkeleton(), userTurns);
  if (needsSolutionDiscriminator(merged.coverage, userTurns)) {
    return toSolutionDiscriminatorPublic(
      merged.coverage,
      userTurns,
      merged.briefState,
      null,
      history
    );
  }
  const ready = evaluateBriefReady(merged.coverage, userTurns);
  if (ready.ready) {
    return publishSafeRecommendation(
      merged.coverage,
      userTurns,
      merged.briefState,
      "soft_degrade_ready",
      history
    );
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
    userTurns,
    history
  );
}

/** Deterministic SOLUTION_DISCRIMINATOR clarify — never READY_REPAIR_FALLBACK. */
function toSolutionDiscriminatorPublic(coverage, userTurns, briefState, turn, history) {
  const sol = evaluateSolutionReady(coverage, userTurns);
  return toClarifyPublic(
    turn || {
      assistantMessage: "",
      phase: "clarify",
      done: false,
      briefCoverage: coverage,
      nextInformationNeed: { focus: "none", reason: "solution_not_ready" },
      clarifyFallbackMessage: sol.question || "",
      recommendationMode: "none",
      lowEngagement: false,
      expertPlan: null
    },
    [{ key: "solution_discriminator", reason: sol.reason || "need_discriminator" }],
    briefState,
    coverage,
    userTurns,
    history
  );
}

/**
 * When BRIEF+SOLUTION ready but provider output is unpublishable:
 * publish Gate2-valid evidence-backed recommendation instead of technical failure.
 */
function publishSafeRecommendation(coverage, userTurns, briefState, reason, history) {
  const hist = Array.isArray(history) ? history : [];
  const built = buildEvidenceBackedRecommendation(coverage, userTurns, hist);
  // After explicit USER rejection OR unmatched problem shape — clarify, never DEFAULT boilerplate.
  if (
    built.replanned ||
    built.unmatched ||
    built.recommendationMode === "none" ||
    built.phase === "clarify"
  ) {
    console.error("[smart-brief] safe_recommend_replanned", {
      reason: reason,
      unmatched: Boolean(built.unmatched)
    });
    return {
      assistantMessage: clipAssistant(built.assistantMessage || built.clarifyFallbackMessage || ""),
      phase: "clarify",
      done: false,
      briefState: briefState
    };
  }
  const probe = {
    assistantMessage: built.assistantMessage,
    phase: "recommend",
    done: Boolean(built.done),
    briefCoverage: coverage,
    nextInformationNeed: { focus: "none", reason: "" },
    clarifyFallbackMessage: "",
    recommendationMode: "normal",
    lowEngagement: false,
    expertPlan: built.expertPlan
  };
  const planEval = evaluateExpertPlan(probe, coverage, userTurns);
  if (planEval.ok) {
    console.error("[smart-brief] safe_recommend", { reason: reason, issues: [], shape: built.problemShape });
    return toRecommendPublic(probe, briefState, coverage, userTurns, hist);
  }
  console.error("[smart-brief] safe_recommend_blocked", {
    reason: reason,
    issues: planEval.issues || []
  });
  const sol = evaluateSolutionReady(coverage, userTurns);
  if (!sol.ready && sol.question) {
    const disc = publishClarifyQuestion(
      sol.question,
      coverage,
      userTurns || [],
      [{ key: "solution_discriminator", reason: sol.reason || "need_discriminator" }],
      hist
    );
    if (disc && String(disc).trim()) {
      return {
        assistantMessage: clipAssistant(disc),
        phase: "clarify",
        done: false,
        briefState: briefState
      };
    }
  }
  // Never force unmatched / DEFAULT recommend. Replan clarify instead.
  const fallback = buildEvidenceBackedRecommendation(coverage, userTurns, hist);
  if (
    fallback.replanned ||
    fallback.unmatched ||
    fallback.recommendationMode === "none" ||
    fallback.phase === "clarify" ||
    !fallback.expertPlan
  ) {
    console.error("[smart-brief] safe_recommend_no_match", { reason: reason });
    return {
      assistantMessage: clipAssistant(
        fallback.assistantMessage ||
          fallback.clarifyFallbackMessage ||
          "Чтобы предложить точное решение, уточните, что сейчас важнее: заранее объяснить условия или ускорить запись/заявку?"
      ),
      phase: "clarify",
      done: false,
      briefState: briefState
    };
  }
  console.error("[smart-brief] safe_recommend_force", { reason: reason, shape: fallback.problemShape });
  return toRecommendPublic(
    {
      assistantMessage: fallback.assistantMessage,
      phase: "recommend",
      done: true,
      recommendationMode: "normal",
      nextInformationNeed: { focus: "none", reason: "" },
      clarifyFallbackMessage: "",
      lowEngagement: false,
      expertPlan: fallback.expertPlan
    },
    briefState,
    coverage,
    userTurns,
    hist
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

function toRecommendPublic(turn, briefState, coverage, userTurns, history) {
  // Hard stop: never publish recommend while Gate1 brief is incomplete.
  if (coverage && userTurns) {
    const brief = evaluateBriefReady(coverage, userTurns);
    if (!brief.ready) {
      const hist = Array.isArray(history) ? history : [];
      // Direct selectClarify — do NOT route through toClarifyPublic/publishSafeRecommendation
      // (that pair can recurse when brief stays incomplete).
      const text = selectClarifyMessage(
        {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          nextInformationNeed: { focus: "none", reason: "block_premature_recommend" },
          clarifyFallbackMessage: "",
          recommendationMode: "none",
          lowEngagement: false,
          expertPlan: null
        },
        brief.missing,
        brief.coverage || coverage,
        userTurns,
        hist
      );
      if (text && String(text).trim() && text !== READY_REPAIR_FALLBACK) {
        return {
          assistantMessage: clipAssistant(text),
          phase: "clarify",
          done: false,
          briefState: briefState
        };
      }
      // Clarify exhausted while brief still open — continue with evidence recommend
      // rather than looping or emitting READY_REPAIR.
    }
  }
  return {
    assistantMessage: clipAssistant(turn.assistantMessage),
    phase: turn.phase === "handoff" ? "handoff" : "recommend",
    done: Boolean(turn.done),
    briefState: briefState
  };
}

function toClarifyPublic(turn, missing, briefState, coverage, userTurns, history) {
  let text = selectClarifyMessage(turn, missing, coverage, userTurns, history);
  const brief = evaluateBriefReady(coverage, userTurns || []);
  const sol = evaluateSolutionReady(coverage, userTurns || []);

  if (!text || !String(text).trim() || text === READY_REPAIR_FALLBACK) {
    if (brief.ready && sol.ready) {
      return publishSafeRecommendation(
        coverage,
        userTurns,
        briefState,
        "publish_gate_ready_no_clarify",
        history
      );
    }
    if (brief.ready) {
      const disc = publishClarifyQuestion(
        sol.question || pickSolutionDiscriminatorQuestion(coverage, userTurns || []),
        coverage,
        userTurns || [],
        [{ key: "solution_discriminator", reason: "brief_ready_disc" }],
        history || []
      );
      if (disc && String(disc).trim() && disc !== READY_REPAIR_FALLBACK) {
        return {
          assistantMessage: clipAssistant(disc),
          phase: "clarify",
          done: false,
          briefState: briefState
        };
      }
      return publishSafeRecommendation(
        coverage,
        userTurns,
        briefState,
        "brief_ready_force_recommend",
        history
      );
    }
    // Not brief-ready and empty/repair — ask next real missing field (not disc).
    text = selectClarifyMessage(
      {
        assistantMessage: "",
        phase: "clarify",
        done: false,
        nextInformationNeed: { focus: "none", reason: "empty_after_publish" },
        clarifyFallbackMessage: "",
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      },
      brief.missing || missing || [],
      coverage,
      userTurns,
      history
    );
  }

  if (!String(text || "").trim()) {
    return publishSafeRecommendation(
      coverage,
      userTurns,
      briefState,
      "empty_clarify_last_resort",
      history
    );
  }

  return {
    assistantMessage: clipAssistant(text),
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
  // Trim only the provider-facing transcript — never the gate/coverage history.
  const modelHistory = trimHistoryForModel(history);
  // Gates must see the CURRENT user reply after the last MARK ask; otherwise
  // exact/aspect no-repeat never fires on the turn the user just answered.
  const gateHistory =
    typeof message === "string" && message.trim()
      ? (Array.isArray(history) ? history : []).concat([
          { role: "user", content: String(message).trim() }
        ])
      : Array.isArray(history)
        ? history
        : [];
  const input = modelHistory.concat([{ role: "user", content: message }]).map(function (item) {
    return { role: item.role, content: item.content };
  });
  const instructions = buildInstructions(RUNTIME_INSTRUCTIONS, userTurns, firstTurn);

  // Sole provider round-trip for this request.
  let turn;
  try {
    turn = await callModel({ apiKey, model, input, instructions });
  } catch (err) {
    if (err && err.code === "empty_or_invalid_model_output") {
      return softDegradeFromPrior(priorBriefState, userTurns, gateHistory);
    }
    // Fail-safe: if provider dies exactly when we only need a solution discriminator,
    // continue from deterministic state instead of hard 503 / generic recommend failure.
    if (err && (err.code === "provider_timeout" || err.code === "provider_upstream")) {
      const probe = mergeBriefCoverage(priorBriefState, emptyCoverageSkeleton(), userTurns);
      if (needsSolutionDiscriminator(probe.coverage, userTurns)) {
        return toSolutionDiscriminatorPublic(
          probe.coverage,
          userTurns,
          probe.briefState,
          null,
          gateHistory
        );
      }
      const readyProbe = evaluateBriefReady(probe.coverage, userTurns);
      if (readyProbe.ready) {
        return publishSafeRecommendation(
          probe.coverage,
          userTurns,
          probe.briefState,
          err.code,
          gateHistory
        );
      }
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

  // BRIEF_READY + !SOLUTION_READY: never enter recommend publish / generic failure.
  if (needsSolutionDiscriminator(merged.coverage, userTurns)) {
    return toSolutionDiscriminatorPublic(merged.coverage, userTurns, briefState, turn, gateHistory);
  }

  const decision = enforceGates(turn, { history: gateHistory, message });

  if (isRecommendDecision(decision)) {
    return toRecommendPublic(
      decision.publicTurn,
      briefState,
      (decision.coverageEval && decision.coverageEval.coverage) || merged.coverage,
      userTurns,
      gateHistory
    );
  }

  if (decision.reason === "solution_not_ready") {
    return toSolutionDiscriminatorPublic(
      (decision.coverageEval && decision.coverageEval.coverage) || turn.briefCoverage,
      userTurns,
      briefState,
      turn,
      gateHistory
    );
  }

  if (decision.action === "allow" && isCoverageReady(decision)) {
    const cov =
      (decision.coverageEval && decision.coverageEval.coverage) || turn.briefCoverage;
    const sol = evaluateSolutionReady(cov, userTurns);
    if (!sol.ready) {
      return toSolutionDiscriminatorPublic(cov, userTurns, briefState, turn, gateHistory);
    }
    console.error("[smart-brief] ready_fallback", {
      reason: "model_not_publishable_recommend",
      phase: turn.phase,
      recommendationMode: turn.recommendationMode,
      hasPlan: Boolean(turn.expertPlan)
    });
    return publishSafeRecommendation(cov, userTurns, briefState, "model_not_publishable_recommend", gateHistory);
  }

  if (decision.action === "allow") {
    return toClarifyPublic(
      turn,
      decision.coverageEval && decision.coverageEval.missing,
      briefState,
      decision.coverageEval && decision.coverageEval.coverage,
      userTurns,
      gateHistory
    );
  }

  if (decision.reason === "gate2_fail" && isCoverageReady(decision)) {
    const cov = (decision.coverageEval && decision.coverageEval.coverage) || turn.briefCoverage;
    if (needsSolutionDiscriminator(cov, userTurns)) {
      return toSolutionDiscriminatorPublic(cov, userTurns, briefState, turn, gateHistory);
    }
    console.error("[smart-brief] ready_fallback", {
      reason: "gate2_fail",
      issues: decision.gate2Issues || []
    });
    return publishSafeRecommendation(cov, userTurns, briefState, "gate2_fail", gateHistory);
  }

  return toClarifyPublic(
    turn,
    decision.missing || (decision.coverageEval && decision.coverageEval.missing),
    briefState,
    (decision.coverageEval && decision.coverageEval.coverage) || turn.briefCoverage,
    userTurns,
    gateHistory
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
