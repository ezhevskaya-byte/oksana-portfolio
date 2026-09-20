/**
 * L5 smoke against deployed test Worker (real OpenAI).
 * Usage:
 *   node scripts/conversation-smoke.mjs
 * Env:
 *   SMOKE_API_URL (default test Worker /api/chat)
 *   SMOKE_ORIGIN (default http://localhost:5173)
 *
 * Does not print secrets. Fails if audience FOCUS reappears after U3 answer.
 */
const API_URL =
  process.env.SMOKE_API_URL ||
  "https://smart-brief-api-test.ezhevskaya.workers.dev/api/chat";
const ORIGIN = process.env.SMOKE_ORIGIN || "http://localhost:5173";

const AUDIENCE_FOCUS =
  "Кто чаще всего к вам обращается, и что этим людям обычно важно при выборе?";

const SCENARIOS = {
  guesthouse: {
    name: "guesthouse",
    turns: [
      "Здравствуйте. У меня небольшой гостевой дом, и я думаю, что мне нужен сайт.",
      "Сейчас основные бронирования приходят через Авито. Иногда люди пишут в WhatsApp или звонят. Своего сайта нет. Хочется меньше зависеть от Авито и чтобы мне не приходилось каждому гостю заново отвечать на одни и те же вопросы.",
      "Чаще всего у нас отдыхают пары примерно 30–50 лет и семьи с детьми. Обычно им важно, чтобы было спокойно, чисто, недалеко от моря и чтобы заранее было понятно, какой номер они бронируют и сколько будет стоить проживание. Многие перед бронированием спрашивают про бассейн, условия для детей и что есть в номере.",
      "Обычно впервые находят нас на Авито. Смотрят объявление, фотографии и описание, потом пишут там же или переходят в WhatsApp, иногда звонят. Я отвечаю на вопросы, уточняю даты и количество гостей, проверяю свободные номера, называю стоимость. Если всё подходит, гость переводит предоплату, и я подтверждаю бронь. Больше всего вопросов возникает до бронирования, когда человек сравнивает варианты и хочет понять, подходит ли ему наш гостевой дом.",
      "Занятость веду в системе бронирования. Там есть календарь, цены и готовый модуль онлайн-бронирования, который можно подключить к сайту. Через него гость может сам посмотреть свободные номера и оформить бронь. Для общения использую WhatsApp и телефон. CRM нет, отдельного бота тоже нет."
    ],
    afterU3ForbidAudience: true,
    expectReuseHints: [/модул|календар|бронир|интегр|подключ/i]
  },
  service: {
    name: "service",
    turns: [
      "Здравствуйте. Я делаю внедрение CRM для небольших клиник и хочу сайт.",
      "Сейчас заявки приходят из сарафанного радио и иногда из Instagram. Хочется больше прямых обращений и меньше объяснять одно и то же.",
      "Чаще всего к нам обращаются клиенты — владельцы небольших клиник. Обычно им важно быстро понять стоимость и сроки внедрения.",
      "Обычно находят через рекомендацию, смотрят мой профиль, пишут в WhatsApp, я уточняю задачу и называю стоимость, потом согласуем старт.",
      "Из инструментов: WhatsApp, Google Таблицы для задач, отдельной CRM для себя нет. Хочу, чтобы клиент сам оставлял заявку и видел базовые пакеты."
    ],
    afterU3ForbidAudience: true
  }
};

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isAudienceReask(text) {
  const t = norm(text);
  if (t === norm(AUDIENCE_FOCUS)) return true;
  // Semantic paraphrase net (secondary): both who + what-matters ask in one question
  const asksWho = /кто (чаще|обычно)|как(ие|ой) (люди|клиент|гост)|целевая аудитория|кто к вам обращается/.test(
    t
  );
  const asksMatters = /что .{0,40}важно|при выборе|какие критери/.test(t);
  return asksWho && asksMatters;
}

async function postChat({ sessionId, message, history, briefState }) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN
    },
    body: JSON.stringify({ sessionId, message, history, briefState })
  });
  const payload = await res.json().catch(function () {
    return null;
  });
  if (!res.ok || !payload || payload.ok !== true) {
    const err = new Error(
      "smoke_http_" + res.status + "_" + ((payload && payload.error) || "bad_payload")
    );
    err.payload = payload;
    throw err;
  }
  return payload;
}

async function runScenario(scenario) {
  console.log("\n=== SMOKE", scenario.name, "===");
  let sessionId = "smoke-" + scenario.name + "-" + Date.now().toString(36);
  let history = [];
  let briefState = null;
  const transcript = [];
  let audienceAnsweredAt = -1;

  for (let i = 0; i < scenario.turns.length; i += 1) {
    const message = scenario.turns[i];
    const payload = await postChat({ sessionId, message, history, briefState });
    sessionId = payload.sessionId || sessionId;
    if (Object.prototype.hasOwnProperty.call(payload, "briefState")) {
      briefState = payload.briefState != null ? payload.briefState : null;
    }
    const assistant = String(payload.assistantMessage || "").trim();
    transcript.push({ u: i + 1, phase: payload.phase, assistant: assistant.slice(0, 180) });

    if (i === 2) audienceAnsweredAt = 2; // after sending U3, next replies must not full-reask

    if (scenario.afterU3ForbidAudience && i >= 3) {
      if (isAudienceReask(assistant)) {
        console.error("FAIL - audience re-ask at turn", i + 1, assistant.slice(0, 120));
        return { ok: false, transcript };
      }
    }

    // After U3 response (index 2 reply is after U3): mark
    if (i === 2 && isAudienceReask(assistant)) {
      // Asking audience again immediately after answer is also forbidden
      console.error("FAIL - audience re-ask immediately after U3");
      return { ok: false, transcript };
    }

    history = history.concat([
      { role: "user", content: message },
      { role: "assistant", content: assistant }
    ]);

    console.log(
      "u" + (i + 1),
      "phase=" + payload.phase,
      "briefState=" + (briefState ? "yes" : "no"),
      "msg=",
      assistant.slice(0, 90).replace(/\s+/g, " ")
    );
  }

  const last = transcript[transcript.length - 1];
  if (scenario.expectReuseHints && last && last.phase === "recommend") {
    const okReuse = scenario.expectReuseHints.some(function (re) {
      return re.test(last.assistant);
    });
    if (!okReuse) {
      console.warn("WARN - recommend without obvious reuse wording (non-fatal for smoke)");
    }
  }

  void audienceAnsweredAt;
  console.log("PASS -", scenario.name);
  return { ok: true, transcript };
}

async function main() {
  console.log("SMOKE_API_URL=", API_URL);
  const results = [];
  const names = process.argv.slice(2);
  const list =
    names.length > 0
      ? names.map(function (n) {
          return SCENARIOS[n];
        }).filter(Boolean)
      : [SCENARIOS.guesthouse, SCENARIOS.service];

  for (let i = 0; i < list.length; i += 1) {
    try {
      results.push(await runScenario(list[i]));
    } catch (err) {
      console.error("FAIL -", list[i].name, err.message);
      results.push({ ok: false, error: err.message });
    }
  }

  const failed = results.filter(function (r) {
    return !r.ok;
  }).length;
  if (failed) {
    console.error("\nSmoke failed:", failed);
    process.exit(1);
  }
  console.log("\nAll smoke scenarios passed.");
}

main();
