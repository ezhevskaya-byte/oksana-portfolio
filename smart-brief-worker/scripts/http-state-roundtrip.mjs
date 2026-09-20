/**
 * L3/L4: JSON wire + validateChatBody + multi-turn briefState continuity (no OpenAI).
 * Run: node scripts/http-state-roundtrip.mjs
 */
import {
  mergeBriefCoverage,
  buildUserTurns,
  evaluateBriefReady,
  resolveServerFocus,
  selectClarifyMessage
} from "../src/gate.js";
import { validateChatBody, trimHistoryForModel } from "../src/validate.js";

const AUDIENCE_FOCUS =
  "Кто чаще всего к вам обращается, и что этим людям обычно важно при выборе?";

const LIVE = {
  u1: "Здравствуйте. У меня небольшой гостевой дом, и я думаю, что мне нужен сайт.",
  u2: "Сейчас основные бронирования приходят через Авито. Иногда люди пишут в WhatsApp или звонят. Своего сайта нет. Хочется меньше зависеть от Авито и чтобы мне не приходилось каждому гостю заново отвечать на одни и те же вопросы.",
  u3: "Чаще всего у нас отдыхают пары примерно 30–50 лет и семьи с детьми. Обычно им важно, чтобы было спокойно, чисто, недалеко от моря и чтобы заранее было понятно, какой номер они бронируют и сколько будет стоить проживание. Многие перед бронированием спрашивают про бассейн, условия для детей и что есть в номере.",
  u4: "Обычно впервые находят нас на Авито. Смотрят объявление, фотографии и описание, потом пишут там же или переходят в WhatsApp, иногда звонят. Я отвечаю на вопросы, уточняю даты и количество гостей, проверяю свободные номера, называю стоимость. Если всё подходит, гость переводит предоплату, и я подтверждаю бронь. Больше всего вопросов возникает до бронирования, когда человек сравнивает варианты и хочет понять, подходит ли ему наш гостевой дом.",
  u5: "Занятость веду в системе бронирования. Там есть календарь, цены и готовый модуль онлайн-бронирования, который можно подключить к сайту. Через него гость может сам посмотреть свободные номера и оформить бронь. Для общения использую WhatsApp и телефон. CRM нет, отдельного бота тоже нет."
};

function empty() {
  return {
    business: { sources: [] },
    goal: { sources: [] },
    audienceInput: { sources: [] },
    customerJourney: { sources: [] },
    friction: { sources: [] },
    existingTools: { sources: [] },
    desiredFlow: { sources: [] }
  };
}

function src(turnId, quote, aspect) {
  return { turnId, quote, aspect, operation: "support" };
}

/** Client-like: server briefState → JSON → session → next validated request */
function clientNext(prevBriefState, history, message) {
  const response = JSON.parse(
    JSON.stringify({ ok: true, briefState: prevBriefState, assistantMessage: "ok" })
  );
  const session = JSON.stringify({
    briefState: response.briefState,
    history
  });
  const restored = JSON.parse(session);
  const body = JSON.stringify({
    sessionId: "http-rt",
    message,
    history: restored.history,
    briefState: restored.briefState
  });
  return validateChatBody(JSON.parse(body));
}

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("ok  -", name);
  else {
    failed += 1;
    console.error("FAIL -", name);
  }
}

// Simulate U1–U4 with empty model audience on U4 (live failure mode) + wire continuum
let history = [];
let briefState = null;

// U1
{
  const v = clientNext(briefState, history, LIVE.u1);
  const turns = buildUserTurns(trimHistoryForModel(v.data.history), v.data.message);
  const m = mergeBriefCoverage(
    v.data.briefState,
    Object.assign(empty(), {
      business: { sources: [src("u1", "небольшой гостевой дом", "what_business")] },
      goal: { sources: [src("u1", "мне нужен сайт", "desired_outcome")] }
    }),
    turns
  );
  briefState = m.briefState;
  history = history.concat([
    { role: "user", content: LIVE.u1 },
    { role: "assistant", content: "welcome" }
  ]);
}

// U2
{
  const v = clientNext(briefState, history, LIVE.u2);
  const turns = buildUserTurns(trimHistoryForModel(v.data.history), v.data.message);
  const m = mergeBriefCoverage(
    v.data.briefState,
    Object.assign(empty(), {
      goal: { sources: [src("u2", "Хочется меньше зависеть от Авито", "desired_outcome")] },
      friction: {
        sources: [
          src(
            "u2",
            "не приходилось каждому гостю заново отвечать на одни и те же вопросы",
            "pain"
          )
        ]
      }
    }),
    turns
  );
  briefState = m.briefState;
  history = history.concat([
    { role: "user", content: LIVE.u2 },
    { role: "assistant", content: AUDIENCE_FOCUS }
  ]);
}

// U3 — model cites audience
{
  const v = clientNext(briefState, history, LIVE.u3);
  const turns = buildUserTurns(trimHistoryForModel(v.data.history), v.data.message);
  const who =
    "Чаще всего у нас отдыхают пары примерно 30–50 лет и семьи с детьми.";
  const matters =
    "Обычно им важно, чтобы было спокойно, чисто, недалеко от моря и чтобы заранее было понятно, какой номер они бронируют и сколько будет стоить проживание.";
  const m = mergeBriefCoverage(
    v.data.briefState,
    Object.assign(empty(), {
      audienceInput: {
        sources: [
          src("u3", who, "who_or_segment"),
          src("u3", matters, "what_matters")
        ]
      }
    }),
    turns
  );
  const r = evaluateBriefReady(m.coverage, turns);
  assert("U3 audience known", m.coverage.audienceInput.status === "known");
  assert(
    "U3 focus journey",
    resolveServerFocus(r.missing, m.coverage, turns) === "customerJourney"
  );
  briefState = m.briefState;
  history = history.concat([
    { role: "user", content: LIVE.u3 },
    {
      role: "assistant",
      content:
        "Как сейчас обычно проходит путь клиента: от первого знакомства до заявки или покупки?"
    }
  ]);
}

// U4 — model emits NO audience (live variance) + journey
{
  const v = clientNext(briefState, history, LIVE.u4);
  assert("U4 briefState present", v.data.briefState != null);
  const turns = buildUserTurns(trimHistoryForModel(v.data.history), v.data.message);
  const m = mergeBriefCoverage(
    v.data.briefState,
    Object.assign(empty(), {
      customerJourney: { sources: [src("u4", LIVE.u4, "path_steps")] }
    }),
    turns
  );
  const r = evaluateBriefReady(m.coverage, turns);
  const focus = resolveServerFocus(r.missing, m.coverage, turns);
  const msg = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "audienceInput", reason: "bad" },
      clarifyFallbackMessage: AUDIENCE_FOCUS
    },
    r.missing,
    m.coverage,
    turns
  );
  assert("U4 audience known", m.coverage.audienceInput.status === "known");
  assert("U4 journey known", m.coverage.customerJourney.status === "known");
  assert("U4 focus not audience", focus !== "audienceInput");
  assert("U4 focus tools", focus === "existingTools");
  assert("U4 no audience re-ask", msg !== AUDIENCE_FOCUS);
  briefState = m.briefState;
  history = history.concat([
    { role: "user", content: LIVE.u4 },
    { role: "assistant", content: msg }
  ]);
}

// U4b — even if briefState wiped, recovery from history must block audience re-ask
{
  const v = clientNext(null, history, LIVE.u5);
  const turns = buildUserTurns(trimHistoryForModel(v.data.history), LIVE.u4);
  // Use U4 as message with wiped state and journey-only model — audience must recover
  const turnsU4 = buildUserTurns(
    [
      { role: "user", content: LIVE.u1 },
      { role: "assistant", content: "w" },
      { role: "user", content: LIVE.u2 },
      { role: "assistant", content: "a" },
      { role: "user", content: LIVE.u3 },
      { role: "assistant", content: "j" }
    ],
    LIVE.u4
  );
  const m = mergeBriefCoverage(
    null,
    Object.assign(empty(), {
      customerJourney: { sources: [src("u4", LIVE.u4, "path_steps")] }
    }),
    turnsU4
  );
  const r = evaluateBriefReady(m.coverage, turnsU4);
  assert("wiped-state audience recovered", m.coverage.audienceInput.status === "known");
  assert(
    "wiped-state focus not audience",
    resolveServerFocus(r.missing, m.coverage, turnsU4) !== "audienceInput"
  );
  void v;
  void turns;
}

if (failed) {
  console.error("\n" + failed + " http-state-roundtrip failure(s)");
  process.exit(1);
}
console.log("\nHTTP state round-trip passed.");
