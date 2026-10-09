/**
 * Smart Brief dialogue controller (source of truth: SMART-BRIEF-DIALOGUE.md).
 * Coverage fields = memory/evidence. This module drives conversation via
 * project stage + sufficient understanding + useful next step — not MVB quiz order.
 */

const R = "[а-яёa-z0-9]*";

function normalizeSpan(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function combineUserText(userTurns) {
  const parts = [];
  for (let i = 0; i < (userTurns || []).length; i += 1) {
    if (userTurns[i] && isNonEmptyString(userTurns[i].text)) parts.push(userTurns[i].text);
  }
  return normalizeSpan(parts.join(" "));
}

function fieldStatus(coverage, key) {
  if (!coverage || !coverage[key]) return "unknown";
  const sources = Array.isArray(coverage[key].sources) ? coverage[key].sources : [];
  // Never trust forged status without sources — grounding lives in gate merge/ready.
  if (!sources.length) return "unknown";
  const s = coverage[key].status;
  if (s === "known" || s === "partial") return s;
  return "partial";
}

function hasSources(coverage, key) {
  return (
    coverage &&
    coverage[key] &&
    Array.isArray(coverage[key].sources) &&
    coverage[key].sources.length > 0
  );
}

function audienceAspects(coverage) {
  const sources =
    coverage && coverage.audienceInput && Array.isArray(coverage.audienceInput.sources)
      ? coverage.audienceInput.sources
      : [];
  let who = false;
  let matters = false;
  for (let i = 0; i < sources.length; i += 1) {
    const a = sources[i] && sources[i].aspect;
    if (a === "who_or_segment") who = true;
    if (a === "what_matters") matters = true;
  }
  // Heuristic fallback from quotes when aspect missing.
  for (let i = 0; i < sources.length; i += 1) {
    const q = normalizeSpan(sources[i] && sources[i].quote);
    if (!q) continue;
    if (/(?:в основном|чаще|обычно).{0,40}(?:женщин|мужчин|семь|пар|клиент|покупател|гост|ученик)/.test(q)) {
      who = true;
    }
    if (/важн|при выборе|критери|сомнева/.test(q)) matters = true;
  }
  return { who, matters };
}

function marksUnknown(blob) {
  return /не\s+знаю|пока\s+не\s+знаю|пока\s+нет|ещё\s+нет|еще\s+нет|не\s+определ|клиентов\s+пока\s+нет|аудитор\w*\s+пока\s+нет|процессов\s+пока\s+нет/.test(
    blob
  );
}

/**
 * @returns {"EXISTING"|"LAUNCH"|"IDEA"}
 */
export function detectProjectStage(userTurns, coverage) {
  const blob = combineUserText(userTurns);
  if (!blob) return "EXISTING";

  const ideaCue =
    /с\s+нуля|пока\s+идея|есть\s+идея|хочу\s+(?:сделать|создать|запустить).{0,40}(?:приложен|сервис|бот|сайт|платформ)|клиентов\s+пока\s+нет|ещё\s+не\s+запуска|еще\s+не\s+запуска|проекта\s+пока\s+нет|только\s+задум/.test(
      blob
    );
  const launchCue =
    /готовым\s+к\s+запуск|перед\s+запуск|собираюсь\s+запуск|скоро\s+открыв|в\s+процессе\s+запуск|mvp|пилотн/.test(
      blob
    );
  const existingCue =
    /у\s+меня\s+(?:уже\s+)?(?:есть|работает)|магазин\s+работает|сейчас\s+(?:клиент|гост|покупател|ученик)|уже\s+(?:принима|прода|вед|работа)/.test(
      blob
    ) ||
    fieldStatus(coverage, "customerJourney") !== "unknown" ||
    fieldStatus(coverage, "friction") !== "unknown";

  if (ideaCue && !existingCue) return "IDEA";
  if (launchCue && !existingCue) return "LAUNCH";
  if (ideaCue && launchCue) return "LAUNCH";
  return "EXISTING";
}

/**
 * Sufficient understanding for a digital recommendation — NOT "all MVB known".
 */
export function assessDialogueUnderstanding(coverage, userTurns) {
  const stage = detectProjectStage(userTurns, coverage);
  const blob = combineUserText(userTurns);
  const unknownOk = marksUnknown(blob);
  const aud = audienceAspects(coverage);
  const biz = fieldStatus(coverage, "business");
  const goal = fieldStatus(coverage, "goal");
  const journey = fieldStatus(coverage, "customerJourney");
  const friction = fieldStatus(coverage, "friction");
  const tools = fieldStatus(coverage, "existingTools");
  const flow = fieldStatus(coverage, "desiredFlow");
  const audience = fieldStatus(coverage, "audienceInput");

  const gaps = [];

  if (stage === "IDEA") {
    if (biz === "unknown" && !hasSources(coverage, "business")) {
      gaps.push({ key: "business", reason: "what_creating" });
    }
    if (goal === "unknown" && flow === "unknown") {
      gaps.push({ key: "goal", reason: "desired_outcome_or_future_flow" });
    }
    if (!aud.who && audience === "unknown" && !unknownOk) {
      gaps.push({ key: "audienceInput", aspect: "who_or_segment", reason: "future_users" });
    }
    if (flow === "unknown" && goal === "known" && gaps.length === 0) {
      // Prefer future interaction model before recommend when only goal is soft.
      if (!/сам[аи]?\s+|сайт|бот|приложен|лендинг|каталог/.test(blob)) {
        gaps.push({ key: "desiredFlow", reason: "future_user_action" });
      }
    }
    return {
      stage,
      sufficient: gaps.length === 0,
      gaps,
      unknownOk
    };
  }

  if (stage === "LAUNCH") {
    if (biz === "unknown") gaps.push({ key: "business", reason: "what_offering" });
    if (goal === "unknown") gaps.push({ key: "goal", reason: "desired_outcome" });
    if (!aud.who && audience === "unknown" && !unknownOk) {
      gaps.push({ key: "audienceInput", aspect: "who_or_segment", reason: "audience" });
    }
    if (journey === "unknown" && flow === "unknown") {
      gaps.push({ key: "customerJourney", reason: "path_or_future_flow" });
    }
    return {
      stage,
      sufficient: gaps.length === 0,
      gaps,
      unknownOk
    };
  }

  // EXISTING — partial compound fields still need a useful next aspect.
  if (biz === "unknown") gaps.push({ key: "business", reason: "business" });
  if (goal === "unknown") gaps.push({ key: "goal", reason: "desired_outcome" });
  if (!aud.who) {
    gaps.push({ key: "audienceInput", aspect: "who_or_segment", reason: "who" });
  } else if (!aud.matters) {
    gaps.push({ key: "audienceInput", aspect: "what_matters", reason: "what_matters" });
  }
  if (journey !== "known") {
    gaps.push({ key: "customerJourney", reason: "current_path" });
  }
  if (friction === "unknown" && flow === "unknown") {
    gaps.push({ key: "friction", reason: "pain_or_future_flow" });
  }
  if (tools !== "known") {
    gaps.push({ key: "existingTools", reason: "tools" });
  }
  if (flow !== "known" && friction !== "unknown" && tools !== "unknown") {
    gaps.push({ key: "desiredFlow", reason: "ideal_flow" });
  }

  return {
    stage,
    sufficient: gaps.length === 0,
    gaps,
    unknownOk
  };
}

const STEP_PROMPTS = {
  business:
    "Расскажите немного подробнее: что именно вы хотите создать или чем занимаетесь для клиентов?",
  goal: "Какого результата вы хотите добиться в первую очередь — что должно измениться?",
  who_existing: "Кто чаще всего к вам обращается — какой это тип клиентов?",
  who_idea:
    "Если представить человека, который первым воспользуется вашим предложением — кто это скорее всего будет? Если пока неясно — так и скажите.",
  what_matters: "А что для этих людей обычно важнее всего при выборе?",
  journey_existing:
    "Как сейчас обычно проходит путь клиента: от первого знакомства до заявки или покупки?",
  journey_launch:
    "Как вы сейчас представляете путь человека к вам — от первого касания до нужного действия?",
  friction: "Что в работе вашего бизнеса вы хотели бы улучшить в первую очередь?",
  tools: "Какими инструментами вы уже пользуетесь: сайт, соцсети, CRM, таблицы, заявки, бот?",
  flow_existing:
    "Как бы вы хотели, чтобы этот первый этап общения с клиентом выглядел в идеале?",
  flow_idea:
    "Как в идеале должен выглядеть первый шаг будущего пользователя — что он делает и какой результат получает?",
  unknown_soft:
    "Это нормально, если пока не всё определено. Давайте зафиксируем неизвестность и посмотрим на желаемый результат: что должно стать проще или понятнее для человека?"
};

/**
 * Plan one useful next step. Returns null when understanding is sufficient.
 */
export function planNextUsefulStep(coverage, userTurns, options) {
  const opts = options || {};
  const understanding = assessDialogueUnderstanding(coverage, userTurns);
  if (understanding.sufficient) {
    return {
      kind: "sufficient",
      stage: understanding.stage,
      question: null,
      focus: null,
      aspect: null,
      reason: "understanding_sufficient"
    };
  }

  const gap = understanding.gaps[0];
  const stage = understanding.stage;
  let question = STEP_PROMPTS.goal;
  let focus = gap.key;
  let aspect = gap.aspect || null;

  if (gap.key === "business") {
    question = STEP_PROMPTS.business;
  } else if (gap.key === "goal") {
    question = STEP_PROMPTS.goal;
  } else if (gap.key === "audienceInput" && gap.aspect === "what_matters") {
    question = STEP_PROMPTS.what_matters;
    aspect = "what_matters";
  } else if (gap.key === "audienceInput") {
    question = stage === "IDEA" ? STEP_PROMPTS.who_idea : STEP_PROMPTS.who_existing;
    aspect = "who_or_segment";
  } else if (gap.key === "customerJourney") {
    question = stage === "EXISTING" ? STEP_PROMPTS.journey_existing : STEP_PROMPTS.journey_launch;
  } else if (gap.key === "friction") {
    question = STEP_PROMPTS.friction;
  } else if (gap.key === "existingTools") {
    question = STEP_PROMPTS.tools;
  } else if (gap.key === "desiredFlow") {
    question = stage === "IDEA" ? STEP_PROMPTS.flow_idea : STEP_PROMPTS.flow_existing;
  }

  if (understanding.unknownOk && gap.reason === "future_users") {
    question = STEP_PROMPTS.unknown_soft;
    focus = "goal";
    aspect = null;
  }

  // Strategy shift when history shows repeated aspect asks.
  if (opts.forceStrategyShift) {
    if (focus === "audienceInput") {
      question = STEP_PROMPTS.flow_existing;
      focus = "desiredFlow";
      aspect = null;
    } else if (focus === "goal") {
      question = stage === "IDEA" ? STEP_PROMPTS.flow_idea : STEP_PROMPTS.friction;
      focus = stage === "IDEA" ? "desiredFlow" : "friction";
    }
  }

  return {
    kind: "clarify",
    stage,
    question,
    focus,
    aspect,
    reason: gap.reason || "gap",
    gaps: understanding.gaps
  };
}

/**
 * Gate1 replacement: dialogue sufficiency OR legacy full MVB ready.
 * `evaluateBriefReadyFn` injected to avoid circular imports at call sites that already have it.
 */
export function evaluateDialogueReady(coverage, userTurns, evaluateBriefReadyFn) {
  const mvb =
    typeof evaluateBriefReadyFn === "function"
      ? evaluateBriefReadyFn(coverage, userTurns)
      : { ready: false, missing: [], coverage: coverage };

  // Always assess on re-derived coverage (forged status stripped by evaluateBriefReady).
  const groundedCoverage = mvb.coverage || coverage;
  const understanding = assessDialogueUnderstanding(groundedCoverage, userTurns);
  // Dialogue may finish early, but never bypass failed grounding on hard fields.
  const hardBlocked = (mvb.missing || []).some(function (m) {
    return (
      m &&
      (m.key === "business" ||
        m.key === "goal" ||
        m.key === "audienceInput" ||
        m.key === "existingTools")
    );
  });
  const ready = Boolean(mvb.ready) || (understanding.sufficient && !hardBlocked);
  return {
    ready,
    stage: understanding.stage,
    understanding,
    missing: ready
      ? []
      : understanding.gaps.length
        ? understanding.gaps.map(function (g) {
            return { key: g.key, reason: g.reason, aspect: g.aspect || null };
          })
        : mvb.missing || [],
    coverage: groundedCoverage,
    mvbReady: Boolean(mvb.ready),
    mvbMissing: mvb.missing || []
  };
}

/**
 * IDEA / soft stages should not be forced through EXISTING operational discriminators.
 */
export function shouldAskSolutionDiscriminator(coverage, userTurns, solutionReady) {
  if (solutionReady && solutionReady.ready) return false;
  const stage = detectProjectStage(userTurns, coverage);
  if (stage === "IDEA") return false;
  const understanding = assessDialogueUnderstanding(coverage, userTurns);
  // Only after dialogue-sufficient (or near) for EXISTING/LAUNCH.
  return understanding.sufficient || fieldStatus(coverage, "desiredFlow") === "known";
}

export const DIALOGUE_STEP_PROMPTS = STEP_PROMPTS;
