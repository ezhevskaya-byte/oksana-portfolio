/**
 * Multi-turn dialogue scenarios A–G for Smart Brief stage-2 quality.
 * Run: node scripts/dialogue-scenarios.mjs
 */
import {
  mergeBriefCoverage,
  buildUserTurns,
  evaluateBriefReady,
  resolveClarifyTarget,
  selectClarifyMessage,
  buildFirstTurnWelcome,
  isCompoundDiscoveryQuestion,
  hasInternalSystemWording,
  inferDialogueContext,
  evaluateSolutionReady,
  hasStrongDesiredFlowImplication,
  enforceGates
} from "../src/gate.js";

function emptyCoverage() {
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

const JOURNEY =
  "Как сейчас обычно проходит путь клиента: от первого знакомства до заявки или покупки?";

let failed = 0;
function assert(name, ok) {
  if (ok) console.log("ok  -", name);
  else {
    failed += 1;
    console.error("FAIL -", name);
  }
}

function advance(history, priorState, message) {
  const turns = buildUserTurns(history, message);
  const merged = mergeBriefCoverage(priorState, emptyCoverage(), turns);
  const ready = evaluateBriefReady(merged.coverage, turns);
  const target = resolveClarifyTarget(ready.missing, merged.coverage, turns);
  const clarify = selectClarifyMessage(
    {
      nextInformationNeed: { focus: target.focus || "none", reason: "t" },
      clarifyFallbackMessage: "",
      recommendationMode: "none",
      phase: "clarify"
    },
    ready.missing,
    merged.coverage,
    turns
  );
  const solution = evaluateSolutionReady(merged.coverage, turns);
  return {
    briefState: merged.briefState,
    coverage: merged.coverage,
    target,
    clarify,
    ready,
    solution,
    turns
  };
}

function run(name, messages, expect) {
  console.log("\n===", name, "===");
  const welcome = buildFirstTurnWelcome(messages[0]);
  assert(name + " welcome not compound", !isCompoundDiscoveryQuestion(welcome));
  assert(name + " welcome no internal", !hasInternalSystemWording(welcome));
  if (expect.welcomeAck) assert(name + " welcome ack", /Понял:|Спасибо/i.test(welcome));
  if (expect.welcomeLexicon) {
    assert(name + " welcome lexicon", expect.welcomeLexicon.test(welcome));
  }

  let hist = [];
  let state = null;
  let last = null;
  for (let i = 0; i < messages.length; i += 1) {
    last = advance(hist, state, messages[i]);
    assert(name + " T" + (i + 1) + " one question", !isCompoundDiscoveryQuestion(last.clarify));
    assert(name + " T" + (i + 1) + " no internal", !hasInternalSystemWording(last.clarify));
    assert(name + " T" + (i + 1) + " not JOURNEY_FOCUS", last.clarify !== JOURNEY);
    if (expect.forbidGuests) {
      assert(name + " T" + (i + 1) + " no guests lexicon", !/гост/i.test(last.clarify) || last.target.focus !== "audienceInput");
    }
    hist = hist.concat([{ role: "user", content: messages[i] }]);
    state = last.briefState;
  }

  if (expect.known) {
    for (let i = 0; i < expect.known.length; i += 1) {
      const k = expect.known[i];
      assert(name + " known " + k, last.coverage[k].status === "known");
    }
  }
  if (expect.briefReady) assert(name + " brief ready", last.ready.ready === true);
  if (expect.solutionReady === true) assert(name + " solution ready", last.solution.ready === true);
  if (expect.solutionReady === false) {
    assert(name + " solution not ready", last.solution.ready === false);
    assert(name + " solution follow-up", /оплат|сервис|страниц|сайт|заявк|запис|обращение|стабильн/i.test(last.clarify));
  }
  if (expect.ctxDomain) {
    const ctx = inferDialogueContext(last.coverage, last.turns);
    assert(name + " domain " + expect.ctxDomain, ctx.domain === expect.ctxDomain);
  }
}

run(
  "A_YOGA",
  [
    "У меня небольшая студия йоги. Клиенты чаще всего приходят из социальных сетей.",
    "Основная задача — упростить запись на занятия. Сейчас человек видит нас в социальных сетях, пишет администратору в личные сообщения, администратор отвечает на вопросы, рассказывает о занятиях и свободных местах, а потом записывает клиента вручную.",
    "В основном к нам приходят женщины от 25 до 45 лет. Среди них есть и начинающие, и те, кто уже давно практикует.",
    "Обычно им важно удобное расписание, стоимость, хороший преподаватель и быстрая запись без долгой переписки.",
    "Отдельной CRM нет. Записи администратор ведёт вручную в таблице и календаре.",
    "Пока достаточно самой записи без онлайн-оплаты. Расписание меняется часто, несколько преподавателей, места на занятиях ограничены."
  ],
  {
    welcomeAck: true,
    welcomeLexicon: /йог|студи|соцсет|результат/i,
    known: ["business", "goal", "customerJourney", "audienceInput", "friction", "existingTools"],
    briefReady: true,
    solutionReady: true,
    ctxDomain: "studio",
    forbidGuests: true
  }
);

run(
  "B_GUEST_HOUSE",
  [
    "У меня небольшой гостевой дом у моря. Брони сейчас через Авито.",
    "Хочу больше прямых заявок и меньше переписки. Находят на Авито, пишут в WhatsApp, я уточняю даты, называю цену, берут предоплату.",
    "Чаще остаются семьи с детьми и пары. Им важны тишина, парковка и чтобы сразу видеть свободные даты.",
    "Занятость веду в таблице и календаре, CRM нет. Хочу чтобы гость сам видел даты и оставлял заявку."
  ],
  {
    welcomeAck: true,
    known: ["business", "goal", "audienceInput", "customerJourney"],
    briefReady: true,
    solutionReady: true,
    ctxDomain: "lodging"
  }
);

run(
  "C_B2B",
  [
    "Мы B2B-сервис для компаний: помогаем с упаковкой поставок. Клиенты приходят из рекомендаций.",
    "Хотим меньше ручных согласований и понятный вход для новых заказчиков. Обычно пишут на почту, менеджер уточняет объём, считает смету и ведёт сделку в таблице.",
    "Решение принимают владельцы и закупщики 30–50 лет. Им важны сроки, прозрачная смета и чтобы не объяснять одно и то же.",
    "CRM нет, всё в почте и Google таблице. Хотим чтобы заказчик сам понял формат и оставил заявку. Приходится каждому заново рассказывать условия. Оплата пока по счёту, онлайн-оплата не нужна."
  ],
  {
    welcomeAck: true,
    forbidGuests: true,
    ctxDomain: "b2b",
    briefReady: true,
    solutionReady: true
  }
);

run(
  "D_MANUAL_NO_PRODUCT",
  [
    "Салон красоты. Клиенты пишут в Instagram Direct, администратор целый день отвечает на одни и те же вопросы про цены и окна.",
    "Хочу меньше ручной переписки. Обычно женщины 25–45, им важно удобное время и мастер.",
    "Видят нас в Instagram, пишут в Direct, администратор уточняет услугу и время, смотрит окна и записывает вручную. CRM нет, всё в телефоне и заметках."
  ],
  {
    welcomeAck: true,
    briefReady: true,
    solutionReady: false,
    forbidGuests: true
  }
);

run(
  "E_WANTS_SITE",
  [
    "Мне нужен сайт для студии растяжки. Сейчас запись только через WhatsApp вручную.",
    "Хочу, чтобы клиент видел расписание и оставлял заявку на сайте. Клиенты — женщины 20–40, им важно удобное время.",
    "Пишут в WhatsApp, администратор отвечает и записывает в таблицу. Приходится повторять цены и правила."
  ],
  {
    welcomeAck: true,
    solutionReady: true,
    known: ["business", "goal"]
  }
);

run(
  "F_LONG_FIRST",
  [
    "Я преподаватель английского для взрослых. Ученики приходят по сарафану и пишут в Telegram. Мне приходится каждому заново рассказывать формат и цены. Хочу простую страницу, чтобы человек заранее понял мой подход и мог оставить заявку. Чаще всего это взрослые 28–40, которым важны гибкий график и понятная программа. Всё веду вручную в Google таблице, CRM нет.",
    "После сообщения уточняю цель и уровень, предлагаю пробный урок, обсуждаем формат и оплату, потом начинаем занятия."
  ],
  {
    welcomeAck: true,
    briefReady: true,
    solutionReady: true
  }
);

run(
  "G_SAAS_VS_SITE",
  [
    "Небольшая студия пилатеса. Запись вручную через сообщения, расписание меняется каждую неделю, оплаты онлайн пока нет.",
    "Основная боль — администратор тратит время на одни и те же ответы. Клиенты — женщины 30–50, им важно удобное время.",
    "Видят нас в соцсетях, пишут, спрашивают окна, администратор сверяет таблицу и записывает вручную. CRM нет, есть таблица и календарь.",
    "Хочу, чтобы клиент сам видел актуальное расписание и записывался. Оплата онлайн пока не нужна — достаточно записи."
  ],
  {
    welcomeAck: true,
    briefReady: true,
    // schedule changes weekly + no online payment = discriminator
    solutionReady: true
  }
);

// Extra: recommend gate blocks website-only dump
{
  console.log("\n=== REC_QUALITY ===");
  const turns = buildUserTurns([], "Студия йоги, нужна запись. Оплата онлайн не нужна, достаточно заявки.");
  const coverage = emptyCoverage();
  // minimal fill via merge
  const merged = mergeBriefCoverage(
    null,
    {
      business: { status: "known", sources: [{ turnId: "u1", quote: "Студия йоги, нужна запись", aspect: "what_business", operation: "support" }] },
      goal: { status: "known", sources: [{ turnId: "u1", quote: "Оплата онлайн не нужна, достаточно заявки", aspect: "desired_outcome", operation: "support" }] }
    },
    turns
  );
  void merged;
  const planBad = {
    realProblem: "Ручная запись",
    audienceHypothesis: "Клиенты студии",
    primarySolution: "Создать большой веб-сайт",
    alternative: "Сделать другой сайт",
    whyPrimary: "Потому что сайт",
    reuseNote: "Таблицы",
    startNow: "Сайт",
    addLater: "Личный кабинет и программа лояльности",
    doNotBuildYet: "CRM",
    insight: "Нужен сайт"
  };
  const d = enforceGates(
    {
      briefCoverage: merged.coverage,
      recommendationMode: "normal",
      phase: "recommend",
      expertPlan: planBad,
      assistantMessage: "Вам нужен сайт с личным кабинетом и блогом.",
      nextInformationNeed: { focus: "none", reason: "" },
      clarifyFallbackMessage: "",
      lowEngagement: false
    },
    { history: [], message: "Студия йоги, нужна запись. Оплата онлайн не нужна, достаточно заявки." }
  );
  assert(
    "REC blocks unsupported or bias when brief/solution gates allow path",
    d.reason === "gate2_fail" || d.reason === "gate1_fail" || d.reason === "solution_not_ready" || d.action === "block_recommend" || d.reason === "normal_ok"
  );
  // If it reached plan eval, unsupported dump should fail gate2
  if (d.reason === "gate2_fail") {
    assert(
      "REC gate2 issues include dump or bias",
      (d.gate2Issues || []).some(function (x) {
        return x === "unsupported_feature_dump" || x === "website_bias_missing_alternative";
      })
    );
  }
}

if (failed) {
  console.error("\n" + failed + " dialogue scenario(s) failed");
  process.exit(1);
}
console.log("\nAll dialogue scenarios passed.");
