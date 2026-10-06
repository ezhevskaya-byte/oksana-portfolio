/**
 * Two-step Stage2 regression:
 * 1) BRIEF_READY + !SOLUTION_READY → operational discriminator
 * 2) rich discriminator answer → SOLUTION_READY → publishable recommend
 *    (never READY_REPAIR_FALLBACK)
 */
import {
  buildUserTurns,
  mergeBriefCoverage,
  evaluateBriefReady,
  evaluateSolutionReady,
  collectSolutionEvidence,
  needsSolutionDiscriminator,
  pickSolutionDiscriminatorQuestion,
  READY_REPAIR_FALLBACK,
  isCompoundDiscoveryQuestion,
  buildEvidenceBackedRecommendation,
  evaluateExpertPlan
} from "../src/gate.js";
import { createSmartBriefReply } from "../src/openai.js";

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("ok  -", name);
  else {
    console.error("FAIL -", name);
    failed += 1;
  }
}

const LIVE = [
  "У меня небольшая студия йоги. Большинство клиентов находят нас через соцсети, а записью сейчас занимается администратор вручную.",
  "Хочу упростить запись на занятия. Сейчас администратору приходится постоянно отвечать людям в личных сообщениях, рассказывать про расписание, цены и свободные места, а потом вручную записывать каждого клиента.",
  "В основном женщины от 25 до 45 лет. Есть и новички, которые только хотят попробовать йогу, и те, кто уже давно занимается.",
  "Им важно удобное расписание, чтобы подходило время занятий, понятная стоимость и хороший преподаватель. Ещё многие не хотят долго переписываться — им удобнее быстро посмотреть информацию, увидеть свободное время и сразу записаться.",
  "CRM и отдельного сервиса записи у нас нет. Администратор общается с клиентами в соцсетях и мессенджерах, а сами записи ведёт в обычной таблице и календаре."
];

const RICH_ANSWER =
  "Пока онлайн-оплата не нужна. Клиенту достаточно выбрать занятие и записаться, а оплачивает он уже в студии. Расписание меняется довольно часто: занятия ведут несколько преподавателей, время иногда переносится, и на каждом занятии ограниченное количество мест.";

function isGenericFail(text) {
  return (
    text === READY_REPAIR_FALLBACK ||
    /не удалось безопасно собрать рекомендацию/i.test(text) ||
    /напишите ещё раз/i.test(text)
  );
}

function validPlan(overrides) {
  return Object.assign(
    {
      realProblem: "Ручная запись и динамическое расписание",
      audienceHypothesis: "Женщины 25–45",
      primarySolution: "Готовый сервис онлайн-записи с календарём и лимитом мест",
      alternative: "Простая страница-витрина с формой заявки без полного booking engine",
      whyPrimary: "Динамическое расписание и лимит мест лучше закрывает сервис записи",
      reuseNote: "Опираться на текущие таблицу и календарь администратора",
      startNow: "Подключить сервис записи без обязательной онлайн-оплаты",
      addLater: "Напоминания о занятиях",
      doNotBuildYet: "Не строить сложную CRM с нуля",
      insight: "Сначала self-booking, сайт не обязателен как ядро"
    },
    overrides || {}
  );
}

function buildThroughTurn(n) {
  let history = [];
  let prior = null;
  let coverage = null;
  for (let i = 0; i < n; i += 1) {
    const ut = buildUserTurns(history, LIVE[i]);
    const merged = mergeBriefCoverage(prior, {}, ut);
    prior = merged.briefState;
    coverage = merged.coverage;
    history.push({ role: "user", content: LIVE[i] });
    history.push({ role: "assistant", content: "q" + (i + 1) });
  }
  return { history, briefState: prior, coverage };
}

function buildThroughU5() {
  return buildThroughTurn(LIVE.length);
}

console.log("\n=== STEP1 BRIEF_READY / !SOLUTION_READY ===");
{
  const ctx = buildThroughTurn(4); // history through U4 + assistant
  const message = LIVE[4];
  const ut = buildUserTurns(ctx.history, message);
  const merged = mergeBriefCoverage(ctx.briefState, {}, ut);
  const brief = evaluateBriefReady(merged.coverage, ut);
  const sol = evaluateSolutionReady(merged.coverage, ut);
  assert("STEP1 brief ready", brief.ready === true);
  assert("STEP1 solution not ready", sol.ready === false);
  assert("STEP1 needs discriminator", needsSolutionDiscriminator(merged.coverage, ut));

  const q = pickSolutionDiscriminatorQuestion(merged.coverage, ut);
  assert("STEP1 asks operational fact", /оплат|запис|заявк/i.test(q));
  assert("STEP1 no X-vs-Y predeclare", !/между готовым|между лендинг|между витрин/i.test(q));

  const reply = await createSmartBriefReply({
    apiKey: "t",
    model: "m",
    history: ctx.history,
    message: message,
    briefState: ctx.briefState,
    callOpenAI: async function () {
      return {
        assistantMessage: "",
        phase: "clarify",
        done: false,
        briefCoverage: {},
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage: "Чтобы выбрать между сайтом и CRM, что вам нужно?",
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      };
    }
  });
  assert("STEP1 phase clarify", reply.phase === "clarify");
  assert("STEP1 one question", (reply.assistantMessage.match(/\?/g) || []).length === 1);
  assert("STEP1 no generic fail", !isGenericFail(reply.assistantMessage));
  assert("STEP1 no X-vs-Y", !/между готовым сервисом записи и отдельной страницей/i.test(reply.assistantMessage));
}

console.log("\n=== STEP2 rich discriminator answer ===");
{
  const base = buildThroughU5();
  // Replace last assistant with discriminator-like question
  base.history[base.history.length - 1] = {
    role: "assistant",
    content:
      "Нужно ли клиенту оплачивать занятие сразу при записи, или пока достаточно забронировать место без онлайн-оплаты?"
  };

  const ut = buildUserTurns(base.history, RICH_ANSWER);
  const merged = mergeBriefCoverage(base.briefState, {}, ut);
  const brief = evaluateBriefReady(merged.coverage, ut);
  const sol = evaluateSolutionReady(merged.coverage, ut);
  const ev = collectSolutionEvidence(merged.coverage, ut);

  assert("STEP2 brief ready", brief.ready === true);
  assert("STEP2 payment stance", ev.noOnlinePayment === true);
  assert("STEP2 schedule dynamic", ev.scheduleDynamic === true);
  assert("STEP2 multi instructor", ev.multiInstructor === true);
  assert("STEP2 capacity limited", ev.capacityLimited === true);
  assert("STEP2 reschedule", ev.reschedule === true);
  assert("STEP2 self booking signal", ev.selfBooking === true);
  assert("STEP2 solution ready", sol.ready === true);
  assert(
    "STEP2 reason grounded",
    sol.reason === "evidence_sufficient" || sol.reason === "problem_shape_schedule_ops"
  );
  assert("STEP2 no longer needs discriminator", needsSolutionDiscriminator(merged.coverage, ut) === false);

  // Provider stays on clarify → must still publish safe recommend
  const replyClarify = await createSmartBriefReply({
    apiKey: "t",
    model: "m",
    history: base.history,
    message: RICH_ANSWER,
    briefState: base.briefState,
    callOpenAI: async function () {
      return {
        assistantMessage: "",
        phase: "clarify",
        done: false,
        briefCoverage: {},
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage: "Продолжим?",
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      };
    }
  });
  assert("STEP2 clarify-model → recommend", replyClarify.phase === "recommend");
  assert("STEP2 no generic fail", !isGenericFail(replyClarify.assistantMessage));
  assert("STEP2 grounded-ish", /сервис|запис|расписан|таблиц|календар/i.test(replyClarify.assistantMessage));
  assert("STEP2 not website-only pitch", !/^вам нужен сайт/i.test(replyClarify.assistantMessage));

  // Valid provider recommend passes
  const replyGood = await createSmartBriefReply({
    apiKey: "t",
    model: "m",
    history: base.history,
    message: RICH_ANSWER,
    briefState: base.briefState,
    callOpenAI: async function () {
      return {
        assistantMessage:
          "По вашей задаче разумнее начать с готового сервиса записи: расписание часто меняется, несколько преподавателей и лимит мест, онлайн-оплата пока не нужна. Альтернатива — страница с заявкой. Таблицу и календарь можно сохранить.",
        phase: "recommend",
        done: true,
        briefCoverage: {},
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage: "",
        recommendationMode: "normal",
        lowEngagement: false,
        expertPlan: validPlan()
      };
    }
  });
  assert("A valid recommend published", replyGood.phase === "recommend");
  assert("A no generic fail", !isGenericFail(replyGood.assistantMessage));
}

console.log("\n=== B website-biased → safe continue ===");
{
  const base = buildThroughU5();
  base.history[base.history.length - 1] = { role: "assistant", content: "q" };
  const reply = await createSmartBriefReply({
    apiKey: "t",
    model: "m",
    history: base.history,
    message: RICH_ANSWER,
    briefState: base.briefState,
    callOpenAI: async function () {
      return {
        assistantMessage: "Вам нужен большой сайт с бронированием с нуля.",
        phase: "recommend",
        done: true,
        briefCoverage: {},
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage: "",
        recommendationMode: "normal",
        lowEngagement: false,
        expertPlan: validPlan({
          primarySolution: "Создать веб-сайт студии",
          alternative: "Создать другой сайт",
          reuseNote: ""
        })
      };
    }
  });
  assert("B no generic fail", !isGenericFail(reply.assistantMessage));
  assert("B not raw website bias", reply.assistantMessage.indexOf("большой сайт с бронированием с нуля") === -1);
  assert("B continue", reply.phase === "recommend" || reply.phase === "clarify");
}

console.log("\n=== C unsupported dump → safe continue ===");
{
  const base = buildThroughU5();
  base.history[base.history.length - 1] = { role: "assistant", content: "q" };
  const reply = await createSmartBriefReply({
    apiKey: "t",
    model: "m",
    history: base.history,
    message: RICH_ANSWER,
    briefState: base.briefState,
    callOpenAI: async function () {
      return {
        assistantMessage: "Сделаем сайт с личным кабинетом и блогом.",
        phase: "recommend",
        done: true,
        briefCoverage: {},
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage: "",
        recommendationMode: "normal",
        lowEngagement: false,
        expertPlan: validPlan({
          addLater: "Личный кабинет, программа лояльности и блог"
        })
      };
    }
  });
  assert("C no generic fail", !isGenericFail(reply.assistantMessage));
  assert("C no unsupported dump published", !/личн\w*\s+кабинет|блог/i.test(reply.assistantMessage));
}

console.log("\n=== D empty/timeout when SOLUTION_READY ===");
{
  const base = buildThroughU5();
  base.history[base.history.length - 1] = { role: "assistant", content: "q" };
  const replyEmpty = await createSmartBriefReply({
    apiKey: "t",
    model: "m",
    history: base.history,
    message: RICH_ANSWER,
    briefState: base.briefState,
    callOpenAI: async function () {
      const err = new Error("empty");
      err.code = "empty_or_invalid_model_output";
      throw err;
    }
  });
  assert("D empty → recommend", replyEmpty.phase === "recommend");
  assert("D empty no write-again", !isGenericFail(replyEmpty.assistantMessage));

  const replyTimeout = await createSmartBriefReply({
    apiKey: "t",
    model: "m",
    history: base.history,
    message: RICH_ANSWER,
    briefState: base.briefState,
    callOpenAI: async function () {
      const err = new Error("timeout");
      err.code = "provider_timeout";
      throw err;
    }
  });
  assert("D timeout → recommend", replyTimeout.phase === "recommend");
  assert("D timeout no write-again", !isGenericFail(replyTimeout.assistantMessage));
}

console.log("\n=== E multi volunteered facts recovered ===");
{
  const base = buildThroughU5();
  const ut = buildUserTurns(base.history, RICH_ANSWER);
  const ev = collectSolutionEvidence(base.coverage, ut);
  assert("E payment", ev.noOnlinePayment);
  assert("E schedule", ev.scheduleDynamic);
  assert("E instructors", ev.multiInstructor);
  assert("E capacity", ev.capacityLimited);
  assert("E reschedule", ev.reschedule);
}

console.log("\n=== F payment-only answer → not auto-ready ===");
{
  const base = buildThroughU5();
  base.history[base.history.length - 1] = { role: "assistant", content: "q" };
  const onlyPay = "Оплата не нужна.";
  const ut = buildUserTurns(base.history, onlyPay);
  const merged = mergeBriefCoverage(base.briefState, {}, ut);
  const sol = evaluateSolutionReady(merged.coverage, ut);
  assert("F solution not ready on payment-only", sol.ready === false);
  const reply = await createSmartBriefReply({
    apiKey: "t",
    model: "m",
    history: base.history,
    message: onlyPay,
    briefState: base.briefState,
    callOpenAI: async function () {
      return {
        assistantMessage: "Рекомендую сайт.",
        phase: "recommend",
        done: true,
        briefCoverage: {},
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage: "",
        recommendationMode: "normal",
        lowEngagement: false,
        expertPlan: validPlan()
      };
    }
  });
  assert("F stays clarify", reply.phase === "clarify");
  assert("F one question", (reply.assistantMessage.match(/\?/g) || []).length === 1);
  assert("F no generic fail", !isGenericFail(reply.assistantMessage));
  assert("F asks next material fact", /расписан|перенос|преподавател|мест/i.test(reply.assistantMessage));
}

console.log("\n=== G rich answer does not keep interrogating ===");
{
  const base = buildThroughU5();
  base.history[base.history.length - 1] = { role: "assistant", content: "q" };
  const ut = buildUserTurns(base.history, RICH_ANSWER);
  const merged = mergeBriefCoverage(base.briefState, {}, ut);
  assert("G solution ready", evaluateSolutionReady(merged.coverage, ut).ready === true);
  const built = buildEvidenceBackedRecommendation(merged.coverage, ut);
  const planOk = evaluateExpertPlan(
    {
      recommendationMode: "normal",
      expertPlan: built.expertPlan,
      assistantMessage: built.assistantMessage
    },
    merged.coverage
  );
  assert("G deterministic plan passes Gate2", planOk.ok === true);
  assert("G not compound", !isCompoundDiscoveryQuestion(built.assistantMessage));
}

if (failed) {
  console.error("\n" + failed + " solution-discriminator regression(s) failed");
  process.exit(1);
}
console.log("\nAll solution-discriminator regressions passed.");
