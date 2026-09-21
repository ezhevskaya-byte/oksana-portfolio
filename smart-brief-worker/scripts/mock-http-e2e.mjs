/**
 * Full HTTP-path E2E with mocked OpenAI only.
 * Path: JSON body → validateChatBody → trimHistory → createSmartBriefReply(mock)
 *       → JSON response → client briefState/history round-trip → next request.
 *
 * No production API backdoor. No real provider call.
 * Run: node scripts/mock-http-e2e.mjs
 */
import { createSmartBriefReply } from "../src/openai.js";
import { validateChatBody, trimHistoryForModel } from "../src/validate.js";
import {
  buildUserTurns,
  evaluateBriefReady,
  resolveServerFocus,
  isServerFocusPrompt
} from "../src/gate.js";

const AUDIENCE_FOCUS =
  "Кто чаще всего к вам обращается, и что этим людям обычно важно при выборе?";
const JOURNEY_FOCUS =
  "Как сейчас обычно проходит путь клиента: от первого знакомства до заявки или покупки?";
const TOOLS_FOCUS =
  "Какими инструментами вы уже пользуетесь: сайт, соцсети, CRM, система бронирования, таблицы, бот?";
const FLOW_FOCUS =
  "В идеале что клиент должен иметь возможность сделать сам, и что должно стать проще для вас?";

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("ok  -", name);
  else {
    failed += 1;
    console.error("FAIL -", name);
  }
}

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

function src(turnId, quote, aspect, operation) {
  return {
    turnId,
    quote,
    aspect,
    operation: operation === "replace" ? "replace" : "support"
  };
}

function field(sources) {
  return { status: sources.length ? "partial" : "unknown", sources };
}

function countUsers(input) {
  let n = 0;
  for (let i = 0; i < (input || []).length; i += 1) {
    if (input[i] && input[i].role === "user") n += 1;
  }
  return n;
}

function lastUser(input) {
  for (let i = (input || []).length - 1; i >= 0; i -= 1) {
    if (input[i] && input[i].role === "user") return String(input[i].content || "");
  }
  return "";
}

function isRecommendRepair(instructions) {
  return /RECOMMEND REPAIR MODE/i.test(instructions || "");
}

function reusePlan(overrides) {
  return Object.assign(
    {
      realProblem: "Слабый прямой канал и повторяющиеся вопросы до решения",
      audienceHypothesis: "Типичные клиенты и критерии выбора уже прояснены из диалога",
      primarySolution: "Компактный сайт с переиспользованием уже имеющихся инструментов",
      alternative: "none: сначала усилить прямой канал на базе текущего стека",
      whyPrimary: "Закрывает информирование до обращения без лишней разработки",
      reuseNote: "Переиспользовать уже описанные инструменты клиента",
      startNow: "Витрина/лендинг с ключевой информацией и подключением текущего стека",
      addLater: "Контент и FAQ по сегментам",
      doNotBuildYet: "Не строить с нуля то, что уже есть в операционном стеке",
      insight: "Главный рычаг — снять трение до контакта, а не «просто сайт»"
    },
    overrides || {}
  );
}

function guestReusePlan() {
  return reusePlan({
    realProblem: "Зависимость от Авито и повторяющиеся вопросы до бронирования",
    audienceHypothesis: "Пары 30–50 и семьи; важны тишина, чистота, море, понятный номер и цена",
    primarySolution:
      "Сайт-витрина с интеграцией уже существующего модуля онлайн-бронирования",
    alternative: "none: модуль бронирования уже есть — отдельный booking engine не нужен",
    whyPrimary: "Прямой канал и FAQ без новой системы бронирования",
    reuseNote:
      "Переиспользовать систему бронирования: календарь, цены и готовый модуль онлайн-бронирования",
    startNow: "Сайт с ключевой информацией и подключением существующего модуля",
    doNotBuildYet: "Не строить бронирование с нуля",
    insight: "Актив — уже есть модуль бронирования"
  });
}

/** Deterministic model: cites only NEW turn evidence; often wrongly asks audience. */
function createScriptedMock(script) {
  return async function callOpenAI({ instructions, input }) {
    const n = countUsers(input);
    const msg = lastUser(input);

    if (isRecommendRepair(instructions)) {
      return script.recommend(n, msg);
    }

    if (typeof script.turn === "function") {
      return script.turn(n, msg, instructions);
    }
    throw new Error("mock_missing_turn_handler");
  };
}

/**
 * Simulate Worker handleChat HTTP envelope without rate-limit/CORS side effects.
 */
async function httpChat({ sessionId, message, history, briefState, callOpenAI }) {
  const body = JSON.stringify({ sessionId, message, history, briefState });
  const raw = JSON.parse(body);
  const validated = validateChatBody(raw);
  if (!validated.ok) {
    return { status: 400, payload: { ok: false, error: "validation_error" } };
  }
  const trimmed = trimHistoryForModel(validated.data.history);
  const reply = await createSmartBriefReply({
    apiKey: "test-key",
    model: "mock",
    history: trimmed,
    message: validated.data.message,
    briefState: validated.data.briefState,
    callOpenAI
  });
  const responseBody = JSON.stringify({
    ok: true,
    sessionId: validated.data.sessionId || sessionId || "e2e",
    assistantMessage: reply.assistantMessage,
    phase: reply.phase,
    done: Boolean(reply.done),
    briefState: reply.briefState != null ? reply.briefState : null
  });
  return { status: 200, payload: JSON.parse(responseBody) };
}

async function runConversation(name, turns, callOpenAI, options) {
  const opts = options || {};
  let sessionId = "e2e-" + name;
  let history = [];
  let briefState = null;
  const transcript = [];
  const seenFocusPrompts = [];

  for (let i = 0; i < turns.length; i += 1) {
    const dropState = opts.dropBriefStateAfter != null && i > opts.dropBriefStateAfter;
    const reqState = dropState ? null : briefState;

    const res = await httpChat({
      sessionId,
      message: turns[i],
      history,
      briefState: reqState,
      callOpenAI
    });
    assert(name + " u" + (i + 1) + " http 200", res.status === 200 && res.payload.ok === true);

    const p = res.payload;
    sessionId = p.sessionId || sessionId;
    if (Object.prototype.hasOwnProperty.call(p, "briefState")) {
      briefState = p.briefState;
    }

    const assistant = String(p.assistantMessage || "");
    transcript.push({
      u: i + 1,
      phase: p.phase,
      assistant: assistant.slice(0, 160),
      droppedState: dropState
    });

    if (isServerFocusPrompt(assistant)) seenFocusPrompts.push(assistant);

    // No-repeat: after a field was answered, forbid its full FOCUS_PROMPT later
    if (opts.forbidAudienceAfterU3 && i >= 3) {
      assert(name + " u" + (i + 1) + " no audience re-ask", assistant !== AUDIENCE_FOCUS);
    }
    if (opts.forbidJourneyAfterU4 && i >= 4) {
      assert(name + " u" + (i + 1) + " no journey re-ask", assistant !== JOURNEY_FOCUS);
    }
    if (opts.forbidToolsAfterU5 && i >= 5) {
      assert(name + " u" + (i + 1) + " no tools re-ask", assistant !== TOOLS_FOCUS);
    }

    history = history.concat([
      { role: "user", content: turns[i] },
      { role: "assistant", content: assistant }
    ]);
    // Client wire continuum
    history = JSON.parse(JSON.stringify(history));
    briefState =
      briefState == null ? null : JSON.parse(JSON.stringify(briefState));
  }

  return { transcript, briefState, history, seenFocusPrompts };
}

function guesthouseMock() {
  return createScriptedMock({
    turn: function (n) {
      const cov = emptyCoverage();
      if (n === 1) {
        return {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          briefCoverage: Object.assign(cov, {
            business: field([
              src("u1", "небольшой гостевой дом", "what_business")
            ]),
            goal: field([src("u1", "мне нужен сайт", "desired_outcome")])
          }),
          nextInformationNeed: { focus: "none", reason: "" },
          clarifyFallbackMessage:
            "Здравствуйте. Я Марк, AI-помощник Оксаны Ежевской. Спасибо, что написали. Можете свободно, своими словами рассказать о задаче — это не анкета.",
          recommendationMode: "none",
          lowEngagement: false,
          expertPlan: null
        };
      }
      if (n === 2) {
        return {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          briefCoverage: Object.assign(cov, {
            goal: field([
              src("u2", "Хочется меньше зависеть от Авито", "desired_outcome")
            ]),
            friction: field([
              src(
                "u2",
                "не приходилось каждому гостю заново отвечать на одни и те же вопросы",
                "pain"
              )
            ])
          }),
          nextInformationNeed: { focus: "audienceInput", reason: "need audience" },
          clarifyFallbackMessage: AUDIENCE_FOCUS,
          recommendationMode: "none",
          lowEngagement: false,
          expertPlan: null
        };
      }
      if (n === 3) {
        return {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          briefCoverage: Object.assign(cov, {
            audienceInput: field([
              src(
                "u3",
                "Чаще всего у нас отдыхают пары примерно 30–50 лет и семьи с детьми.",
                "who_or_segment"
              ),
              src(
                "u3",
                "Обычно им важно, чтобы было спокойно, чисто, недалеко от моря и чтобы заранее было понятно, какой номер они бронируют и сколько будет стоить проживание.",
                "what_matters"
              )
            ])
          }),
          nextInformationNeed: { focus: "customerJourney", reason: "need journey" },
          clarifyFallbackMessage: JOURNEY_FOCUS,
          recommendationMode: "none",
          lowEngagement: false,
          expertPlan: null
        };
      }
      if (n === 4) {
        // Live variance: journey only + BAD audience focus attempt
        return {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          briefCoverage: Object.assign(cov, {
            customerJourney: field([
              src(
                "u4",
                "Обычно впервые находят нас на Авито. Смотрят объявление, фотографии и описание, потом пишут там же или переходят в WhatsApp, иногда звонят. Я отвечаю на вопросы, уточняю даты и количество гостей, проверяю свободные номера, называю стоимость. Если всё подходит, гость переводит предоплату, и я подтверждаю бронь.",
                "path_steps"
              )
            ])
          }),
          nextInformationNeed: { focus: "audienceInput", reason: "wrong reopen" },
          clarifyFallbackMessage: AUDIENCE_FOCUS,
          recommendationMode: "none",
          lowEngagement: false,
          expertPlan: null
        };
      }
      if (n === 5) {
        return {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          briefCoverage: Object.assign(cov, {
            existingTools: field([
              src(
                "u5",
                "Занятость веду в системе бронирования. Там есть календарь, цены и готовый модуль онлайн-бронирования, который можно подключить к сайту.",
                "tools"
              )
            ]),
            desiredFlow: field([
              src(
                "u5",
                "Через него гость может сам посмотреть свободные номера и оформить бронь.",
                "ideal_flow"
              )
            ])
          }),
          // Stay on clarify even if ready — triggers recommend repair
          nextInformationNeed: { focus: "none", reason: "" },
          clarifyFallbackMessage: "Могу предложить направление?",
          recommendationMode: "none",
          lowEngagement: false,
          expertPlan: null
        };
      }
      // U6+ if needed
      return {
        assistantMessage: "",
        phase: "clarify",
        done: false,
        briefCoverage: Object.assign(cov, {
          desiredFlow: field([
            src(
              "u6",
              "Хочу, чтобы человек на сайте сам посмотрел номера, фотографии, цены и свободные даты, получил ответы на основные вопросы и, если всё подходит, сразу оформил бронь через эту систему.",
              "ideal_flow"
            )
          ])
        }),
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage: "Продолжим к рекомендации?",
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      };
    },
    recommend: function () {
      return {
        assistantMessage:
          "Рекомендую компактный сайт с подключением вашего готового модуля онлайн-бронирования — календарь и цены уже есть, бронирование с нуля строить не нужно.",
        phase: "recommend",
        done: false,
        briefCoverage: emptyCoverage(),
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage: "",
        recommendationMode: "normal",
        lowEngagement: false,
        expertPlan: guestReusePlan()
      };
    }
  });
}

function nicheMock(planOverrides, quotes) {
  const q = quotes;
  return createScriptedMock({
    turn: function (n) {
      const cov = emptyCoverage();
      if (n === 1) {
        return {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          briefCoverage: Object.assign(cov, {
            business: field([src("u1", q.business, "what_business")]),
            goal: field([src("u1", q.goal1, "desired_outcome")])
          }),
          nextInformationNeed: { focus: "none", reason: "" },
          clarifyFallbackMessage:
            "Здравствуйте. Я Марк, AI-помощник Оксаны Ежевской. Расскажите задачу своими словами — это не анкета.",
          recommendationMode: "none",
          lowEngagement: false,
          expertPlan: null
        };
      }
      if (n === 2) {
        return {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          briefCoverage: Object.assign(cov, {
            goal: field([src("u2", q.goal2, "desired_outcome")]),
            friction: field([src("u2", q.friction, "pain")])
          }),
          nextInformationNeed: { focus: "audienceInput", reason: "aud" },
          clarifyFallbackMessage: AUDIENCE_FOCUS,
          recommendationMode: "none",
          lowEngagement: false,
          expertPlan: null
        };
      }
      if (n === 3) {
        return {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          briefCoverage: Object.assign(cov, {
            audienceInput: field([
              src("u3", q.who, "who_or_segment"),
              src("u3", q.matters, "what_matters")
            ])
          }),
          nextInformationNeed: { focus: "customerJourney", reason: "j" },
          clarifyFallbackMessage: JOURNEY_FOCUS,
          recommendationMode: "none",
          lowEngagement: false,
          expertPlan: null
        };
      }
      if (n === 4) {
        return {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          briefCoverage: Object.assign(cov, {
            customerJourney: field([src("u4", q.journey, "path_steps")])
          }),
          nextInformationNeed: { focus: "audienceInput", reason: "bad reopen" },
          clarifyFallbackMessage: AUDIENCE_FOCUS,
          recommendationMode: "none",
          lowEngagement: false,
          expertPlan: null
        };
      }
      return {
        assistantMessage: "",
        phase: "clarify",
        done: false,
        briefCoverage: Object.assign(cov, {
          existingTools: field([src("u5", q.tools, "tools")]),
          desiredFlow: field([src("u5", q.flow, "ideal_flow")])
        }),
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage: "Можем перейти к рекомендации?",
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      };
    },
    recommend: function () {
      return {
        assistantMessage: q.recommendText,
        phase: "recommend",
        done: false,
        briefCoverage: emptyCoverage(),
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage: "",
        recommendationMode: "normal",
        lowEngagement: false,
        expertPlan: reusePlan(planOverrides)
      };
    }
  });
}

// ========== GUESTHOUSE ==========
const GH = {
  u1: "Здравствуйте. У меня небольшой гостевой дом, и я думаю, что мне нужен сайт.",
  u2: "Сейчас основные бронирования приходят через Авито. Иногда люди пишут в WhatsApp или звонят. Своего сайта нет. Хочется меньше зависеть от Авито и чтобы мне не приходилось каждому гостю заново отвечать на одни и те же вопросы.",
  u3: "Чаще всего у нас отдыхают пары примерно 30–50 лет и семьи с детьми. Обычно им важно, чтобы было спокойно, чисто, недалеко от моря и чтобы заранее было понятно, какой номер они бронируют и сколько будет стоить проживание. Многие перед бронированием спрашивают про бассейн, условия для детей и что есть в номере.",
  u4: "Обычно впервые находят нас на Авито. Смотрят объявление, фотографии и описание, потом пишут там же или переходят в WhatsApp, иногда звонят. Я отвечаю на вопросы, уточняю даты и количество гостей, проверяю свободные номера, называю стоимость. Если всё подходит, гость переводит предоплату, и я подтверждаю бронь. Больше всего вопросов возникает до бронирования, когда человек сравнивает варианты и хочет понять, подходит ли ему наш гостевой дом.",
  u5: "Занятость веду в системе бронирования. Там есть календарь, цены и готовый модуль онлайн-бронирования, который можно подключить к сайту. Через него гость может сам посмотреть свободные номера и оформить бронь. Для общения использую WhatsApp и телефон. CRM нет, отдельного бота тоже нет.",
  u6: "Хочу, чтобы человек на сайте сам посмотрел номера, фотографии, цены и свободные даты, получил ответы на основные вопросы и, если всё подходит, сразу оформил бронь через эту систему. Мне хотелось бы подключаться только если у гостя остался нестандартный вопрос или нужна помощь."
};

console.log("\n=== E2E guesthouse continuum ===");
{
  const mock = guesthouseMock();
  const { transcript } = await runConversation(
    "GH",
    [GH.u1, GH.u2, GH.u3, GH.u4, GH.u5],
    mock,
    { forbidAudienceAfterU3: true, forbidJourneyAfterU4: true, forbidToolsAfterU5: true }
  );
  console.log("GH progression:");
  for (let i = 0; i < transcript.length; i += 1) {
    console.log(
      "  u" + transcript[i].u,
      "phase=" + transcript[i].phase,
      "|",
      transcript[i].assistant.replace(/\s+/g, " ").slice(0, 100)
    );
  }
  assert("GH u4 not audience", transcript[3].assistant !== AUDIENCE_FOCUS);
  assert("GH u4 is tools or flow clarify", /инструмент|бронир|CRM|сам|проще/i.test(transcript[3].assistant));
  const last = transcript[transcript.length - 1];
  assert("GH ends recommend", last.phase === "recommend");
  assert("GH reuses module", /модул|календар|подключ/i.test(last.assistant));
  assert("GH no build from scratch", !/бронирование с нуля(?!.*не)/i.test(last.assistant) || /не нуж|не строи/i.test(last.assistant));
}

console.log("\n=== E2E guesthouse recovery WITHOUT briefState ===");
{
  const mock = guesthouseMock();
  const { transcript } = await runConversation(
    "GH-wipe",
    [GH.u1, GH.u2, GH.u3, GH.u4, GH.u5],
    mock,
    {
      dropBriefStateAfter: 2, // wipe starting U4 request
      forbidAudienceAfterU3: true,
      forbidJourneyAfterU4: true
    }
  );
  assert("GH-wipe u4 no audience", transcript[3].assistant !== AUDIENCE_FOCUS);
  assert(
    "GH-wipe u4 not journey repeat",
    transcript[3].assistant !== JOURNEY_FOCUS
  );
  assert(
    "GH-wipe never audience after u3",
    transcript.slice(3).every(function (t) {
      return t.assistant !== AUDIENCE_FOCUS;
    })
  );
}

console.log("\n=== E2E niches ===");
const niches = [
  {
    name: "service",
    turns: [
      "Здравствуйте. Я внедряю CRM для небольших клиник и хочу понятный сайт.",
      "Заявки сейчас из сарафана и Instagram. Хочется больше прямых обращений и меньше объяснять одно и то же.",
      "Чаще всего к нам обращаются клиенты — владельцы небольших клиник. Обычно им важно быстро понять стоимость и сроки внедрения.",
      "Обычно находят через рекомендацию, смотрят профиль, пишут в WhatsApp, я уточняю задачу и называю стоимость, потом согласуем старт и договор.",
      "Из инструментов: WhatsApp и Google Таблицы. CRM для себя нет. Хочу, чтобы клиент сам оставлял заявку и видел пакеты услуг."
    ],
    quotes: {
      business: "внедряю CRM для небольших клиник",
      goal1: "хочу понятный сайт",
      goal2: "больше прямых обращений",
      friction: "меньше объяснять одно и то же",
      who: "Чаще всего к нам обращаются клиенты — владельцы небольших клиник.",
      matters: "Обычно им важно быстро понять стоимость и сроки внедрения.",
      journey:
        "Обычно находят через рекомендацию, смотрят профиль, пишут в WhatsApp, я уточняю задачу и называю стоимость, потом согласуем старт и договор.",
      tools: "Из инструментов: WhatsApp и Google Таблицы. CRM для себя нет.",
      flow: "Хочу, чтобы клиент сам оставлял заявку и видел пакеты услуг.",
      recommendText:
        "Сделаем лендинг услуг с формой заявки, опираясь на WhatsApp и Google Таблицы — без своей CRM с нуля."
    },
    plan: {
      reuseNote: "Переиспользовать WhatsApp и Google Таблицы; не плодить лишние системы сразу",
      primarySolution: "Лендинг услуг с формой заявки на текущем стеке",
      doNotBuildYet: "Не строить свою CRM с нуля на старте"
    }
  },
  {
    name: "shop",
    turns: [
      "Здравствуйте. У меня небольшой магазин детской одежды, нужен сайт.",
      "Сейчас продажи через Instagram и переписку. Хочется меньше зависеть от ленты и сократить однотипные вопросы.",
      "Чаще всего у нас покупают семьи с детьми дошкольного возраста. При выборе им важно наличие размеров и понятная доставка.",
      "Обычно находят в Instagram, смотрят фото, пишут в Direct, уточняют размер и доставку, я называю стоимость, потом оформляем заказ и оплату.",
      "Сейчас Instant и таблица заказов в Excel. Отдельной CMS нет. Хочу, чтобы человек сам видел наличие и оставлял заказ."
    ],
    quotes: {
      business: "небольшой магазин детской одежды",
      goal1: "нужен сайт",
      goal2: "меньше зависеть от ленты",
      friction: "сократить однотипные вопросы",
      who: "Чаще всего у нас покупают семьи с детьми дошкольного возраста.",
      matters: "При выборе им важно наличие размеров и понятная доставка.",
      journey:
        "Обычно находят в Instagram, смотрят фото, пишут в Direct, уточняют размер и доставку, я называю стоимость, потом оформляем заказ и оплату.",
      tools: "таблица заказов в Excel",
      flow: "Хочу, чтобы человек сам видел наличие и оставлял заказ.",
      recommendText:
        "Витрина с наличием и заявкой на базе текущего Instagram/Excel-контура, без маркетплейса с нуля."
    },
    plan: {
      reuseNote: "Опереться на Instagram и Excel-учёт на старте",
      primarySolution: "Витрина с наличием и заявкой без тяжёлой платформы сразу",
      doNotBuildYet: "Не строить полный маркетплейс с нуля"
    }
  },
  {
    name: "education",
    turns: [
      "Здравствуйте. Я запускаю онлайн-курс смены профессии и думаю о сайте.",
      "Заявки идут из Telegram и прогревов. Хочется понятную страницу курса и меньше повторять программу в личке.",
      "Чаще всего к нам приходят взрослые клиенты, которые меняют профессию. Им важно понять программу курса и поддержку после обучения.",
      "Обычно узнают из Telegram, читают описание курса, пишут в бот, я уточняю цели и отвечаю на вопросы про программу и стоимость, проверяю места в потоке, называю цену, затем человек оплачивает и я подтверждаю запись в чат потока.",
      "Есть Telegram, платёжная ссылка и таблица учеников. LMS пока нет. Хочу, чтобы человек сам увидел программу, цены и оставил заявку или оплатил."
    ],
    quotes: {
      business: "онлайн-курс смены профессии",
      goal1: "думаю о сайте",
      goal2: "понятную страницу курса",
      friction: "меньше повторять программу в личке",
      who: "Чаще всего к нам приходят взрослые клиенты, которые меняют профессию.",
      matters: "Им важно понять программу курса и поддержку после обучения.",
      journey:
        "Обычно узнают из Telegram, читают описание курса, пишут в бот, я уточняю цели и отвечаю на вопросы про программу и стоимость, проверяю места в потоке, называю цену, затем человек оплачивает и я подтверждаю запись в чат потока.",
      tools: "Есть Telegram, платёжная ссылка и таблица учеников",
      flow: "Хочу, чтобы человек сам увидел программу, цены и оставил заявку или оплатил.",
      recommendText:
        "Посадочная курса с программой и заявкой, с переиспользованием Telegram и таблицы учеников — без LMS с нуля."
    },
    plan: {
      reuseNote: "Переиспользовать Telegram и текущую оплату/таблицу учеников",
      primarySolution: "Посадочная курса с программой и заявкой/оплатой на текущем стеке",
      doNotBuildYet: "Не строить полноценную LMS с нуля на первом шаге"
    }
  },
  {
    name: "local",
    turns: [
      "Здравствуйте. Делаю ремонт квартир в городе и хочу сайт под заявки.",
      "Сейчас клиенты находят через Авито и рекомендации, пишут в WhatsApp. Хочется меньше зависеть от площадок.",
      "Чаще всего к нам обращаются семьи, которые делают ремонт перед заездом. Обычно им важно понять сроки, этапы и ориентир по бюджету.",
      "Обычно находят на Авито, смотрят фото работ, пишут в WhatsApp, я уточняю объём, называю ориентир, затем выезд и смета, после предоплаты стартуем.",
      "Заявки и сметы веду в Google Таблице, для связи WhatsApp и Авито, фото работ в облаке. CRM нет. Хочу, чтобы человек сам посмотрел примеры работ и оставил заявку на оценку."
    ],
    quotes: {
      business: "ремонт квартир в городе",
      goal1: "хочу сайт под заявки",
      goal2: "меньше зависеть от площадок",
      friction: "пишут в WhatsApp",
      who: "Чаще всего к нам обращаются семьи, которые делают ремонт перед заездом.",
      matters: "Обычно им важно понять сроки, этапы и ориентир по бюджету.",
      journey:
        "Обычно находят на Авито, смотрят фото работ, пишут в WhatsApp, я уточняю объём, называю ориентир, затем выезд и смета, после предоплаты стартуем.",
      tools: "Заявки и сметы веду в Google Таблице, для связи WhatsApp и Авито, фото работ в облаке",
      flow: "Хочу, чтобы человек сам посмотрел примеры работ и оставил заявку на оценку.",
      recommendText:
        "Сайт-портфолио с заявкой на оценку, с опорой на WhatsApp и Google Таблицу — без CRM с нуля."
    },
    plan: {
      reuseNote: "Сохранить WhatsApp и портфолио в облаке как рабочий контур",
      primarySolution: "Сайт-портфолио с заявкой на оценку без тяжёлой CRM сразу",
      doNotBuildYet: "Не строить сложную CRM/ERP с нуля"
    }
  }
];

for (let n = 0; n < niches.length; n += 1) {
  const sc = niches[n];
  console.log("\n--- niche", sc.name, "---");
  const mock = nicheMock(sc.plan, sc.quotes);
  const { transcript } = await runConversation("N-" + sc.name, sc.turns, mock, {
    forbidAudienceAfterU3: true,
    forbidJourneyAfterU4: true
  });
  for (let i = 0; i < transcript.length; i += 1) {
    console.log(
      "  u" + transcript[i].u,
      "phase=" + transcript[i].phase,
      "|",
      transcript[i].assistant.replace(/\s+/g, " ").slice(0, 90)
    );
  }
  const last = transcript[transcript.length - 1];
  assert(
    sc.name + " never full audience after u3",
    transcript.slice(3).every(function (t) {
      return t.assistant !== AUDIENCE_FOCUS;
    })
  );
  assert(
    sc.name + " no premature recommend before u3",
    transcript.slice(0, 3).every(function (t) {
      return t.phase !== "recommend";
    })
  );
  assert(sc.name + " u4 blocked audience", transcript[3].assistant !== AUDIENCE_FOCUS);
  assert(sc.name + " ends recommend", last.phase === "recommend");
  assert(
    sc.name + " recommend reuse wording",
    /whatsapp|telegram|excel|таблиц|облак|стек|переисп|сохран|oport/i.test(last.assistant) ||
      /WhatsApp|Telegram|Excel|таблиц|облак/.test(last.assistant)
  );
}

// Internal proof: wiped-state recovery focus after U4 history
console.log("\n=== recovery focus proof ===");
{
  const hist = [
    { role: "user", content: GH.u1 },
    { role: "assistant", content: "w" },
    { role: "user", content: GH.u2 },
    { role: "assistant", content: AUDIENCE_FOCUS },
    { role: "user", content: GH.u3 },
    { role: "assistant", content: JOURNEY_FOCUS }
  ];
  const body = JSON.stringify({
    sessionId: "rec",
    message: GH.u4,
    history: hist,
    briefState: null
  });
  const validated = validateChatBody(JSON.parse(body));
  const turns = buildUserTurns(trimHistoryForModel(validated.data.history), validated.data.message);
  const reply = await createSmartBriefReply({
    apiKey: "t",
    model: "m",
    history: trimHistoryForModel(validated.data.history),
    message: validated.data.message,
    briefState: null,
    callOpenAI: async function () {
      return {
        assistantMessage: "",
        phase: "clarify",
        done: false,
        briefCoverage: emptyCoverage(),
        nextInformationNeed: { focus: "audienceInput", reason: "bad" },
        clarifyFallbackMessage: AUDIENCE_FOCUS,
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      };
    }
  });
  assert("recovery reply not audience", reply.assistantMessage !== AUDIENCE_FOCUS);
  assert("recovery phase clarify", reply.phase === "clarify");
  assert(
    "recovery does not full-reask audience or journey",
    reply.assistantMessage !== AUDIENCE_FOCUS && reply.assistantMessage !== JOURNEY_FOCUS
  );
  void turns;
}

// ========== BF live retail — WHAT_MATTERS without WHO → WHO-only (HTTP) ==========
console.log("\n=== E2E retail bedding partial audience ===");
{
  const WHO_ONLY =
    "Кто чаще всего к вам обращается — какой это тип клиентов или гостей?";
  const U1 = "продажа постельного белья, реклама чтобы о нас больше людей узнало";
  const U2 = "продавец общается, качество, цена, ассортимент";
  const variants = [
    U2,
    "важны цена, качество и выбор",
    "смотрят на качество ткани, стоимость и ассортимент",
    "главное цена и чтобы был хороший выбор",
    "покупатели спрашивают про материал, цену и размеры"
  ];

  async function runPartialAudience(label, mattersText, withBriefState) {
    let history = [];
    let briefState = null;
    let sessionId = "bf-" + label;

    const mockU1 = async function () {
      return {
        assistantMessage: "",
        phase: "clarify",
        done: false,
        briefCoverage: Object.assign(emptyCoverage(), {
          business: field([src("u1", "продажа постельного белья", "what_business")]),
          goal: field([src("u1", "реклама чтобы о нас больше людей узнало", "desired_outcome")])
        }),
        nextInformationNeed: { focus: "audienceInput", reason: "need audience" },
        clarifyFallbackMessage: AUDIENCE_FOCUS,
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      };
    };

    const r1 = await httpChat({
      sessionId,
      message: U1,
      history,
      briefState,
      callOpenAI: mockU1
    });
    assert(label + " u1 http 200", r1.status === 200 && r1.payload.ok === true);
    // First user turn may be welcome; audience FOCUS is asked once continuum starts.
    assert(label + " u1 clarify", r1.payload.phase === "clarify");
    history = history.concat([
      { role: "user", content: U1 },
      { role: "assistant", content: r1.payload.assistantMessage }
    ]);
    if (withBriefState) briefState = r1.payload.briefState;
    else briefState = null;

    // If U1 was welcome, force an audience ask turn that mirrors live Mark.
    if (r1.payload.assistantMessage !== AUDIENCE_FOCUS) {
      const bridge = "Нужно, чтобы о магазине узнавало больше людей.";
      const mockBridge = async function () {
        return {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          briefCoverage: Object.assign(emptyCoverage(), {
            business: field([src("u1", "продажа постельного белья", "what_business")]),
            goal: field([
              src("u1", "реклама чтобы о нас больше людей узнало", "desired_outcome")
            ])
          }),
          nextInformationNeed: { focus: "audienceInput", reason: "need audience" },
          clarifyFallbackMessage: AUDIENCE_FOCUS,
          recommendationMode: "none",
          lowEngagement: false,
          expertPlan: null
        };
      };
      const rb = await httpChat({
        sessionId,
        message: bridge,
        history,
        briefState: withBriefState ? briefState : null,
        callOpenAI: mockBridge
      });
      assert(label + " bridge http 200", rb.status === 200 && rb.payload.ok === true);
      assert(label + " bridge audience ask", rb.payload.assistantMessage === AUDIENCE_FOCUS);
      history = history.concat([
        { role: "user", content: bridge },
        { role: "assistant", content: rb.payload.assistantMessage }
      ]);
      if (withBriefState) briefState = rb.payload.briefState;
    }

    // Model wrongly re-asks full audience — server must recover WHAT_MATTERS
    // and ask WHO only. When wiping briefState, model still re-sends prior
    // business/goal sources so audience remains the active MVB gap (as in live).
    const mockU2 = async function () {
      return {
        assistantMessage: "",
        phase: "clarify",
        done: false,
        briefCoverage: withBriefState
          ? emptyCoverage()
          : Object.assign(emptyCoverage(), {
              business: field([src("u1", "продажа постельного белья", "what_business")]),
              goal: field([
                src("u1", "реклама чтобы о нас больше людей узнало", "desired_outcome")
              ])
            }),
        nextInformationNeed: { focus: "audienceInput", reason: "full reask" },
        clarifyFallbackMessage: AUDIENCE_FOCUS,
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      };
    };

    const r2 = await httpChat({
      sessionId,
      message: mattersText,
      history,
      briefState: withBriefState ? briefState : null,
      callOpenAI: mockU2
    });
    assert(label + " u2 http 200", r2.status === 200 && r2.payload.ok === true);
    assert(label + " u2 not full audience", r2.payload.assistantMessage !== AUDIENCE_FOCUS);
    assert(label + " u2 WHO-only", r2.payload.assistantMessage === WHO_ONLY);
    assert(label + " u2 clarify", r2.payload.phase === "clarify");

    // Continuum: answer WHO → should leave audience (not re-ask matters)
    history = history.concat([
      { role: "user", content: mattersText },
      { role: "assistant", content: r2.payload.assistantMessage }
    ]);
    if (withBriefState) briefState = r2.payload.briefState;

    const whoAnswer = "чаще женщины 30–60 лет";
    const mockU3 = async function () {
      return {
        assistantMessage: "",
        phase: "clarify",
        done: false,
        briefCoverage: withBriefState
          ? emptyCoverage()
          : Object.assign(emptyCoverage(), {
              business: field([src("u1", "продажа постельного белья", "what_business")]),
              goal: field([
                src("u1", "реклама чтобы о нас больше людей узнало", "desired_outcome")
              ])
            }),
        nextInformationNeed: { focus: "audienceInput", reason: "should be closed" },
        clarifyFallbackMessage: AUDIENCE_FOCUS,
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      };
    };
    const r3 = await httpChat({
      sessionId,
      message: whoAnswer,
      history,
      briefState: withBriefState ? briefState : null,
      callOpenAI: mockU3
    });
    assert(label + " u3 http 200", r3.status === 200 && r3.payload.ok === true);
    assert(label + " u3 not full audience", r3.payload.assistantMessage !== AUDIENCE_FOCUS);
    assert(label + " u3 not WHO reask", r3.payload.assistantMessage !== WHO_ONLY);
    assert(
      label + " u3 not matters reask",
      r3.payload.assistantMessage !==
        "А что для этих людей обычно важнее всего при выборе?"
    );
  }

  await runPartialAudience("bedding-state", U2, true);
  await runPartialAudience("bedding-wipe", U2, false);

  for (let i = 1; i < variants.length; i += 1) {
    await runPartialAudience("bedding-v" + i, variants[i], false);
  }

  // Reverse: WHO first → WHAT_MATTERS-only
  {
    const MATTERS_ONLY = "А что для этих людей обычно важнее всего при выборе?";
    let history = [
      { role: "user", content: U1 },
      { role: "assistant", content: AUDIENCE_FOCUS }
    ];
    const r = await httpChat({
      sessionId: "bf-reverse",
      message: "чаще женщины 30–60 лет",
      history,
      briefState: null,
      callOpenAI: async function () {
        return {
          assistantMessage: "",
          phase: "clarify",
          done: false,
          briefCoverage: Object.assign(emptyCoverage(), {
            business: field([src("u1", "продажа постельного белья", "what_business")]),
            goal: field([
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
    assert("bedding-reverse http 200", r.status === 200 && r.payload.ok === true);
    assert("bedding-reverse not full", r.payload.assistantMessage !== AUDIENCE_FOCUS);
    assert("bedding-reverse matters-only", r.payload.assistantMessage === MATTERS_ONLY);
  }
}

if (failed) {
  console.error("\n" + failed + " mock-http-e2e failure(s)");
  process.exit(1);
}
console.log("\nAll mock HTTP E2E passed.");
