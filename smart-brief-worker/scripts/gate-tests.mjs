/**
 * Deterministic server-gate tests for B′ grounding (no OpenAI / no deploy).
 * Run: node scripts/gate-tests.mjs
 */
import {
  enforceGates,
  evaluateBriefReady,
  evaluateExpertPlan,
  isPreliminaryAllowed,
  countLowEngagementStreak,
  buildClarifyFromNeed,
  buildUserTurns,
  selectClarifyMessage,
  resolveServerFocus,
  pickMissingFocus,
  isAudienceWhoEvidence,
  isAudienceWhatMattersEvidence,
  looksLikeGuestFaqRecount,
  mergeBriefCoverage,
  parseBriefState,
  encodeBriefState,
  applySupersedePolicy,
  pruneSourcesPreservingCoverage,
  isFirstUserTurn,
  selectFirstTurnMessage,
  buildFirstTurnWelcome,
  isSafeWelcomeText,
  isCustomerJourneySufficient,
  isExistingToolsSufficient,
  isDesiredFlowSufficient,
  recoverSourcesFromTurns,
  audienceMissingAspects,
  resolveClarifyTarget,
  deriveFieldStatus,
  READY_REPAIR_FALLBACK
} from "../src/gate.js";
import { createSmartBriefReply } from "../src/openai.js";
import { validateChatBody, trimHistoryForModel } from "../src/validate.js";
import { LIMITS } from "../src/config.js";
import { MODEL_TURN_SCHEMA, schemaCharLength, CRITICAL_COVERAGE_KEYS } from "../src/schema.js";
import { RUNTIME_INSTRUCTIONS } from "../src/prompt.js";
import { GATE_POLICY } from "../src/config.js";

let failed = 0;

function assert(name, condition) {
  if (condition) console.log("ok  -", name);
  else {
    failed += 1;
    console.error("FAIL -", name);
  }
}

function src(turnId, quote, aspect, operation) {
  return {
    turnId: turnId,
    quote: quote,
    aspect: aspect,
    operation: operation === "replace" ? "replace" : "support"
  };
}

function field(status, sources) {
  return { status: status, sources: sources || [] };
}

const QUOTES = {
  business: "У меня небольшой гостевой дом в Лазаревском",
  goal: "Хочется меньше зависеть от Авито и снизить переписку",
  who: "Чаще всего у нас отдыхают пары 30–45 лет и семьи с одним ребёнком",
  matters:
    "При выборе они обычно спрашивают, тихо ли вечером, есть ли парковка и можно ли сразу увидеть свободные даты",
  journey:
    "Обычно находят нас на Авито. Смотрят объявление, потом пишут мне или переходят в WhatsApp. Я уточняю даты и количество гостей, проверяю свободные номера, называю стоимость. Если всё подходит, гость переводит предоплату, и я подтверждаю бронь",
  journeyChannelOnly:
    "Основные бронирования приходят через Авито. Иногда пишут в WhatsApp",
  friction: "Мне приходится каждому гостю заново отвечать на одни и те же вопросы",
  tools:
    "Занятость веду в системе бронирования с календарём и модулем онлайн-бронирования",
  toolsFull:
    "Занятость веду в системе бронирования. Там есть календарь, цены и готовый модуль онлайн-бронирования, который можно подключить к сайту. Для общения использую WhatsApp и телефон. CRM нет, отдельного бота тоже нет",
  flow: "Хотелось бы, чтобы человек мог сам получить информацию и уже потом забронировать",
  flowFull:
    "Хочу, чтобы гость сам посмотрел номера, цены и свободные даты, получил ответы и мог оформить бронь. Ко мне обращался бы только если остались вопросы"
};

function allKnownGrounded(overrides) {
  const base = {
    business: field("known", [src("u1", QUOTES.business, "what_business")]),
    goal: field("known", [src("u2", QUOTES.goal, "desired_outcome")]),
    audienceInput: field("known", [
      src("u3", QUOTES.who, "who_or_segment"),
      src("u3", QUOTES.matters, "what_matters")
    ]),
    customerJourney: field("known", [src("u2", QUOTES.journey, "path_steps")]),
    friction: field("known", [src("u2", QUOTES.friction, "pain")]),
    existingTools: field("known", [src("u4", QUOTES.tools, "tools")]),
    desiredFlow: field("known", [src("u2", QUOTES.flow, "ideal_flow")])
  };
  return Object.assign(base, overrides || {});
}

function validPlan(overrides) {
  return Object.assign(
    {
      realProblem: "Прямой канал слабый, ответы на FAQ съедают время владельца",
      audienceHypothesis: "Предварительно: семьи и пары, которым важны условия и тишина",
      primarySolution: "Сайт гостевого дома с подключением существующего модуля бронирования",
      alternative: "Сначала только мессенджер-бот с FAQ — слабее для доверия и прямого канала",
      whyPrimary: "Закрывает информирование до обращения и усиливает прямой канал без нового booking engine",
      reuseNote: "Использовать уже существующий календарь и модуль онлайн-бронирования",
      startNow: "Компактный сайт с ключевой информацией и подключением модуля",
      addLater: "Контент, акценты, FAQ-структура по сегментам",
      doNotBuildYet: "Не строить новый booking engine и не делать приложение",
      insight: "Главный рычаг — снять повторяющуюся переписку до брони, а не «просто иметь сайт»"
    },
    overrides || {}
  );
}

function baseTurn(overrides) {
  return Object.assign(
    {
      assistantMessage: "Рекомендую небольшой сайт с подключением вашего модуля бронирования.",
      phase: "recommend",
      done: false,
      briefCoverage: allKnownGrounded(),
      nextInformationNeed: { focus: "none", reason: "" },
      clarifyFallbackMessage:
        "Кто чаще всего у вас останавливается и что этим гостям особенно важно при выборе?",
      recommendationMode: "normal",
      lowEngagement: false,
      expertPlan: validPlan()
    },
    overrides || {}
  );
}

/** Dialogue texts that contain all QUOTES as substrings for grounding. */
const histFull = [
  { role: "user", content: QUOTES.business },
  {
    role: "assistant",
    content: "Спасибо! Расскажите, чего хотите добиться."
  },
  {
    role: "user",
    content:
      QUOTES.goal +
      ". " +
      QUOTES.journey +
      ". " +
      QUOTES.friction +
      ". " +
      QUOTES.flow
  },
  {
    role: "assistant",
    content: "Поняла. Кто ваши гости?"
  },
  {
    role: "user",
    content: QUOTES.who + ". " + QUOTES.matters
  },
  {
    role: "assistant",
    content: "Какими инструментами уже пользуетесь?"
  }
];
const msgTools = QUOTES.tools;
const userTurnsFull = buildUserTurns(histFull, msgTools);

// --- helpers unit ---
assert("buildUserTurns assigns u1..", userTurnsFull[0].id === "u1" && userTurnsFull.length === 4);
assert("who evidence accepts natural segment", isAudienceWhoEvidence(QUOTES.who) === true);
assert("what_matters accepts choice framing", isAudienceWhatMattersEvidence(QUOTES.matters) === true);
assert(
  "FAQ recount detected",
  looksLikeGuestFaqRecount("Гости часто спрашивают, можно ли приехать с детьми.") === true
);
assert(
  "FAQ is not WHO",
  isAudienceWhoEvidence("Гости часто спрашивают, можно ли приехать с детьми.") === false
);

// CASE 1 — unknown audience blocks
{
  const turn = baseTurn({
    briefCoverage: allKnownGrounded({ audienceInput: field("unknown", []) }),
    assistantMessage: "Вам нужен сайт с FAQ и бронированием.",
    nextInformationNeed: { focus: "audienceInput", reason: "need who+matters" }
  });
  const d = enforceGates(turn, { history: histFull, message: msgTools });
  assert("CASE1 gate1 blocks unknown audience", d.action === "block_recommend" && d.reason === "gate1_fail");
  assert(
    "CASE1 missing includes audienceInput",
    (d.missing || []).some(function (m) {
      return m.key === "audienceInput";
    })
  );
  const clarify = selectClarifyMessage(turn, d.missing);
  assert("CASE1 clarify uses matched fallback not recommend prose", clarify === turn.clarifyFallbackMessage);
  assert("CASE1 recommend prose not equal clarify", clarify !== turn.assistantMessage);
}

// CASE 2 — partial audience
{
  const d = enforceGates(
    baseTurn({
      briefCoverage: allKnownGrounded({
        audienceInput: field("partial", [src("u3", QUOTES.who, "who_or_segment")])
      })
    }),
    { history: histFull, message: msgTools }
  );
  assert("CASE2 partial audience blocks normal", d.action === "block_recommend" && d.reason === "gate1_fail");
}

// CASE 3 — known but empty sources
{
  const d = enforceGates(
    baseTurn({
      briefCoverage: allKnownGrounded({ audienceInput: field("known", []) })
    }),
    { history: histFull, message: msgTools }
  );
  assert("CASE3 known without sources blocked", d.action === "block_recommend" && d.reason === "gate1_fail");
}

// CASE 4 — happy path
{
  const d = enforceGates(baseTurn(), { history: histFull, message: msgTools });
  assert("CASE4 normal recommend allowed", d.action === "allow" && d.reason === "normal_ok");
  assert("CASE4 public phase recommend", d.publicTurn.phase === "recommend");
}

// CASE 5 — mode conflict
{
  const d = enforceGates(
    baseTurn({ recommendationMode: "none", phase: "recommend" }),
    { history: histFull, message: msgTools }
  );
  assert("CASE5 mode none + phase recommend blocked", d.action === "block_recommend");
}

// CASE 6 — gate2 reuse
{
  const plan = validPlan({ reuseNote: "" });
  const turn = baseTurn({ expertPlan: plan });
  const planEval = evaluateExpertPlan(turn, evaluateBriefReady(turn.briefCoverage, userTurnsFull).coverage);
  assert("CASE6 missing reuse fails gate2", planEval.ok === false && planEval.issues.includes("empty_reuseNote"));
  const d = enforceGates(turn, { history: histFull, message: msgTools });
  assert("CASE6 enforce blocks gate2", d.action === "block_recommend" && d.reason === "gate2_fail");
}

// CASE 7 — missing expertPlan
{
  const d = enforceGates(baseTurn({ expertPlan: null }), { history: histFull, message: msgTools });
  assert("CASE7 missing expertPlan blocked", d.action === "block_recommend" && d.reason === "gate2_fail");
}

// CASE 8 — early preliminary
{
  const turn = baseTurn({
    recommendationMode: "preliminary",
    lowEngagement: true,
    assistantMessage: "Предварительно могу предложить сайт, но данных мало.",
    briefCoverage: allKnownGrounded({ audienceInput: field("unknown", []) }),
    expertPlan: validPlan()
  });
  assert("CASE8 streak after one short message is 1", countLowEngagementStreak([], "не знаю") === 1);
  assert(
    "CASE8 preliminary not allowed after one short answer",
    isPreliminaryAllowed(turn, [], "не знаю") === false
  );
  const d = enforceGates(turn, { history: [], message: "не знаю" });
  assert("CASE8 enforce blocks early preliminary", d.action === "block_recommend");
}

// CASE 9 — preliminary with streak
{
  const hist = [
    { role: "user", content: "не знаю" },
    { role: "assistant", content: "Уточните, пожалуйста…" },
    { role: "user", content: "как хотите" },
    { role: "assistant", content: "Ещё один момент…" }
  ];
  const msg = "неважно";
  assert(
    "CASE9 streak >= min",
    countLowEngagementStreak(hist, msg) >= GATE_POLICY.lowEngagementMinStreak
  );
  const turn = baseTurn({
    recommendationMode: "preliminary",
    lowEngagement: true,
    phase: "recommend",
    assistantMessage:
      "Пока это только предварительное направление на основе ограниченных данных: возможен простой сайт, но аудитория ещё неизвестна.",
    briefCoverage: allKnownGrounded({ audienceInput: field("unknown", []) }),
    expertPlan: validPlan({
      audienceHypothesis: "Недостаточно данных — аудитория неизвестна"
    })
  });
  assert("CASE9 preliminary allowed by policy", isPreliminaryAllowed(turn, hist, msg) === true);
  const d = enforceGates(turn, { history: hist, message: msg });
  assert("CASE9 preliminary recommend allowed", d.action === "allow" && d.reason === "preliminary_ok");
}

// CASE 10 — forged client fields
{
  const validated = validateChatBody({
    message: "Мне нужен сайт",
    history: [],
    briefCoverage: allKnownGrounded(),
    readyToRecommend: true,
    recommendationMode: "normal",
    expertPlan: validPlan()
  });
  assert("CASE10 validate ok", validated.ok === true);
  assert(
    "CASE10 forged fields not in validated data",
    validated.data.briefCoverage === undefined &&
      validated.data.readyToRecommend === undefined &&
      validated.data.recommendationMode === undefined
  );
}

// CASE 11 — site-only not ready
{
  const coverage = evaluateBriefReady(
    {
      business: field("partial", [src("u1", "Хочет сайт", "what_business")]),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    buildUserTurns([], "Хочет сайт")
  );
  assert("CASE11 not brief-ready on site-only ask", coverage.ready === false);
}

// CASE 12 — tools grounded
{
  assert("CASE12 tools quote grounded length", QUOTES.tools.length >= GATE_POLICY.minQuoteChars);
  const planEval = evaluateExpertPlan(
    baseTurn({
      expertPlan: validPlan({
        reuseNote: "Подключить существующий модуль онлайн-бронирования, не создавать новый engine"
      })
    }),
    evaluateBriefReady(allKnownGrounded(), userTurnsFull).coverage
  );
  assert("CASE12 reuse plan ok", planEval.ok === true);
}

// ========== TEST A ==========
{
  const hist = [
    { role: "user", content: QUOTES.business },
    {
      role: "user",
      content: QUOTES.goal + ". " + QUOTES.friction + ". " + QUOTES.flow + ". " + QUOTES.journey
    }
  ];
  const msg = QUOTES.tools;
  const turns = buildUserTurns(hist, msg);
  const industryWho = "Семьи с детьми и пары, которым важно расстояние до моря";
  const coverage = allKnownGrounded({
    audienceInput: field("known", [
      src("u1", industryWho, "who_or_segment"),
      src("u1", "важно расстояние до моря", "what_matters")
    ])
  });
  // Fix other fields turn ids to match this shorter dialogue
  coverage.business = field("known", [src("u1", QUOTES.business, "what_business")]);
  coverage.goal = field("known", [src("u2", QUOTES.goal, "desired_outcome")]);
  coverage.friction = field("known", [src("u2", QUOTES.friction, "pain")]);
  coverage.desiredFlow = field("known", [src("u2", QUOTES.flow, "ideal_flow")]);
  coverage.customerJourney = field("known", [src("u2", QUOTES.journey, "path_steps")]);
  coverage.existingTools = field("known", [src("u3", QUOTES.tools, "tools")]);

  const ready = evaluateBriefReady(coverage, turns);
  assert("TEST A industry audience not ready", ready.ready === false);
  assert(
    "TEST A missing audience",
    ready.missing.some(function (m) {
      return m.key === "audienceInput";
    })
  );
  const d = enforceGates(baseTurn({ briefCoverage: coverage }), { history: hist, message: msg });
  assert("TEST A ordinary recommendation impossible", d.action === "block_recommend");
}

// ========== TEST B ==========
{
  const faqTurn =
    "Сейчас бронирования через Авито. Гости часто спрашивают про цены, но я пока не описывал, кто именно чаще останавливается.";
  const hist = [{ role: "user", content: faqTurn }];
  const turns = buildUserTurns(hist, QUOTES.business + ". " + QUOTES.goal);
  const quoteFaq = "Гости часто спрашивают про цены";
  const coverage = {
    business: field("known", [src("u2", QUOTES.business, "what_business")]),
    goal: field("known", [src("u2", QUOTES.goal, "desired_outcome")]),
    audienceInput: field("known", [
      src("u1", quoteFaq, "who_or_segment"),
      src("u1", quoteFaq, "what_matters")
    ]),
    customerJourney: field("known", [src("u1", "бронирования через Авито", "path_steps")]),
    friction: field("known", [src("u1", "спрашивают про цены", "pain")]),
    existingTools: field("known", [src("u1", "бронирования через Авито", "tools")]),
    desiredFlow: field("known", [src("u1", "спрашивают про цены", "ideal_flow")])
  };
  const ready = evaluateBriefReady(coverage, turns);
  assert("TEST B audience not valid known from unrelated quote", ready.ready === false);
  assert(
    "TEST B audience rejected",
    ready.missing.some(function (m) {
      return m.key === "audienceInput";
    })
  );
}

// ========== TEST C ==========
{
  const hist = [
    { role: "user", content: QUOTES.business },
    { role: "assistant", content: "Чаще всего у вас отдыхают пары 30–45 лет и семьи с одним ребёнком." },
    { role: "user", content: QUOTES.goal }
  ];
  const turns = buildUserTurns(hist, msgTools);
  // Model cites a turnId that doesn't exist for assistant, or wrong id
  const fakeAssistantAsUser = field("known", [
    src("u99", QUOTES.who, "who_or_segment"),
    src("u2", QUOTES.matters, "what_matters")
  ]);
  const coverage = allKnownGrounded({ audienceInput: fakeAssistantAsUser });
  const ready = evaluateBriefReady(coverage, turns);
  assert("TEST C invalid/non-user turn rejected", ready.ready === false);

  // Quote from assistant text that never appeared in user turns
  const assistantOnlyQuote = "Предварительно ваши гости — семьи с детьми у моря";
  const coverage2 = allKnownGrounded({
    audienceInput: field("known", [
      src("u1", assistantOnlyQuote, "who_or_segment"),
      src("u2", QUOTES.goal, "what_matters")
    ])
  });
  const ready2 = evaluateBriefReady(coverage2, turns);
  assert("TEST C assistant-invented quote ungrounded", ready2.ready === false);
}

// ========== TEST D / J (natural audience) ==========
{
  const ready = evaluateBriefReady(allKnownGrounded(), userTurnsFull);
  assert("TEST D/J natural audience accepted without jargon", ready.ready === true);
}

// ========== TEST E — routing: clarify not assistantMessage ==========
{
  const turn = baseTurn({
    recommendationMode: "none",
    phase: "clarify",
    assistantMessage:
      "Похоже, лучший первый шаг — сайт как точка входа с бронированием. Я рекомендую лендинг.",
    clarifyFallbackMessage: "Кто чаще всего бронирует у вас, и что им важно при выборе?",
    nextInformationNeed: { focus: "audienceInput", reason: "audience missing" },
    briefCoverage: allKnownGrounded({ audienceInput: field("unknown", []) }),
    expertPlan: null
  });
  const d = enforceGates(turn, { history: histFull, message: msgTools });
  assert("TEST E clarify allowed", d.action === "allow" && d.reason === "clarify_ok");
  assert(
    "TEST E public message is clarify fallback not recommend prose",
    d.publicTurn.assistantMessage === turn.clarifyFallbackMessage
  );
  assert(
    "TEST E recommend prose excluded",
    d.publicTurn.assistantMessage.indexOf("лучший первый шаг") === -1
  );
}

// ========== TEST F ==========
{
  const d = enforceGates(baseTurn(), { history: histFull, message: msgTools });
  assert("TEST F full MVB + gate2 passes", d.action === "allow" && d.reason === "normal_ok");
}

// ========== TEST G ==========
{
  const hist = [{ role: "user", content: "Это гостевой дом в Лазаревском" }];
  const turns = buildUserTurns(hist, "Это гостевой дом в Лазаревском");
  assert(
    "TEST G niche is not WHO",
    isAudienceWhoEvidence("Это гостевой дом в Лазаревском") === false
  );
  assert(
    "TEST G niche is not WHAT_MATTERS",
    isAudienceWhatMattersEvidence("Это гостевой дом в Лазаревском") === false
  );
  const coverage = {
    business: field("known", [src("u1", "Это гостевой дом в Лазаревском", "what_business")]),
    goal: field("unknown", []),
    audienceInput: field("known", [
      src("u1", "Это гостевой дом в Лазаревском", "who_or_segment"),
      src("u1", "Это гостевой дом в Лазаревском", "what_matters")
    ]),
    customerJourney: field("unknown", []),
    friction: field("unknown", []),
    existingTools: field("unknown", []),
    desiredFlow: field("unknown", [])
  };
  const ready = evaluateBriefReady(coverage, turns);
  assert("TEST G niche cannot prove audience known", ready.ready === false);
}

// ========== TEST H ==========
{
  const faq = "Гости часто спрашивают, можно ли приехать с детьми.";
  const hist = [{ role: "user", content: faq }];
  const turns = buildUserTurns(hist, faq);
  assert("TEST H FAQ not WHO evidence", isAudienceWhoEvidence(faq) === false);
  const coverage = {
    business: field("known", [src("u1", faq, "what_business")]),
    goal: field("known", [src("u1", faq, "desired_outcome")]),
    audienceInput: field("known", [
      src("u1", faq, "who_or_segment"),
      src("u1", faq, "what_matters")
    ]),
    customerJourney: field("known", [src("u1", faq, "path_steps")]),
    friction: field("known", [src("u1", faq, "pain")]),
    existingTools: field("known", [src("u1", faq, "tools")]),
    desiredFlow: field("known", [src("u1", faq, "ideal_flow")])
  };
  // business etc. may fail aspect semantics but audience must fail
  const ready = evaluateBriefReady(
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("known", [
        src("u1", faq, "who_or_segment"),
        src("u1", faq, "what_matters")
      ]),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    turns
  );
  assert(
    "TEST H audience not valid known from FAQ",
    ready.missing.some(function (m) {
      return m.key === "audienceInput";
    })
  );
  const d = enforceGates(
    baseTurn({
      briefCoverage: Object.assign(allKnownGrounded(), {
        audienceInput: field("known", [
          src("u3", faq, "who_or_segment"),
          src("u3", QUOTES.matters, "what_matters")
        ])
      })
    }),
    { history: histFull, message: msgTools }
  );
  // faq quote not in histFull u3 — ungrounded OR if we put faq in history
  assert("TEST H recommend blocked when WHO is FAQ", d.action === "block_recommend");
}

// ========== TEST I ==========
{
  const text = "До моря 10 минут. Гости спрашивают, есть ли бассейн.";
  const turns = buildUserTurns([{ role: "user", content: text }], text);
  const q1 = "До моря 10 минут";
  const q2 = "Гости спрашивают, есть ли бассейн";
  assert("TEST I fact not what_matters", isAudienceWhatMattersEvidence(q1) === false);
  assert("TEST I FAQ not what_matters", isAudienceWhatMattersEvidence(q2) === false);
  const ready = evaluateBriefReady(
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("known", [
        src("u1", q1, "who_or_segment"),
        src("u1", q2, "what_matters")
      ]),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    turns
  );
  assert(
    "TEST I audience not full known from fact+FAQ",
    ready.missing.some(function (m) {
      return m.key === "audienceInput";
    })
  );
}

// ========== TEST J explicit ==========
{
  const text = QUOTES.who + ". " + QUOTES.matters;
  assert("TEST J who ok", isAudienceWhoEvidence(QUOTES.who));
  assert("TEST J matters ok", isAudienceWhatMattersEvidence(QUOTES.matters));
  const turns = buildUserTurns([{ role: "user", content: text }], "ok");
  const audOnly = evaluateBriefReady(
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("known", [
        src("u1", QUOTES.who, "who_or_segment"),
        src("u1", QUOTES.matters, "what_matters")
      ]),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    turns
  );
  assert(
    "TEST J audience field not rejected",
    !audOnly.missing.some(function (m) {
      return m.key === "audienceInput";
    })
  );
}

const INTRO_FALLBACK =
  "Здравствуйте. Я Марк, AI-помощник Оксаны Ежевской, помогу аккуратно собрать суть задачи. Спасибо — можете свободно, своими словами рассказать про гостевой дом и зачем вам сайт.";

const toolsOnlyMissingCoverage = allKnownGrounded({
  existingTools: field("unknown", [])
});

// ========== TEST K — MULTI-TURN CONTINUITY ==========
{
  const ready = evaluateBriefReady(toolsOnlyMissingCoverage, userTurnsFull);
  assert("TEST K brief not ready", ready.ready === false);
  assert("TEST K serverFocus existingTools", resolveServerFocus(ready.missing) === "existingTools");
  assert(
    "TEST K audience not missing",
    !ready.missing.some(function (m) {
      return m.key === "audienceInput";
    })
  );

  const turn = baseTurn({
    recommendationMode: "none",
    phase: "clarify",
    expertPlan: null,
    briefCoverage: toolsOnlyMissingCoverage,
    nextInformationNeed: { focus: "none", reason: "" },
    clarifyFallbackMessage: INTRO_FALLBACK,
    assistantMessage: "Отличный вопрос про аудиторию — давайте уточним инструменты."
  });
  const d = enforceGates(turn, { history: histFull, message: msgTools });
  assert("TEST K clarify path", d.action === "allow" && d.reason === "clarify_ok");
  assert(
    "TEST K intro not sent",
    d.publicTurn.assistantMessage.indexOf("Я Марк, AI-помощник") === -1
  );
  assert(
    "TEST K asks about tools",
    /инструмент|бронир|CRM|календар/i.test(d.publicTurn.assistantMessage)
  );
}

// ========== TEST L — STALE FOCUS ==========
{
  const missing = evaluateBriefReady(toolsOnlyMissingCoverage, userTurnsFull).missing;
  const turn = baseTurn({
    recommendationMode: "none",
    phase: "clarify",
    expertPlan: null,
    briefCoverage: toolsOnlyMissingCoverage,
    nextInformationNeed: { focus: "audienceInput", reason: "stale" },
    clarifyFallbackMessage: "Кто чаще всего бронирует у вас и что им важно?"
  });
  const msg = selectClarifyMessage(turn, missing);
  assert("TEST L serverFocus tools", resolveServerFocus(missing) === "existingTools");
  assert("TEST L model fallback rejected", msg !== turn.clarifyFallbackMessage);
  assert("TEST L tools clarification", /инструмент|бронир|CRM|календар/i.test(msg));
}

// ========== TEST M — MATCHED FOCUS ==========
{
  const missing = evaluateBriefReady(toolsOnlyMissingCoverage, userTurnsFull).missing;
  const contextual =
    "Какой системой бронирования и календарём вы уже пользуетесь — и можно ли подключить готовый модуль к сайту?";
  const turn = baseTurn({
    recommendationMode: "none",
    phase: "clarify",
    expertPlan: null,
    briefCoverage: toolsOnlyMissingCoverage,
    nextInformationNeed: { focus: "existingTools", reason: "need tools" },
    clarifyFallbackMessage: contextual
  });
  const msg = selectClarifyMessage(turn, missing);
  assert("TEST M matched fallback accepted", msg === contextual);
}

// ========== TEST N — RECOMMEND LEAK STILL CLOSED ==========
{
  const turn = baseTurn({
    recommendationMode: "none",
    phase: "clarify",
    expertPlan: null,
    briefCoverage: toolsOnlyMissingCoverage,
    nextInformationNeed: { focus: "audienceInput", reason: "wrong" },
    clarifyFallbackMessage: INTRO_FALLBACK,
    assistantMessage:
      "Рекомендую компактный сайт с модулем бронирования, WhatsApp-ботом и roadmap на три этапа."
  });
  const d = enforceGates(turn, { history: histFull, message: msgTools });
  assert("TEST N clarify allow", d.action === "allow");
  assert(
    "TEST N assistant recommend not sent",
    d.publicTurn.assistantMessage.indexOf("Рекомендую компактный сайт") === -1
  );
  assert(
    "TEST N intro not sent",
    d.publicTurn.assistantMessage.indexOf("Я Марк, AI-помощник") === -1
  );
  assert(
    "TEST N server tools clarify",
    /инструмент|бронир|CRM|календар/i.test(d.publicTurn.assistantMessage)
  );
}

// ========== TEST O — NO RE-ASK KNOWN ==========
{
  const missing = evaluateBriefReady(toolsOnlyMissingCoverage, userTurnsFull).missing;
  const focus = resolveServerFocus(missing);
  assert("TEST O focus is existingTools", focus === "existingTools");
  assert(
    "TEST O known blocks not chosen",
    focus !== "business" &&
      focus !== "goal" &&
      focus !== "audienceInput" &&
      focus !== "customerJourney" &&
      focus !== "friction" &&
      focus !== "desiredFlow"
  );
  assert(
    "TEST O audience not in missing",
    !missing.some(function (m) {
      return m.key === "audienceInput";
    })
  );
}

// ========== TEST P — PERSIST AUDIENCE ==========
{
  const turns = userTurnsFull;
  const priorMerge = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("known", [
        src("u3", QUOTES.who, "who_or_segment"),
        src("u3", QUOTES.matters, "what_matters")
      ]),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    turns
  );
  assert(
    "TEST P prior audience known",
    priorMerge.coverage.audienceInput.status === "known"
  );

  const nextModel = {
    business: field("unknown", []),
    goal: field("unknown", []),
    audienceInput: field("unknown", []),
    customerJourney: field("known", [src("u2", QUOTES.journey, "path_steps")]),
    friction: field("unknown", []),
    existingTools: field("unknown", []),
    desiredFlow: field("unknown", [])
  };
  const merged = mergeBriefCoverage(priorMerge.briefState, nextModel, turns);
  assert("TEST P audience persisted", merged.coverage.audienceInput.status === "known");
  assert("TEST P journey merged", merged.coverage.customerJourney.status === "known");
  const ready = evaluateBriefReady(merged.coverage, turns);
  assert(
    "TEST P serverFocus not audience",
    resolveServerFocus(ready.missing) !== "audienceInput"
  );
}

// ========== TEST Q — MERGE NEW FIELD ==========
{
  const turns = userTurnsFull;
  const withAud = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("known", [
        src("u3", QUOTES.who, "who_or_segment"),
        src("u3", QUOTES.matters, "what_matters")
      ]),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    turns
  );
  const withBoth = mergeBriefCoverage(
    withAud.briefState,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("known", [src("u2", QUOTES.journey, "path_steps")]),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    turns
  );
  assert(
    "TEST Q both blocks known",
    withBoth.coverage.audienceInput.status === "known" &&
      withBoth.coverage.customerJourney.status === "known"
  );
}

// ========== TEST R — FORGED STATE ==========
{
  // History without recoverable audience evidence — only business-like text.
  const histNoAud = [
    { role: "user", content: "У меня студия керамики в центре города" },
    { role: "assistant", content: "Расскажите подробнее." }
  ];
  const msgNoAud = "Хочу сайт с портфолио работ";
  const turnsNoAud = buildUserTurns(histNoAud, msgNoAud);
  const forged = {
    v: 1,
    fields: {
      audienceInput: {
        sources: [
          src("u99", "Семьи с детьми у моря как ЦА", "who_or_segment"),
          src("u99", "им важно море", "what_matters")
        ]
      }
    }
  };
  const merged = mergeBriefCoverage(
    forged,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    turnsNoAud
  );
  assert("TEST R forged rejected", merged.coverage.audienceInput.status !== "known");
  const d = enforceGates(
    baseTurn({
      briefCoverage: merged.coverage,
      recommendationMode: "normal",
      phase: "recommend"
    }),
    { history: histNoAud, message: msgNoAud }
  );
  assert("TEST R recommend blocked", d.action === "block_recommend");
}

// ========== TEST S — FORGED STATUS ==========
{
  const histNoAud = [
    { role: "user", content: "Открываю небольшое ателье по пошиву штор" },
    { role: "assistant", content: "Поняла." }
  ];
  const msgNoAud = "Нужен сайт-визитка";
  const turnsNoAud = buildUserTurns(histNoAud, msgNoAud);
  const forged = encodeBriefState({
    audienceInput: { status: "known", sources: [] }
  });
  // Also try raw with only status fantasy — parse keeps empty sources
  const merged = mergeBriefCoverage(
    { v: 1, fields: { audienceInput: { status: "known", sources: [] } } },
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("known", []),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    turnsNoAud
  );
  assert("TEST S status not authority", merged.coverage.audienceInput.status !== "known");
  void forged;
}

// ========== TEST T — ASSISTANT EVIDENCE ==========
{
  const assistantText = "Чаще всего у вас отдыхают пары 30–45 лет и семьи с одним ребёнком";
  const hist = [
    { role: "user", content: QUOTES.business },
    { role: "assistant", content: assistantText },
    { role: "user", content: QUOTES.goal }
  ];
  const turns = buildUserTurns(hist, msgTools);
  const forged = {
    v: 1,
    fields: {
      audienceInput: {
        sources: [
          src("u1", assistantText, "who_or_segment"),
          src("u2", QUOTES.matters, "what_matters")
        ]
      }
    }
  };
  const merged = mergeBriefCoverage(forged, null, turns);
  assert(
    "TEST T assistant quote not in user turns rejected",
    merged.coverage.audienceInput.status !== "known"
  );
}

// ========== TEST U — HISTORY TRUNCATION ==========
{
  const full = userTurnsFull;
  const prior = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("known", [
        src("u3", QUOTES.who, "who_or_segment"),
        src("u3", QUOTES.matters, "what_matters")
      ]),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    full
  );
  assert("TEST U prior audience ok", prior.coverage.audienceInput.status === "known");
  // Truncate: only last user turn remains (no u3)
  const truncated = buildUserTurns([], msgTools);
  const after = mergeBriefCoverage(prior.briefState, null, truncated);
  assert(
    "TEST U truncated source invalid",
    after.coverage.audienceInput.status !== "known"
  );
}

// ========== TEST V — EXPLICIT CORRECTION ==========
{
  const noTools = "Системы бронирования у меня нет.";
  const yesTools =
    "Я неправильно сказала: система бронирования есть, там календарь и модуль онлайн-бронирования.";
  const hist = [
    { role: "user", content: noTools },
    { role: "assistant", content: "Понял." },
    { role: "user", content: yesTools }
  ];
  const turns = buildUserTurns(hist.slice(0, 1), noTools);
  // After first message only
  const t1 = buildUserTurns([], noTools);
  const s1 = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("known", [src("u1", noTools, "tools")]),
      desiredFlow: field("unknown", [])
    },
    t1
  );
  assert("TEST V older tools grounded", s1.coverage.existingTools.status === "known");

  const t2 = buildUserTurns([{ role: "user", content: noTools }], yesTools);
  const s2 = mergeBriefCoverage(
    s1.briefState,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("known", [
        src("u2", yesTools, "tools", "replace")
      ]),
      desiredFlow: field("unknown", [])
    },
    t2
  );
  assert("TEST V newer tools known", s2.coverage.existingTools.status === "known");
  const quotes = s2.coverage.existingTools.sources.map(function (s) {
    return s.quote;
  });
  assert(
    "TEST V old contradicting quote gone",
    quotes.indexOf(noTools) === -1
  );
  assert(
    "TEST V new quote kept",
    quotes.some(function (q) {
      return q.indexOf("календарь") !== -1;
    })
  );
  void hist;
  void turns;
}

// ========== TEST W — RESET ==========
{
  const prior = mergeBriefCoverage(
    null,
    allKnownGrounded(),
    userTurnsFull
  );
  assert("TEST W prior ready-ish audience", prior.coverage.audienceInput.status === "known");
  const fresh = mergeBriefCoverage(null, null, buildUserTurns([], "Привет, хочу сайт"));
  assert(
    "TEST W fresh empty state",
    fresh.coverage.audienceInput.status === "unknown" &&
      fresh.coverage.business.status !== "known"
  );
}

// ========== TEST X — FULL MULTI-TURN ACCUMULATION ==========
{
  const u1 = QUOTES.business;
  const u2 = QUOTES.goal + ". " + QUOTES.journey + ". " + QUOTES.friction + ". " + QUOTES.flow;
  const u3 = QUOTES.who + ". " + QUOTES.matters;
  const u4 = QUOTES.journey;
  const u5 = QUOTES.tools;

  let state = null;
  let hist = [];

  function step(userMsg, modelCoverage) {
    const turns = buildUserTurns(hist, userMsg);
    const merged = mergeBriefCoverage(state, modelCoverage, turns);
    state = merged.briefState;
    hist = hist.concat([
      { role: "user", content: userMsg },
      { role: "assistant", content: "ok" }
    ]);
    return merged;
  }

  step(u1, {
    business: field("known", [src("u1", QUOTES.business, "what_business")]),
    goal: field("unknown", []),
    audienceInput: field("unknown", []),
    customerJourney: field("unknown", []),
    friction: field("unknown", []),
    existingTools: field("unknown", []),
    desiredFlow: field("unknown", [])
  });

  step(u2, {
    business: field("unknown", []),
    goal: field("known", [src("u2", QUOTES.goal, "desired_outcome")]),
    audienceInput: field("unknown", []),
    customerJourney: field("known", [src("u2", QUOTES.journey, "path_steps")]),
    friction: field("known", [src("u2", QUOTES.friction, "pain")]),
    existingTools: field("unknown", []),
    desiredFlow: field("known", [src("u2", QUOTES.flow, "ideal_flow")])
  });

  const afterAud = step(u3, {
    business: field("unknown", []),
    goal: field("unknown", []),
    audienceInput: field("known", [
      src("u3", QUOTES.who, "who_or_segment"),
      src("u3", QUOTES.matters, "what_matters")
    ]),
    customerJourney: field("unknown", []),
    friction: field("unknown", []),
    existingTools: field("unknown", []),
    desiredFlow: field("unknown", [])
  });
  assert("TEST X audience after u3", afterAud.coverage.audienceInput.status === "known");

  const afterJourneyOnly = step(u4, {
    business: field("unknown", []),
    goal: field("unknown", []),
    audienceInput: field("unknown", []),
    customerJourney: field("known", [src("u4", QUOTES.journey, "path_steps")]),
    friction: field("unknown", []),
    existingTools: field("unknown", []),
    desiredFlow: field("unknown", [])
  });
  assert(
    "TEST X audience still known without repeat",
    afterJourneyOnly.coverage.audienceInput.status === "known"
  );
  const missJ = evaluateBriefReady(afterJourneyOnly.coverage, buildUserTurns(hist.slice(0, -2), u4)).missing;
  // hist already includes u4+assistant; rebuild properly
  const turnsAfter4 = buildUserTurns(
    [
      { role: "user", content: u1 },
      { role: "assistant", content: "ok" },
      { role: "user", content: u2 },
      { role: "assistant", content: "ok" },
      { role: "user", content: u3 },
      { role: "assistant", content: "ok" }
    ],
    u4
  );
  const m4 = mergeBriefCoverage(afterAud.briefState, {
    business: field("unknown", []),
    goal: field("unknown", []),
    audienceInput: field("unknown", []),
    customerJourney: field("known", [src("u4", QUOTES.journey, "path_steps")]),
    friction: field("unknown", []),
    existingTools: field("unknown", []),
    desiredFlow: field("unknown", [])
  }, turnsAfter4);
  assert(
    "TEST X focus not audience after journey-only model",
    resolveServerFocus(evaluateBriefReady(m4.coverage, turnsAfter4).missing) !== "audienceInput"
  );

  const turnsAfter5 = buildUserTurns(
    [
      { role: "user", content: u1 },
      { role: "assistant", content: "ok" },
      { role: "user", content: u2 },
      { role: "assistant", content: "ok" },
      { role: "user", content: u3 },
      { role: "assistant", content: "ok" },
      { role: "user", content: u4 },
      { role: "assistant", content: "ok" }
    ],
    u5
  );
  const m5 = mergeBriefCoverage(m4.briefState, {
    business: field("unknown", []),
    goal: field("unknown", []),
    audienceInput: field("unknown", []),
    customerJourney: field("unknown", []),
    friction: field("unknown", []),
    existingTools: field("known", [src("u5", QUOTES.tools, "tools")]),
    desiredFlow: field("unknown", [])
  }, turnsAfter5);
  const ready5 = evaluateBriefReady(m5.coverage, turnsAfter5);
  assert("TEST X all critical known", ready5.ready === true);
  void missJ;
  void afterJourneyOnly;
}

// ========== TEST Y — STATE SIZE / MALFORMED ==========
{
  const oversized = "x".repeat(LIMITS.maxBriefStateChars + 10);
  const ignored = parseBriefState(oversized);
  assert("TEST Y oversized ignored", Object.keys(ignored.fields).length === 7);
  assert(
    "TEST Y oversized empty sources",
    ignored.fields.audienceInput.sources.length === 0
  );
  const malformed = parseBriefState("{not-json");
  assert("TEST Y malformed ignored", malformed.fields.business.sources.length === 0);
  const merged = mergeBriefCoverage("{not-json", null, userTurnsFull);
  assert("TEST Y continue without 500", merged.briefState && merged.briefState.v === 1);
}

// ========== TEST Z1 — CLEAN FIRST TURN ==========
{
  assert("TEST Z1 is first turn", isFirstUserTurn([]) === true);
  const msg = "У меня небольшой гостевой дом, думаю, нужен сайт.";
  const badFocusTurn = {
    assistantMessage: "Рекомендую сразу сайт с бронированием.",
    phase: "clarify",
    recommendationMode: "none",
    expertPlan: null,
    clarifyFallbackMessage: FOCUS_LIKE_AUDIENCE(),
    nextInformationNeed: { focus: "audienceInput", reason: "missing" }
  };
  function FOCUS_LIKE_AUDIENCE() {
    return "Кто чаще всего к вам обращается, и что этим людям обычно важно при выборе?";
  }
  const out = selectFirstTurnMessage(badFocusTurn, msg);
  assert("TEST Z1 has Mark identity", /Марк/i.test(out) && /Оксан/i.test(out));
  assert("TEST Z1 free discovery", /не анкета|своими словами/i.test(out));
  assert("TEST Z1 not audience FOCUS_PROMPT", out !== FOCUS_LIKE_AUDIENCE());
  assert("TEST Z1 not recommend prose", out.indexOf("Рекомендую сразу сайт") === -1);
}

// ========== TEST Z2 — FIRST TURN DOES NOT BYPASS GATE ==========
{
  const msg = "Нужен сайт для гостевого дома";
  const recommendAttempt = {
    assistantMessage:
      "Вам точно нужен сайт с модулем бронирования и WhatsApp-ботом — вот roadmap.",
    phase: "recommend",
    recommendationMode: "normal",
    expertPlan: validPlan(),
    clarifyFallbackMessage:
      "Вам нужен сайт как основное решение, рекомендую лендинг с бронированием.",
    nextInformationNeed: { focus: "none", reason: "" }
  };
  const out = selectFirstTurnMessage(recommendAttempt, msg);
  assert("TEST Z2 not model recommend", out.indexOf("roadmap") === -1);
  assert("TEST Z2 welcome identity", /Марк/i.test(out) && /Оксан/i.test(out));
  assert("TEST Z2 safe welcome helper", isSafeWelcomeText(out, {
    recommendationMode: "none",
    phase: "clarify",
    expertPlan: null
  }));
}

// ========== TEST Z3 — SECOND TURN RETURNS TO MVB ==========
{
  const hist = [
    { role: "user", content: QUOTES.business },
    { role: "assistant", content: buildFirstTurnWelcome(QUOTES.business) }
  ];
  assert("TEST Z3 not first turn", isFirstUserTurn(hist) === false);
  const msg =
    "Сейчас бронирования через Авито, хочется меньше зависеть и не отвечать на одни и те же вопросы.";
  const turns = buildUserTurns(hist, msg);
  const merged = mergeBriefCoverage(
    null,
    {
      business: field("known", [src("u1", QUOTES.business, "what_business")]),
      goal: field("known", [src("u2", "меньше зависеть", "desired_outcome")]),
      audienceInput: field("unknown", []),
      customerJourney: field("partial", [src("u2", "бронирования через Авито", "path_steps")]),
      friction: field("known", [src("u2", "не отвечать на одни и те же вопросы", "pain")]),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    turns
  );
  const ready = evaluateBriefReady(merged.coverage, turns);
  const focus = resolveServerFocus(ready.missing);
  assert("TEST Z3 MVB focus not welcome", focus === "audienceInput" || focus === "existingTools" || focus === "desiredFlow" || focus === "customerJourney" || focus === "goal");
  const clarify = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "none", reason: "" },
      clarifyFallbackMessage: "Здравствуйте. Я Марк, AI-помощник — повторный intro.",
      recommendationMode: "none",
      phase: "clarify",
      expertPlan: null
    },
    ready.missing
  );
  assert("TEST Z3 not re-welcome", !/повторный intro/i.test(clarify));
  assert("TEST Z3 uses MVB routing", /обращается|инструмент|результат|путь|проще|бизне/i.test(clarify));
}

// ========== TEST Z4 — NO REINTRODUCTION ==========
{
  const hist = [
    { role: "user", content: "u1" },
    { role: "assistant", content: buildFirstTurnWelcome("u1") },
    { role: "user", content: "u2 details" }
  ];
  assert("TEST Z4 subsequent not first", isFirstUserTurn(hist) === false);
  assert(
    "TEST Z4 prompt forbids reintro",
    /не представляйся|FIRST TURN|FIRST_TURN/i.test(RUNTIME_INSTRUCTIONS)
  );
}

// ========== TEST Z5 — D′ CONTINUITY UNAFFECTED ==========
{
  const msg1 = QUOTES.business;
  const welcomeState = mergeBriefCoverage(
    null,
    {
      business: field("known", [src("u1", QUOTES.business, "what_business")]),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    buildUserTurns([], msg1)
  );
  assert("TEST Z5 first turn can ground business", welcomeState.coverage.business.status === "known");

  const hist = [
    { role: "user", content: msg1 },
    { role: "assistant", content: buildFirstTurnWelcome(msg1) }
  ];
  const afterAud = mergeBriefCoverage(
    welcomeState.briefState,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("known", [
        src("u2", QUOTES.who, "who_or_segment"),
        src("u2", QUOTES.matters, "what_matters")
      ]),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    buildUserTurns(hist, QUOTES.who + ". " + QUOTES.matters)
  );
  assert(
    "TEST Z5 business persisted after welcome",
    afterAud.coverage.business.status === "known"
  );
  assert("TEST Z5 audience added", afterAud.coverage.audienceInput.status === "known");
}

// ========== AA — CHANNELS ≠ SUFFICIENT TOOLS ==========
{
  const text = QUOTES.journeyChannelOnly;
  const turns = buildUserTurns([], text);
  const merged = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("known", [src("u1", text, "tools")]),
      desiredFlow: field("unknown", [])
    },
    turns
  );
  assert("TEST AA tools not known from channels", merged.coverage.existingTools.status !== "known");
  assert("TEST AA tools may be partial", merged.coverage.existingTools.status === "partial");
}

// ========== AB — CHANNEL ≠ JOURNEY ==========
{
  const text = QUOTES.journeyChannelOnly;
  const turns = buildUserTurns([], text);
  const merged = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("known", [src("u1", text, "path_steps")]),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    turns
  );
  assert("TEST AB journey not known from channel", merged.coverage.customerJourney.status !== "known");
}

// ========== AC — PAIN ≠ DESIRED FLOW ==========
{
  const text = "Не хочу каждому гостю заново отвечать на одинаковые вопросы.";
  const turns = buildUserTurns([], text);
  const merged = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("unknown", []),
      friction: field("known", [src("u1", text, "pain")]),
      existingTools: field("unknown", []),
      desiredFlow: field("known", [src("u1", text, "ideal_flow")])
    },
    turns
  );
  assert("TEST AC desiredFlow not known from pain", merged.coverage.desiredFlow.status !== "known");
}

// ========== AD — REAL JOURNEY ==========
{
  const turns = buildUserTurns([], QUOTES.journey);
  assert(
    "TEST AD journey sufficient helper",
    isCustomerJourneySufficient([src("u1", QUOTES.journey, "path_steps")])
  );
  const merged = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("known", [src("u1", QUOTES.journey, "path_steps")]),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    turns
  );
  assert("TEST AD journey known", merged.coverage.customerJourney.status === "known");
}

// ========== AE — REAL EXISTING TOOLS ==========
{
  const turns = buildUserTurns([], QUOTES.toolsFull);
  assert(
    "TEST AE tools sufficient helper",
    isExistingToolsSufficient([src("u1", QUOTES.toolsFull, "tools")])
  );
  const merged = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("known", [src("u1", QUOTES.toolsFull, "tools")]),
      desiredFlow: field("unknown", [])
    },
    turns
  );
  assert("TEST AE tools known", merged.coverage.existingTools.status === "known");
}

// ========== AF — REAL DESIRED FLOW ==========
{
  const turns = buildUserTurns([], QUOTES.flowFull);
  assert(
    "TEST AF flow sufficient helper",
    isDesiredFlowSufficient([src("u1", QUOTES.flowFull, "ideal_flow")])
  );
  const merged = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("known", [src("u1", QUOTES.flowFull, "ideal_flow")])
    },
    turns
  );
  assert("TEST AF desiredFlow known", merged.coverage.desiredFlow.status === "known");
}

// ========== AG — LIVE USER1–USER3 ==========
{
  const u1 = "Здравствуйте. У меня небольшой гостевой дом, и я думаю, что мне нужен сайт.";
  const u2 =
    "Сейчас основные бронирования приходят через Авито. Иногда люди пишут в WhatsApp или звонят. Своего сайта нет. Хочется меньше зависеть от Авито и чтобы мне не приходилось каждому гостю заново отвечать на одни и те же вопросы.";
  const u3 =
    "Чаще всего у нас отдыхают пары примерно 30–50 лет и семьи с детьми. Обычно им важно, чтобы было спокойно, чисто, недалеко от моря и чтобы заранее было понятно, какой номер они бронируют и сколько будет стоить проживание. Многие перед бронированием спрашивают про бассейн, условия для детей и что есть в номере.";
  const hist = [
    { role: "user", content: u1 },
    { role: "assistant", content: "welcome" },
    { role: "user", content: u2 },
    { role: "assistant", content: "audience q" }
  ];
  const turns = buildUserTurns(hist, u3);
  const aggressiveModel = {
    business: field("known", [src("u1", "небольшой гостевой дом", "what_business")]),
    goal: field("known", [src("u2", "меньше зависеть от Авито", "desired_outcome")]),
    audienceInput: field("known", [
      src(
        "u3",
        "Чаще всего у нас отдыхают пары примерно 30–50 лет и семьи с детьми",
        "who_or_segment"
      ),
      src(
        "u3",
        "Обычно им важно, чтобы было спокойно, чисто, недалеко от моря и чтобы заранее было понятно, какой номер они бронируют и сколько будет стоить проживание",
        "what_matters"
      )
    ]),
    customerJourney: field("known", [
      src("u2", "основные бронирования приходят через Авито", "path_steps")
    ]),
    friction: field("known", [
      src("u2", "не приходилось каждому гостю заново отвечать на одни и те же вопросы", "pain")
    ]),
    existingTools: field("known", [
      src("u2", "Иногда люди пишут в WhatsApp или звонят. Своего сайта нет", "tools")
    ]),
    desiredFlow: field("known", [
      src("u2", "не приходилось каждому гостю заново отвечать на одни и те же вопросы", "ideal_flow")
    ])
  };
  const merged = mergeBriefCoverage(null, aggressiveModel, turns);
  const ready = evaluateBriefReady(merged.coverage, turns);
  assert("TEST AG not ready", ready.ready === false);
  assert("TEST AG journey not known", merged.coverage.customerJourney.status !== "known");
  assert("TEST AG tools not known", merged.coverage.existingTools.status !== "known");
  assert("TEST AG flow not known", merged.coverage.desiredFlow.status !== "known");
  assert("TEST AG audience known", merged.coverage.audienceInput.status === "known");
  const focus = resolveServerFocus(ready.missing);
  assert(
    "TEST AG focus is missing critical",
    focus === "customerJourney" || focus === "existingTools" || focus === "desiredFlow"
  );
  const d = enforceGates(
    baseTurn({
      briefCoverage: merged.coverage,
      recommendationMode: "normal",
      phase: "recommend",
      assistantMessage:
        "Спасибо, теперь картина уже достаточно ясна. Похоже, лучший первый шаг — сайт-витрина.",
      expertPlan: validPlan()
    }),
    { history: hist, message: u3 }
  );
  assert("TEST AG recommend blocked", d.action === "block_recommend");
  const publicMsg = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "none", reason: "" },
      clarifyFallbackMessage: "intro leak",
      recommendationMode: "none",
      phase: "clarify",
      expertPlan: null
    },
    ready.missing
  );
  assert("TEST AG no architecture recommend in clarify", publicMsg.indexOf("сайт-витрина") === -1);
  assert("TEST AG no картина ясна", publicMsg.indexOf("картина уже достаточно ясна") === -1);
}

// ========== AH — GATE ORDER ==========
{
  const coverage = allKnownGrounded({
    existingTools: field("known", [src("u4", QUOTES.journeyChannelOnly, "tools")])
  });
  // channel quote not in u4 of histFull — use dedicated turns
  const text = QUOTES.journeyChannelOnly;
  const turns = buildUserTurns(
    [
      { role: "user", content: QUOTES.business },
      { role: "user", content: QUOTES.goal + ". " + QUOTES.journey + ". " + QUOTES.friction + ". " + QUOTES.flow },
      { role: "user", content: QUOTES.who + ". " + QUOTES.matters }
    ],
    text
  );
  const almost = {
    business: field("known", [src("u1", QUOTES.business, "what_business")]),
    goal: field("known", [src("u2", QUOTES.goal, "desired_outcome")]),
    audienceInput: field("known", [
      src("u3", QUOTES.who, "who_or_segment"),
      src("u3", QUOTES.matters, "what_matters")
    ]),
    customerJourney: field("known", [src("u2", QUOTES.journey, "path_steps")]),
    friction: field("known", [src("u2", QUOTES.friction, "pain")]),
    existingTools: field("known", [src("u4", text, "tools")]),
    desiredFlow: field("known", [src("u2", QUOTES.flow, "ideal_flow")])
  };
  const merged = mergeBriefCoverage(null, almost, turns);
  assert("TEST AH tools fail semantic", merged.coverage.existingTools.status !== "known");
  const d = enforceGates(
    baseTurn({
      briefCoverage: merged.coverage,
      recommendationMode: "normal",
      phase: "recommend",
      expertPlan: validPlan()
    }),
    {
      history: [
        { role: "user", content: QUOTES.business },
        { role: "assistant", content: "ok" },
        { role: "user", content: QUOTES.goal + ". " + QUOTES.journey + ". " + QUOTES.friction + ". " + QUOTES.flow },
        { role: "assistant", content: "ok" },
        { role: "user", content: QUOTES.who + ". " + QUOTES.matters },
        { role: "assistant", content: "ok" }
      ],
      message: text
    }
  );
  assert("TEST AH recommend blocked despite expertPlan", d.action === "block_recommend");
}

// ========== AI — PARTIAL JOURNEY ACCUMULATES ==========
{
  const part1 = "Находят нас на Авито и смотрят объявление.";
  const part2 =
    "Потом пишут мне, я проверяю даты и цену, после предоплаты подтверждаю бронь.";
  const t1 = buildUserTurns([], part1);
  const s1 = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("known", [src("u1", part1, "path_steps")]),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    t1
  );
  assert("TEST AI first part not known alone", s1.coverage.customerJourney.status !== "known");
  const t2 = buildUserTurns([{ role: "user", content: part1 }], part2);
  const s2 = mergeBriefCoverage(
    s1.briefState,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("known", [src("u2", part2, "path_steps")]),
      friction: field("unknown", []),
      existingTools: field("unknown", []),
      desiredFlow: field("unknown", [])
    },
    t2
  );
  assert("TEST AI accumulated journey known", s2.coverage.customerJourney.status === "known");
}

// ========== AJ — WHATSAPP + NO CRM STILL NOT TOOLS ==========
{
  const text = "Работаю через WhatsApp, CRM нет.";
  const turns = buildUserTurns([], text);
  const merged = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("known", [src("u1", text, "tools")]),
      desiredFlow: field("unknown", [])
    },
    turns
  );
  assert("TEST AJ tools not known", merged.coverage.existingTools.status !== "known");
}

// ========== AK — EXPLICIT BROAD ABSENCE OF TOOLS ==========
{
  const text =
    "Кроме WhatsApp и телефона ничего не использую: ни CRM, ни системы бронирования, ни таблиц, ни бота, ни других программ — всё веду вручную.";
  const turns = buildUserTurns([], text);
  const merged = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("unknown", []),
      audienceInput: field("unknown", []),
      customerJourney: field("unknown", []),
      friction: field("unknown", []),
      existingTools: field("known", [src("u1", text, "tools")]),
      desiredFlow: field("unknown", [])
    },
    turns
  );
  assert("TEST AK broad absence → tools known", merged.coverage.existingTools.status === "known");
}

// ========== AL — GOAL + PAIN STILL NOT FLOW ==========
{
  const text = "Хочу больше прямых бронирований и меньше времени тратить на переписку.";
  const turns = buildUserTurns([], text);
  const merged = mergeBriefCoverage(
    null,
    {
      business: field("unknown", []),
      goal: field("known", [src("u1", "больше прямых бронирований", "desired_outcome")]),
      audienceInput: field("unknown", []),
      customerJourney: field("unknown", []),
      friction: field("known", [src("u1", "меньше времени тратить на переписку", "pain")]),
      existingTools: field("unknown", []),
      desiredFlow: field("known", [src("u1", text, "ideal_flow")])
    },
    turns
  );
  assert("TEST AL goal may be known", merged.coverage.goal.status === "known");
  assert("TEST AL friction may be known", merged.coverage.friction.status === "known");
  assert("TEST AL flow not known", merged.coverage.desiredFlow.status !== "known");
}

// ========== LIVE FIXTURE TEXTS (AS / AV) ==========
const LIVE = {
  u1: "Здравствуйте. У меня небольшой гостевой дом, и я думаю, что мне нужен сайт.",
  u2: "Сейчас основные бронирования приходят через Авито. Иногда люди пишут в WhatsApp или звонят. Своего сайта нет. Хочется меньше зависеть от Авито и чтобы мне не приходилось каждому гостю заново отвечать на одни и те же вопросы.",
  u3: "Чаще всего у нас отдыхают пары примерно 30–50 лет и семьи с детьми. Обычно им важно, чтобы было спокойно, чисто, недалеко от моря и чтобы заранее было понятно, какой номер они бронируют и сколько будет стоить проживание. Многие перед бронированием спрашивают про бассейн, условия для детей и что есть в номере.",
  u4: "Обычно впервые находят нас на Авито. Смотрят объявление, фотографии и описание, потом пишут там же или переходят в WhatsApp, иногда звонят. Я отвечаю на вопросы, уточняю даты и количество гостей, проверяю свободные номера, называю стоимость. Если всё подходит, гость переводит предоплату, и я подтверждаю бронь. Больше всего вопросов возникает до бронирования, когда человек сравнивает варианты и хочет понять, подходит ли ему наш гостевой дом.",
  u5: "Занятость веду в системе бронирования. Там есть календарь, цены и готовый модуль онлайн-бронирования, который можно подключить к сайту. Через него гость может сам посмотреть свободные номера и оформить бронь. Для общения использую WhatsApp и телефон. CRM нет, отдельного бота тоже нет."
};
const LIVE_WHO = "Чаще всего у нас отдыхают пары примерно 30–50 лет и семьи с детьми.";
const LIVE_MATTERS =
  "Обычно им важно, чтобы было спокойно, чисто, недалеко от моря и чтобы заранее было понятно, какой номер они бронируют и сколько будет стоить проживание.";
const AUDIENCE_FOCUS =
  "Кто чаще всего к вам обращается, и что этим людям обычно важно при выборе?";

function emptyCoverage() {
  return {
    business: field("unknown", []),
    goal: field("unknown", []),
    audienceInput: field("unknown", []),
    customerJourney: field("unknown", []),
    friction: field("unknown", []),
    existingTools: field("unknown", []),
    desiredFlow: field("unknown", [])
  };
}

function liveTurns(n) {
  const hist = [];
  const msgs = [LIVE.u1, LIVE.u2, LIVE.u3, LIVE.u4, LIVE.u5];
  for (let i = 0; i < n - 1; i += 1) {
    hist.push({ role: "user", content: msgs[i] });
    hist.push({ role: "assistant", content: "ok" + (i + 1) });
  }
  return { history: hist, message: msgs[n - 1], userTurns: buildUserTurns(hist, msgs[n - 1]) };
}

function livePlanReuse() {
  return validPlan({
    realProblem: "Зависимость от Авито и повторяющиеся вопросы до бронирования",
    audienceHypothesis: "Пары 30–50 и семьи с детьми; важны тишина, чистота, море, понятный номер и цена",
    primarySolution:
      "Сайт-витрина с интеграцией уже существующего модуля онлайн-бронирования (календарь и цены)",
    alternative: "none: модуль бронирования уже есть — отдельный booking engine не нужен",
    whyPrimary: "Закрывает информирование до обращения и усиливает прямой канал без новой системы бронирования",
    reuseNote:
      "Переиспользовать систему бронирования: календарь, цены и готовый модуль онлайн-бронирования; WhatsApp/телефон оставить для исключений",
    startNow: "Компактный сайт с ключевой информацией и подключением существующего модуля",
    addLater: "Контент и FAQ по сегментам",
    doNotBuildYet: "Не строить бронирование с нуля и не делать отдельное приложение",
    insight: "Актив — уже есть модуль бронирования; сайт должен его подключить, а не заменить"
  });
}

// ========== AM — AUDIENCE SURVIVES UNRELATED TURNS ==========
{
  let bs = null;
  let ctx = liveTurns(3);
  let m = mergeBriefCoverage(
    null,
    Object.assign(emptyCoverage(), {
      business: field("known", [src("u1", "небольшой гостевой дом", "what_business")]),
      goal: field("known", [src("u1", "мне нужен сайт", "desired_outcome")]),
      audienceInput: field("known", [
        src("u3", LIVE_WHO, "who_or_segment"),
        src("u3", LIVE_MATTERS, "what_matters")
      ]),
      friction: field("known", [
        src("u2", "не приходилось каждому гостю заново отвечать на одни и те же вопросы", "pain")
      ])
    }),
    ctx.userTurns
  );
  bs = m.briefState;
  assert("TEST AM after u3 audience known", m.coverage.audienceInput.status === "known");

  ctx = liveTurns(4);
  m = mergeBriefCoverage(
    bs,
    Object.assign(emptyCoverage(), {
      customerJourney: field("known", [src("u4", LIVE.u4, "path_steps")])
    }),
    ctx.userTurns
  );
  bs = m.briefState;
  assert("TEST AM after u4 audience known", m.coverage.audienceInput.status === "known");

  ctx = liveTurns(5);
  m = mergeBriefCoverage(
    bs,
    Object.assign(emptyCoverage(), {
      existingTools: field("known", [src("u5", LIVE.u5, "tools")]),
      desiredFlow: field("known", [
        src(
          "u5",
          "Через него гость может сам посмотреть свободные номера и оформить бронь.",
          "ideal_flow"
        )
      ])
    }),
    ctx.userTurns
  );
  assert("TEST AM after u5 audience known", m.coverage.audienceInput.status === "known");
  assert(
    "TEST AM who+matters retained",
    m.coverage.audienceInput.sources.some(function (s) {
      return s.aspect === "who_or_segment";
    }) &&
      m.coverage.audienceInput.sources.some(function (s) {
        return s.aspect === "what_matters";
      })
  );
}

// ========== AN — WEAK NEWER SUPPORT DOES NOT DESTROY STRONG ==========
{
  const strong = src("u3", LIVE_MATTERS, "what_matters", "support");
  const weak = src(
    "u4",
    "человек сравнивает варианты и хочет понять, подходит ли ему наш гостевой дом",
    "what_matters",
    "support"
  );
  // Policy alone (weak may not pass reGround in merge — still must not erase if both enter)
  const policy = applySupersedePolicy(
    [src("u3", LIVE_WHO, "who_or_segment"), strong, weak],
    "audienceInput"
  );
  assert(
    "TEST AN strong matters kept under accumulate",
    policy.some(function (s) {
      return s.quote === LIVE_MATTERS;
    })
  );

  const ctx = liveTurns(4);
  const prior = {
    v: 1,
    fields: {
      audienceInput: {
        sources: [src("u3", LIVE_WHO, "who_or_segment"), strong]
      }
    }
  };
  const merged = mergeBriefCoverage(
    prior,
    Object.assign(emptyCoverage(), {
      audienceInput: field("partial", [weak])
    }),
    ctx.userTurns
  );
  assert(
    "TEST AN merge keeps strong (weak fails audience reGround)",
    merged.coverage.audienceInput.status === "known" &&
      merged.coverage.audienceInput.sources.some(function (s) {
        return s.quote === LIVE_MATTERS;
      })
  );
}

// ========== AO — SUPPORT + SUPPORT ACCUMULATES ==========
{
  const a = src("u3", LIVE_WHO, "who_or_segment", "support");
  const b = src(
    "u3",
    "Чаще всего у нас отдыхают пары примерно 30–50 лет",
    "who_or_segment",
    "support"
  );
  const out = applySupersedePolicy([a, b], "audienceInput");
  assert("TEST AO both who supports kept", out.length === 2);
  const dup = applySupersedePolicy([a, a], "audienceInput");
  assert("TEST AO exact dup collapsed", dup.length === 1);
}

// ========== AP — EXPLICIT REPLACE ==========
{
  const noTools = "Системы бронирования у меня нет.";
  const yesTools =
    "Я неправильно сказала: система бронирования есть, там календарь и модуль онлайн-бронирования.";
  const t1 = buildUserTurns([], noTools);
  const s1 = mergeBriefCoverage(
    null,
    Object.assign(emptyCoverage(), {
      existingTools: field("known", [src("u1", noTools, "tools", "support")])
    }),
    t1
  );
  const t2 = buildUserTurns([{ role: "user", content: noTools }], yesTools);
  const s2 = mergeBriefCoverage(
    s1.briefState,
    Object.assign(emptyCoverage(), {
      existingTools: field("known", [src("u2", yesTools, "tools", "replace")])
    }),
    t2
  );
  const quotes = s2.coverage.existingTools.sources.map(function (s) {
    return s.quote;
  });
  assert("TEST AP old tools superseded", quotes.indexOf(noTools) === -1);
  assert(
    "TEST AP new tools kept",
    quotes.some(function (q) {
      return q.indexOf("календарь") !== -1;
    })
  );
}

// ========== AQ — FAKE/WEAK REPLACE CANNOT DESTROY ==========
{
  const prior = {
    v: 1,
    fields: {
      audienceInput: {
        sources: [
          src("u3", LIVE_WHO, "who_or_segment"),
          src("u3", LIVE_MATTERS, "what_matters")
        ]
      }
    }
  };
  const ctx = liveTurns(5);
  const fake = src(
    "u5",
    "Им важно удобство бронирования",
    "what_matters",
    "replace"
  );
  // Quote not in u5 → ungrounded
  const merged = mergeBriefCoverage(
    prior,
    Object.assign(emptyCoverage(), {
      audienceInput: field("known", [fake])
    }),
    ctx.userTurns
  );
  assert("TEST AQ audience still known", merged.coverage.audienceInput.status === "known");
  assert(
    "TEST AQ strong matters survives",
    merged.coverage.audienceInput.sources.some(function (s) {
      return s.quote === LIVE_MATTERS;
    })
  );
}

// ========== AR — SOURCE PRUNING PRESERVES SUFFICIENCY ==========
{
  const manyWho = [];
  for (let i = 0; i < 10; i += 1) {
    manyWho.push(src("u3", LIVE_WHO, "who_or_segment", "support"));
  }
  manyWho.push(src("u3", LIVE_MATTERS, "what_matters", "support"));
  const pruned = pruneSourcesPreservingCoverage(manyWho, "audienceInput");
  assert("TEST AR respects cap", pruned.length <= (LIMITS.maxSourcesPerField || 8));
  assert(
    "TEST AR keeps what_matters",
    pruned.some(function (s) {
      return s.aspect === "what_matters";
    })
  );
  assert(
    "TEST AR keeps who",
    pruned.some(function (s) {
      return s.aspect === "who_or_segment";
    })
  );

  const ctx = liveTurns(3);
  const merged = mergeBriefCoverage(
    null,
    Object.assign(emptyCoverage(), {
      audienceInput: field("known", manyWho)
    }),
    ctx.userTurns
  );
  assert("TEST AR merge audience still known", merged.coverage.audienceInput.status === "known");
}

// ========== AS — EXACT LIVE U1–U5 READY + CLARIFY → RECOMMEND ==========
{
  let bs = null;
  let ctx = liveTurns(1);
  let m = mergeBriefCoverage(
    null,
    Object.assign(emptyCoverage(), {
      business: field("known", [src("u1", "небольшой гостевой дом", "what_business")]),
      goal: field("known", [src("u1", "мне нужен сайт", "desired_outcome")])
    }),
    ctx.userTurns
  );
  bs = m.briefState;

  ctx = liveTurns(2);
  m = mergeBriefCoverage(
    bs,
    Object.assign(emptyCoverage(), {
      goal: field("known", [src("u2", "Хочется меньше зависеть от Авито", "desired_outcome")]),
      friction: field("known", [
        src("u2", "не приходилось каждому гостю заново отвечать на одни и те же вопросы", "pain")
      ]),
      customerJourney: field("partial", [
        src("u2", "основные бронирования приходят через Авито", "path_steps")
      ]),
      existingTools: field("partial", [src("u2", "Своего сайта нет", "tools")])
    }),
    ctx.userTurns
  );
  bs = m.briefState;

  ctx = liveTurns(3);
  m = mergeBriefCoverage(
    bs,
    Object.assign(emptyCoverage(), {
      audienceInput: field("known", [
        src("u3", LIVE_WHO, "who_or_segment"),
        src("u3", LIVE_MATTERS, "what_matters")
      ])
    }),
    ctx.userTurns
  );
  bs = m.briefState;
  assert("TEST AS u3 audience known", m.coverage.audienceInput.status === "known");
  assert(
    "TEST AS u3 focus journey",
    resolveServerFocus(evaluateBriefReady(m.coverage, ctx.userTurns).missing) ===
      "customerJourney"
  );

  ctx = liveTurns(4);
  m = mergeBriefCoverage(
    bs,
    Object.assign(emptyCoverage(), {
      customerJourney: field("known", [src("u4", LIVE.u4, "path_steps")])
    }),
    ctx.userTurns
  );
  bs = m.briefState;
  const r4 = evaluateBriefReady(m.coverage, ctx.userTurns);
  assert("TEST AS u4 audience known", m.coverage.audienceInput.status === "known");
  assert("TEST AS u4 focus tools", resolveServerFocus(r4.missing) === "existingTools");

  ctx = liveTurns(5);
  m = mergeBriefCoverage(
    bs,
    Object.assign(emptyCoverage(), {
      existingTools: field("known", [src("u5", LIVE.u5, "tools")]),
      desiredFlow: field("known", [
        src(
          "u5",
          "Через него гость может сам посмотреть свободные номера и оформить бронь.",
          "ideal_flow"
        )
      ])
    }),
    ctx.userTurns
  );
  bs = m.briefState;
  const r5 = evaluateBriefReady(m.coverage, ctx.userTurns);
  assert("TEST AS u5 ready", r5.ready === true);
  assert("TEST AS u5 missing empty", r5.missing.length === 0);
  assert("TEST AS u5 serverFocus null", resolveServerFocus(r5.missing) === null);
  assert("TEST AS audience still known", m.coverage.audienceInput.status === "known");

  const clarifyTurn = {
    assistantMessage: "",
    phase: "clarify",
    done: false,
    briefCoverage: emptyCoverage(),
    nextInformationNeed: { focus: "none", reason: "" },
    clarifyFallbackMessage: "Могу уже предложить направление?",
    recommendationMode: "none",
    lowEngagement: false,
    expertPlan: null
  };

  let calls = 0;
  const reply = await createSmartBriefReply({
    apiKey: "test",
    model: "test",
    history: ctx.history,
    message: ctx.message,
    briefState: bs,
    callOpenAI: async function () {
      calls += 1;
      return clarifyTurn;
    }
  });
  assert("TEST AS single provider call", calls === 1);
  assert("TEST AS ready uses server fallback not recommend", reply.phase === "clarify");
  assert("TEST AS fallback text", reply.assistantMessage === READY_REPAIR_FALLBACK);
  assert("TEST AS no audience prompt", reply.assistantMessage !== AUDIENCE_FOCUS);
  assert(
    "TEST AS no MVB FOCUS_PROMPT",
    reply.assistantMessage.indexOf("Кто чаще всего") === -1 &&
      reply.assistantMessage.indexOf("Какими инструментами") === -1
  );
}

// ========== AT — EMPTY MISSING ==========
{
  assert("TEST AT pickMissingFocus [] is null", pickMissingFocus([]) === null);
  assert("TEST AT pickMissingFocus null is null", pickMissingFocus(null) === null);
  assert("TEST AT resolveServerFocus [] is null", resolveServerFocus([]) === null);
  const msg = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "none", reason: "" },
      clarifyFallbackMessage: "anything",
      recommendationMode: "none",
      phase: "clarify"
    },
    []
  );
  assert("TEST AT no audience FOCUS_PROMPT", msg !== AUDIENCE_FOCUS);
  assert("TEST AT uses ready fallback", msg === READY_REPAIR_FALLBACK);
}

// ========== AU — READY CLARIFY CANNOT ASK KNOWN FIELD ==========
{
  const turns = userTurnsFull;
  const coverage = allKnownGrounded();
  const ready = evaluateBriefReady(coverage, turns);
  assert("TEST AU ready", ready.ready === true);
  const focus = resolveServerFocus(ready.missing);
  assert("TEST AU serverFocus null", focus === null);
  const msg = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "audienceInput", reason: "habit" },
      clarifyFallbackMessage: AUDIENCE_FOCUS,
      recommendationMode: "none",
      phase: "clarify"
    },
    ready.missing
  );
  assert("TEST AU not audience", msg !== AUDIENCE_FOCUS);
  assert("TEST AU not business FOCUS", !/^Расскажите немного подробнее о вашем бизнесе/.test(msg));
  assert("TEST AU not tools FOCUS", !/^Какими инструментами вы уже пользуетесь/.test(msg));
  assert("TEST AU not journey FOCUS", !/^Как сейчас обычно проходит путь клиента/.test(msg));
  assert("TEST AU not flow FOCUS", !/^В идеале что клиент должен/.test(msg));
}

// ========== AV — READY + clarify: single call + server fallback (no 2nd provider) ==========
{
  const ctx = liveTurns(5);
  const prior = mergeBriefCoverage(
    null,
    Object.assign(emptyCoverage(), {
      business: field("known", [src("u1", "небольшой гостевой дом", "what_business")]),
      goal: field("known", [src("u2", "Хочется меньше зависеть от Авито", "desired_outcome")]),
      audienceInput: field("known", [
        src("u3", LIVE_WHO, "who_or_segment"),
        src("u3", LIVE_MATTERS, "what_matters")
      ]),
      customerJourney: field("known", [src("u4", LIVE.u4, "path_steps")]),
      friction: field("known", [
        src("u2", "не приходилось каждому гостю заново отвечать на одни и те же вопросы", "pain")
      ]),
      existingTools: field("known", [src("u5", LIVE.u5, "tools")]),
      desiredFlow: field("known", [
        src(
          "u5",
          "Через него гость может сам посмотреть свободные номера и оформить бронь.",
          "ideal_flow"
        )
      ])
    }),
    ctx.userTurns
  );
  assert("TEST AV prior ready", evaluateBriefReady(prior.coverage, ctx.userTurns).ready);

  let calls = 0;
  const reply = await createSmartBriefReply({
    apiKey: "test",
    model: "test",
    history: ctx.history,
    message: ctx.message,
    briefState: prior.briefState,
    callOpenAI: async function () {
      calls += 1;
      return {
        assistantMessage: "",
        phase: "clarify",
        done: false,
        briefCoverage: emptyCoverage(),
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage: "Продолжим?",
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      };
    }
  });
  assert("TEST AV single provider call", calls === 1);
  assert("TEST AV server fallback phase", reply.phase === "clarify");
  assert("TEST AV fallback text", reply.assistantMessage === READY_REPAIR_FALLBACK);
  assert("TEST AV no MVB re-ask", reply.assistantMessage !== AUDIENCE_FOCUS);
}

// ========== AW — READY + gate2_fail: single call + server fallback ==========
{
  const ctx = liveTurns(5);
  const prior = mergeBriefCoverage(
    null,
    Object.assign(emptyCoverage(), {
      business: field("known", [src("u1", "небольшой гостевой дом", "what_business")]),
      goal: field("known", [src("u2", "Хочется меньше зависеть от Авито", "desired_outcome")]),
      audienceInput: field("known", [
        src("u3", LIVE_WHO, "who_or_segment"),
        src("u3", LIVE_MATTERS, "what_matters")
      ]),
      customerJourney: field("known", [src("u4", LIVE.u4, "path_steps")]),
      friction: field("known", [
        src("u2", "не приходилось каждому гостю заново отвечать на одни и те же вопросы", "pain")
      ]),
      existingTools: field("known", [src("u5", LIVE.u5, "tools")]),
      desiredFlow: field("known", [
        src(
          "u5",
          "Через него гость может сам посмотреть свободные номера и оформить бронь.",
          "ideal_flow"
        )
      ])
    }),
    ctx.userTurns
  );

  let calls = 0;
  const reply = await createSmartBriefReply({
    apiKey: "test",
    model: "test",
    history: ctx.history,
    message: ctx.message,
    briefState: prior.briefState,
    callOpenAI: async function () {
      calls += 1;
      return {
        assistantMessage: "Сырая рекомендация без плана — сайт с бронированием с нуля.",
        phase: "recommend",
        done: false,
        briefCoverage: emptyCoverage(),
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage: "",
        recommendationMode: "normal",
        lowEngagement: false,
        expertPlan: null
      };
    }
  });
  assert("TEST AW single provider call", calls === 1);
  assert("TEST AW not public recommend", reply.phase !== "recommend");
  assert("TEST AW not raw message", reply.assistantMessage.indexOf("Сырая рекомендация") === -1);
  assert("TEST AW safe fallback", reply.assistantMessage === READY_REPAIR_FALLBACK);
  assert("TEST AW no audience MVB", reply.assistantMessage !== AUDIENCE_FOCUS);
}

// ========== AX — GATE1 STILL PRECEDES REPAIR/RECOMMEND ==========
{
  const ctx = liveTurns(3);
  const partial = mergeBriefCoverage(
    null,
    Object.assign(emptyCoverage(), {
      business: field("known", [src("u1", "небольшой гостевой дом", "what_business")]),
      goal: field("known", [src("u1", "мне нужен сайт", "desired_outcome")]),
      audienceInput: field("known", [
        src("u3", LIVE_WHO, "who_or_segment"),
        src("u3", LIVE_MATTERS, "what_matters")
      ]),
      friction: field("known", [
        src("u2", "не приходилось каждому гостю заново отвечать на одни и те же вопросы", "pain")
      ])
    }),
    ctx.userTurns
  );
  const ready = evaluateBriefReady(partial.coverage, ctx.userTurns);
  assert("TEST AX not ready", ready.ready === false);
  assert(
    "TEST AX focus real missing",
    resolveServerFocus(ready.missing) === "customerJourney" ||
      resolveServerFocus(ready.missing) === "existingTools" ||
      resolveServerFocus(ready.missing) === "desiredFlow"
  );

  let calls = 0;
  const reply = await createSmartBriefReply({
    apiKey: "test",
    model: "test",
    history: ctx.history,
    message: ctx.message,
    briefState: partial.briefState,
    callOpenAI: async function () {
      calls += 1;
      return {
        assistantMessage: "Рекомендую сразу сайт.",
        phase: "recommend",
        done: true,
        briefCoverage: emptyCoverage(),
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage:
          "Как обычно у вас выглядит путь гостя от первого интереса до бронирования?",
        recommendationMode: "normal",
        lowEngagement: false,
        expertPlan: livePlanReuse()
      };
    }
  });
  assert("TEST AX did not recommend-repair", calls === 1);
  assert("TEST AX stays clarify", reply.phase === "clarify");
  assert("TEST AX not recommend prose", reply.assistantMessage.indexOf("Рекомендую сразу") === -1);
  assert(
    "TEST AX asks real missing not audience default",
    reply.assistantMessage !== AUDIENCE_FOCUS
  );
}

// ========== AY — Gate1 fail must NOT second OpenAI call (client timeout guard) ==========
{
  const JOURNEY_FOCUS =
    "Как сейчас обычно проходит путь клиента: от первого знакомства до заявки или покупки?";
  const hist = [
    { role: "user", content: "Магазин постельного белья, нужен сайт." },
    { role: "assistant", content: "Здравствуйте. Я Марк." },
    { role: "user", content: "Чаще женщины 30–50. Важны цена и качество." },
    { role: "assistant", content: JOURNEY_FOCUS }
  ];
  const journeyAnswer =
    "Находят в Instagram, пишут в WhatsApp, я уточняю заказ и цену, потом предоплата и отправка.";
  let calls = 0;
  const reply = await createSmartBriefReply({
    apiKey: "t",
    model: "m",
    history: hist,
    message: journeyAnswer,
    briefState: null,
    callOpenAI: async function () {
      calls += 1;
      // Dangerous production pattern: Gate1 missing + focus none + empty fallback
      // previously triggered a second OpenAI round-trip (> client 55s timeout).
      return {
        assistantMessage: "",
        phase: "clarify",
        done: false,
        briefCoverage: emptyCoverage(),
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage: "",
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      };
    }
  });
  assert("TEST AY single OpenAI call only", calls === 1);
  assert("TEST AY stays clarify", reply.phase === "clarify");
  assert("TEST AY has server clarify text", typeof reply.assistantMessage === "string" && reply.assistantMessage.length > 10);
  assert("TEST AY not empty", reply.assistantMessage.trim().length > 0);
}

// ========== AZ — PROVIDER CALL BUDGET INVARIANT (≤1 per POST) ==========
{
  const ctx = liveTurns(5);
  const prior = mergeBriefCoverage(
    null,
    Object.assign(emptyCoverage(), {
      business: field("known", [src("u1", "небольшой гостевой дом", "what_business")]),
      goal: field("known", [src("u2", "Хочется меньше зависеть от Авито", "desired_outcome")]),
      audienceInput: field("known", [
        src("u3", LIVE_WHO, "who_or_segment"),
        src("u3", LIVE_MATTERS, "what_matters")
      ]),
      customerJourney: field("known", [src("u4", LIVE.u4, "path_steps")]),
      friction: field("known", [
        src("u2", "не приходилось каждому гостю заново отвечать на одни и те же вопросы", "pain")
      ]),
      existingTools: field("known", [src("u5", LIVE.u5, "tools")]),
      desiredFlow: field("known", [
        src(
          "u5",
          "Через него гость может сам посмотреть свободные номера и оформить бронь.",
          "ideal_flow"
        )
      ])
    }),
    ctx.userTurns
  );

  // D — normal recommend: exactly 1 call
  {
    let calls = 0;
    const reply = await createSmartBriefReply({
      apiKey: "t",
      model: "m",
      history: ctx.history,
      message: ctx.message,
      briefState: prior.briefState,
      callOpenAI: async function () {
        calls += 1;
        return {
          assistantMessage:
            "Рекомендую сайт с подключением вашего модуля онлайн-бронирования.",
          phase: "recommend",
          done: false,
          briefCoverage: emptyCoverage(),
          nextInformationNeed: { focus: "none", reason: "" },
          clarifyFallbackMessage: "",
          recommendationMode: "normal",
          lowEngagement: false,
          expertPlan: livePlanReuse()
        };
      }
    });
    assert("TEST AZ-D normal recommend single call", calls === 1);
    assert("TEST AZ-D phase recommend", reply.phase === "recommend");
  }

  // E — first-turn: ≤1 call
  {
    let calls = 0;
    const reply = await createSmartBriefReply({
      apiKey: "t",
      model: "m",
      history: [],
      message: LIVE.u1,
      briefState: null,
      callOpenAI: async function () {
        calls += 1;
        return {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          briefCoverage: emptyCoverage(),
          nextInformationNeed: { focus: "none", reason: "" },
          clarifyFallbackMessage:
            "Здравствуйте. Я Марк, AI-помощник Оксаны Ежевской. Расскажите задачу свободно.",
          recommendationMode: "none",
          lowEngagement: false,
          expertPlan: null
        };
      }
    });
    assert("TEST AZ-E first-turn single call", calls === 1);
    assert("TEST AZ-E clarify", reply.phase === "clarify");
    assert("TEST AZ-E has Mark", /Марк/.test(reply.assistantMessage));
  }

  // F — weak/malformed gated recommend on READY: ≤1 call + fallback
  {
    let calls = 0;
    const reply = await createSmartBriefReply({
      apiKey: "t",
      model: "m",
      history: ctx.history,
      message: ctx.message,
      briefState: prior.briefState,
      callOpenAI: async function () {
        calls += 1;
        return {
          assistantMessage: "Сырой бриф без expertPlan.",
          phase: "recommend",
          done: true,
          briefCoverage: emptyCoverage(),
          nextInformationNeed: { focus: "none", reason: "" },
          clarifyFallbackMessage: "",
          recommendationMode: "normal",
          lowEngagement: false,
          expertPlan: validPlan({ reuseNote: "" })
        };
      }
    });
    assert("TEST AZ-F weak turn single call", calls === 1);
    assert("TEST AZ-F not raw", reply.assistantMessage.indexOf("Сырой бриф") === -1);
    assert("TEST AZ-F fallback", reply.assistantMessage === READY_REPAIR_FALLBACK);
  }

  // G — simulated 30s provider latency: still only one call; wall < client 55s budget
  {
    let calls = 0;
    const t0 = Date.now();
    const reply = await createSmartBriefReply({
      apiKey: "t",
      model: "m",
      history: ctx.history,
      message: ctx.message,
      briefState: prior.briefState,
      callOpenAI: async function () {
        calls += 1;
        await new Promise(function (r) {
          setTimeout(r, 30000);
        });
        return {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          briefCoverage: emptyCoverage(),
          nextInformationNeed: { focus: "none", reason: "" },
          clarifyFallbackMessage: "Продолжим?",
          recommendationMode: "none",
          lowEngagement: false,
          expertPlan: null
        };
      }
    });
    const wall = Date.now() - t0;
    assert("TEST AZ-G single provider call under latency", calls === 1);
    assert("TEST AZ-G wall under client budget", wall < 55000);
    assert("TEST AZ-G fallback", reply.assistantMessage === READY_REPAIR_FALLBACK);
  }

  // Static: createSmartBriefReply body has exactly one await callModel
  {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/openai.js", import.meta.url), "utf8");
    const fnStart = src.indexOf("export async function createSmartBriefReply");
    const fnEnd = src.indexOf("/** Test helpers", fnStart);
    const body = src.slice(fnStart, fnEnd === -1 ? src.length : fnEnd);
    const awaits = body.match(/await callModel\s*\(/g) || [];
    assert("TEST AZ-static exactly one await callModel", awaits.length === 1);
    assert(
      "TEST AZ-static no runReadyRecommendRepair",
      body.indexOf("runReadyRecommendRepair") === -1
    );
  }
}

// ========== BA — NO briefState: history recovery keeps audience ==========
{
  const ctx = liveTurns(4);
  const m = mergeBriefCoverage(
    null,
    Object.assign(emptyCoverage(), {
      business: field("known", [src("u1", "небольшой гостевой дом", "what_business")]),
      goal: field("known", [src("u2", "Хочется меньше зависеть от Авито", "desired_outcome")]),
      friction: field("known", [
        src("u2", "не приходилось каждому гостю заново отвечать на одни и те же вопросы", "pain")
      ]),
      customerJourney: field("known", [src("u4", LIVE.u4, "path_steps")])
    }),
    ctx.userTurns
  );
  const ready = evaluateBriefReady(m.coverage, ctx.userTurns);
  assert("TEST BA audience recovered known", m.coverage.audienceInput.status === "known");
  assert("TEST BA journey known", m.coverage.customerJourney.status === "known");
  assert(
    "TEST BA focus tools not audience",
    resolveServerFocus(ready.missing, m.coverage, ctx.userTurns) === "existingTools"
  );
  const blocked = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "audienceInput", reason: "model habit" },
      clarifyFallbackMessage: AUDIENCE_FOCUS,
      recommendationMode: "none",
      phase: "clarify"
    },
    ready.missing,
    m.coverage,
    ctx.userTurns
  );
  assert("TEST BA server blocks audience re-ask", blocked !== AUDIENCE_FOCUS);
  assert("TEST BA asks tools", /инструмент|бронир|CRM/i.test(blocked));
}

// ========== BB — PARTIAL audience asks only WHAT_MATTERS ==========
{
  const text =
    "У меня консалтинг для клиник. Чаще всего к нам обращаются клиенты — владельцы небольших клиник. Критерии выбора пока не обсуждали.";
  const turns = buildUserTurns([], text);
  // Only audience is intentionally partial (WHO known, WHAT_MATTERS missing).
  // Other fields left unknown so missing[0] may not be audience — force evaluate path
  // by building missing manually after merge for audience-only assert.
  const m = mergeBriefCoverage(
    null,
    Object.assign(emptyCoverage(), {
      audienceInput: field("partial", [
        src(
          "u1",
          "Чаще всего к нам обращаются клиенты — владельцы небольших клиник.",
          "who_or_segment"
        )
      ])
    }),
    turns
  );
  assert("TEST BB audience not fully known", m.coverage.audienceInput.status !== "known");
  const missingAud = [{ key: "audienceInput", reason: "status_partial" }];
  const msg = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "audienceInput", reason: "" },
      clarifyFallbackMessage: AUDIENCE_FOCUS
    },
    missingAud,
    m.coverage,
    turns
  );
  assert("TEST BB not full audience re-ask", msg !== AUDIENCE_FOCUS);
  assert("TEST BB asks what matters only", /важнее всего при выборе/i.test(msg));
}

// ========== BC — JSON/HTTP state round-trip continuity ==========
{
  const histAfterU3 = [
    { role: "user", content: LIVE.u1 },
    { role: "assistant", content: "welcome" },
    { role: "user", content: LIVE.u2 },
    { role: "assistant", content: AUDIENCE_FOCUS },
    { role: "user", content: LIVE.u3 },
    {
      role: "assistant",
      content:
        "Как сейчас обычно проходит путь клиента: от первого знакомства до заявки или покупки?"
    }
  ];
  const t3 = buildUserTurns(histAfterU3.slice(0, 4), LIVE.u3);
  const m3 = mergeBriefCoverage(
    null,
    Object.assign(emptyCoverage(), {
      business: field("known", [src("u1", "небольшой гостевой дом", "what_business")]),
      goal: field("known", [src("u2", "Хочется меньше зависеть от Авито", "desired_outcome")]),
      friction: field("known", [
        src("u2", "не приходилось каждому гостю заново отвечать на одни и те же вопросы", "pain")
      ]),
      audienceInput: field("known", [
        src("u3", LIVE_WHO, "who_or_segment"),
        src("u3", LIVE_MATTERS, "what_matters")
      ])
    }),
    t3
  );
  const wireOut = JSON.parse(JSON.stringify({ ok: true, briefState: m3.briefState }));
  const session = JSON.stringify({ briefState: wireOut.briefState, history: histAfterU3 });
  const restored = JSON.parse(session);
  const req = JSON.parse(
    JSON.stringify({
      sessionId: "roundtrip",
      message: LIVE.u4,
      history: restored.history,
      briefState: restored.briefState
    })
  );
  const validated = validateChatBody(req);
  assert("TEST BC validate ok", validated.ok === true);
  const turns4 = buildUserTurns(
    trimHistoryForModel(validated.data.history),
    validated.data.message
  );
  const m4 = mergeBriefCoverage(
    validated.data.briefState,
    Object.assign(emptyCoverage(), {
      customerJourney: field("known", [src("u4", LIVE.u4, "path_steps")])
    }),
    turns4
  );
  const r4 = evaluateBriefReady(m4.coverage, turns4);
  assert("TEST BC audience known after wire", m4.coverage.audienceInput.status === "known");
  assert("TEST BC journey known", m4.coverage.customerJourney.status === "known");
  assert(
    "TEST BC focus not audience",
    resolveServerFocus(r4.missing, m4.coverage, turns4) !== "audienceInput"
  );
}

// ========== BD — niches: service / shop / education ==========
{
  const niches = [
    {
      name: "service",
      text:
        "Чаще всего к нам обращаются клиенты — владельцы небольших клиник. Обычно им важно быстро понять стоимость и сроки внедрения."
    },
    {
      name: "shop",
      text:
        "Чаще всего у нас покупают семьи с детьми дошкольного возраста. При выборе им важно наличие размеров и понятная доставка."
    },
    {
      name: "education",
      text:
        "Чаще всего к нам приходят взрослые клиенты, которые меняют профессию. Им важно понять программу курса и поддержку после обучения."
    }
  ];
  for (let i = 0; i < niches.length; i += 1) {
    const n = niches[i];
    const turns = buildUserTurns([], n.text);
    const m = mergeBriefCoverage(null, emptyCoverage(), turns);
    assert("TEST BD " + n.name + " audience known", m.coverage.audienceInput.status === "known");
    const hist = [
      { role: "user", content: n.text },
      { role: "assistant", content: "Как проходит путь клиента?" }
    ];
    const msg2 =
      "Обычно находят через поиск, смотрят страницу, пишут в мессенджер, я уточняю задачу и называю стоимость, потом заключаем договор и начинаем работу.";
    const turns2 = buildUserTurns(hist, msg2);
    const m2 = mergeBriefCoverage(
      null,
      Object.assign(emptyCoverage(), {
        customerJourney: field("known", [src("u2", msg2, "path_steps")])
      }),
      turns2
    );
    const r2 = evaluateBriefReady(m2.coverage, turns2);
    assert(
      "TEST BD " + n.name + " no audience reopen",
      resolveServerFocus(r2.missing, m2.coverage, turns2) !== "audienceInput"
    );
    assert(
      "TEST BD " + n.name + " audience still known",
      m2.coverage.audienceInput.status === "known"
    );
  }
}

// ========== BE — valid replace still overrides recovery ==========
{
  const oldWho = "Чаще всего у нас отдыхают пары примерно 30–50 лет и семьи с детьми.";
  const newWho =
    "Я ошиблась: чаще всего к нам приезжают корпоративные группы на тимбилдинг.";
  const matters = LIVE_MATTERS;
  const hist = [{ role: "user", content: LIVE.u3 }, { role: "assistant", content: "ok" }];
  const turns = buildUserTurns(hist, newWho + " " + matters);
  const prior = {
    v: 1,
    fields: {
      audienceInput: {
        sources: [src("u1", oldWho, "who_or_segment"), src("u1", matters, "what_matters")]
      }
    }
  };
  const m = mergeBriefCoverage(
    prior,
    Object.assign(emptyCoverage(), {
      audienceInput: field("known", [
        src("u2", newWho, "who_or_segment", "replace"),
        src("u2", matters, "what_matters", "support")
      ])
    }),
    turns
  );
  const whoSources = m.coverage.audienceInput.sources.filter(function (s) {
    return s.aspect === "who_or_segment";
  });
  assert(
    "TEST BE new who present",
    whoSources.some(function (s) {
      return s.quote.indexOf("корпоративные группы") !== -1;
    })
  );
  assert(
    "TEST BE old who not kept as authority",
    !whoSources.some(function (s) {
      return s.quote === oldWho;
    })
  );
}

// ========== BF — partial WHAT_MATTERS without WHO (live retail regression) ==========
{
  const WHO_ONLY =
    "Кто чаще всего к вам обращается — какой это тип клиентов или гостей?";
  const livePartial = "продавец общается, качество, цена, ассортимент";
  const variants = [
    livePartial,
    "важны цена, качество и выбор",
    "смотрят на качество ткани, стоимость и ассортимент",
    "главное цена и чтобы был хороший выбор",
    "покупатели спрашивают про материал, цену и размеры"
  ];

  assert("TEST BF live not WHO", isAudienceWhoEvidence(livePartial) === false);
  assert("TEST BF live is WHAT_MATTERS", isAudienceWhatMattersEvidence(livePartial) === true);

  for (let i = 0; i < variants.length; i += 1) {
    const v = variants[i];
    assert(
      "TEST BF variant[" + i + "] not WHO",
      isAudienceWhoEvidence(v) === false
    );
    assert(
      "TEST BF variant[" + i + "] is WHAT_MATTERS",
      isAudienceWhatMattersEvidence(v) === true
    );
  }

  const hist = [
    { role: "user", content: "продажа постельного белья, реклама чтобы о нас больше людей узнало" },
    { role: "assistant", content: AUDIENCE_FOCUS }
  ];
  const turns = buildUserTurns(hist, livePartial);
  const recovered = recoverSourcesFromTurns("audienceInput", turns);
  const turnsById = {};
  for (let t = 0; t < turns.length; t += 1) turnsById[turns[t].id] = turns[t].text;

  assert(
    "TEST BF recovery has WHAT_MATTERS source",
    recovered.some(function (s) {
      return s.aspect === "what_matters" && isAudienceWhatMattersEvidence(s.quote);
    })
  );
  assert(
    "TEST BF recovery has no WHO source",
    !recovered.some(function (s) {
      return isAudienceWhoEvidence(s.quote);
    })
  );

  const status = deriveFieldStatus("audienceInput", recovered, turnsById);
  assert("TEST BF status partial", status === "partial");
  const aspects = audienceMissingAspects(recovered, turnsById);
  assert("TEST BF missing only WHO", aspects.length === 1 && aspects[0] === "who_or_segment");

  const m = mergeBriefCoverage(null, emptyCoverage(), turns);
  assert("TEST BF merge audience partial", m.coverage.audienceInput.status === "partial");
  const missing = [{ key: "audienceInput", reason: "status_partial" }];
  const target = resolveClarifyTarget(missing, m.coverage, turns);
  assert("TEST BF clarify focus audience", target.focus === "audienceInput");
  assert("TEST BF clarify aspect who only", target.aspect === "who_or_segment");

  const msg = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "audienceInput", reason: "model full reask" },
      clarifyFallbackMessage: AUDIENCE_FOCUS
    },
    missing,
    m.coverage,
    turns
  );
  assert("TEST BF not full audience re-ask", msg !== AUDIENCE_FOCUS);
  assert("TEST BF asks WHO only", msg === WHO_ONLY);

  // HTTP path with prior continuum (business/goal already known — mirrors live after U1):
  // empty model coverage + history recovery → WHO-only, never full audience re-ask.
  const priorKnown = encodeBriefState(
    Object.assign(emptyCoverage(), {
      business: field("known", [src("u1", "продажа постельного белья", "what_business")]),
      goal: field("known", [
        src("u1", "реклама чтобы о нас больше людей узнало", "desired_outcome")
      ])
    })
  );
  const reply = await createSmartBriefReply({
    apiKey: "t",
    model: "m",
    history: hist,
    message: livePartial,
    briefState: priorKnown,
    callOpenAI: async function () {
      return {
        assistantMessage: "",
        phase: "clarify",
        done: false,
        briefCoverage: emptyCoverage(),
        nextInformationNeed: { focus: "audienceInput", reason: "full" },
        clarifyFallbackMessage: AUDIENCE_FOCUS,
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      };
    }
  });
  assert("TEST BF http not full re-ask", reply.assistantMessage !== AUDIENCE_FOCUS);
  assert("TEST BF http WHO-only", reply.assistantMessage === WHO_ONLY);
  assert("TEST BF http phase clarify", reply.phase === "clarify");

  // Same without briefState: model still supplies prior business/goal sources this turn.
  const replyWipe = await createSmartBriefReply({
    apiKey: "t",
    model: "m",
    history: hist,
    message: livePartial,
    briefState: null,
    callOpenAI: async function () {
      return {
        assistantMessage: "",
        phase: "clarify",
        done: false,
        briefCoverage: Object.assign(emptyCoverage(), {
          business: field("known", [src("u1", "продажа постельного белья", "what_business")]),
          goal: field("known", [
            src("u1", "реклама чтобы о нас больше людей узнало", "desired_outcome")
          ])
        }),
        nextInformationNeed: { focus: "audienceInput", reason: "full" },
        clarifyFallbackMessage: AUDIENCE_FOCUS,
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      };
    }
  });
  assert("TEST BF wipe-http not full re-ask", replyWipe.assistantMessage !== AUDIENCE_FOCUS);
  assert("TEST BF wipe-http WHO-only", replyWipe.assistantMessage === WHO_ONLY);
}

// ========== BG — reverse partial: WHO known, WHAT_MATTERS missing ==========
{
  const MATTERS_ONLY = "А что для этих людей обычно важнее всего при выборе?";
  const whoOnly = "чаще женщины 30–60 лет";
  assert("TEST BG who known", isAudienceWhoEvidence(whoOnly) === true);
  assert("TEST BG matters not from who", isAudienceWhatMattersEvidence(whoOnly) === false);

  const hist = [
    { role: "user", content: "Продаю постельное бельё, нужен сайт." },
    { role: "assistant", content: AUDIENCE_FOCUS }
  ];
  const turns = buildUserTurns(hist, whoOnly);
  const m = mergeBriefCoverage(null, emptyCoverage(), turns);
  assert("TEST BG merge partial", m.coverage.audienceInput.status === "partial");
  const aspects = audienceMissingAspects(
    m.coverage.audienceInput.sources,
    Object.fromEntries(turns.map(function (t) { return [t.id, t.text]; }))
  );
  assert(
    "TEST BG missing only WHAT_MATTERS",
    aspects.length === 1 && aspects[0] === "what_matters"
  );
  const missing = [{ key: "audienceInput", reason: "status_partial" }];
  const target = resolveClarifyTarget(missing, m.coverage, turns);
  assert("TEST BG aspect what_matters", target.aspect === "what_matters");
  const msg = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "audienceInput", reason: "" },
      clarifyFallbackMessage: AUDIENCE_FOCUS
    },
    missing,
    m.coverage,
    turns
  );
  assert("TEST BG not full audience re-ask", msg !== AUDIENCE_FOCUS);
  assert("TEST BG asks WHAT_MATTERS only", msg === MATTERS_ONLY);
}

assert("schema has all critical keys", CRITICAL_COVERAGE_KEYS.length === 7);
assert("schema is object", MODEL_TURN_SCHEMA.type === "object");
assert("schema char length tracked", schemaCharLength() > 500);
assert("runtime mentions server gates / USER_TURNS", /USER_TURNS|Server gates|сервер/i.test(RUNTIME_INSTRUCTIONS));
assert("runtime requires sources grounding", /sources|quote|USER_TURNS/i.test(RUNTIME_INSTRUCTIONS));
assert(
  "runtime false dilemma soft rule",
  /что важнее|either\/or|обе цели/i.test(RUNTIME_INSTRUCTIONS)
);
assert(
  "schema coverage uses sources not free evidence",
  !!MODEL_TURN_SCHEMA.properties.briefCoverage.properties.business.properties.sources
);

console.log("schemaCharLength=", schemaCharLength());
console.log("runtimePromptChars=", RUNTIME_INSTRUCTIONS.length);

if (failed) {
  console.error("\n" + failed + " gate test(s) failed");
  process.exit(1);
}
console.log("\nAll gate tests passed.");
