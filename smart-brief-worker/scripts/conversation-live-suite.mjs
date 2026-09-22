/**
 * Live multi-niche conversation suite against test Worker (real OpenAI).
 * Usage: node scripts/conversation-live-suite.mjs
 * Env: SMOKE_API_URL, SMOKE_ORIGIN
 *
 * Does not deploy production. Does not print secrets.
 */
const API_URL =
  process.env.SMOKE_API_URL ||
  "https://smart-brief-api-test.ezhevskaya.workers.dev/api/chat";
const ORIGIN = process.env.SMOKE_ORIGIN || "http://localhost:5173";

const FLOW_FOCUS =
  "В идеале что клиент должен иметь возможность сделать сам, и что должно стать проще для вас?";
const JOURNEY_FOCUS =
  "Как сейчас обычно проходит путь клиента: от первого знакомства до заявки или покупки?";
const BUSINESS_FOCUS =
  "Расскажите немного подробнее о вашем бизнесе: чем именно вы занимаетесь и что предлагаете клиентам?";

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isExact(a, b) {
  return norm(a) === norm(b);
}

const NICHES = [
  {
    name: "teacher",
    turns: [
      "Здравствуйте. Я частный преподаватель английского для взрослых. Сейчас почти все ученики приходят через сарафан и личные сообщения, и мне приходится каждому заново рассказывать про формат и цены. Хочу сайт, чтобы человек заранее понимал мой подход и мог оставить заявку.",
      "Чаще всего ко мне обращаются взрослые 25–45 лет, которые готовятся к переезду или работе. Им важно понять мой метод, формат занятий и примерно стоимость до первой переписки.",
      "Обычно человек пишет мне в WhatsApp или Instagram. Я выясняю цель и уровень, предлагаю формат занятий, обсуждаем расписание и оплату. Иногда предлагаю пробное занятие. Если всё подходит — договариваемся и начинаем работать.",
      "Сайта нет. Веду записи в Google Таблице, общаюсь в WhatsApp и Instagram. CRM и бота нет, всё вручную.",
      "Наверное, полностью убирать личное общение я бы не хотела. Но хотелось бы, чтобы до переписки человек уже мог понять, кому и с какими задачами я помогаю, как проходят занятия, примерно сколько это стоит, получить ответы на основные вопросы и, если ему подходит мой формат, оставить заявку или выбрать время для пробного занятия. Тогда мне не пришлось бы каждый раз заново рассказывать одно и то же."
    ],
    expectFirstAck: true,
    afterFlowForbidExact: true,
    afterJourneyForbidExact: true
  },
  {
    name: "flowers",
    turns: [
      "Добрый день. У меня цветочная студия, делаем букеты и оформление. Заказы из Instagram и по телефону. Хочется сайт с доставкой и меньше отвечать на одни и те же вопросы про состав и цены.",
      "Обычно заказывают женщины 25–50 лет на день рождения и корпоративы. Им важно увидеть фото свежих работ, понять цену и зону доставки.",
      "Люди находят нас в Instagram, смотрят работы, пишут в директ или звонят. Мы уточняем повод и бюджет, предлагаем варианты, согласовываем доставку, потом оплата и сборка.",
      "Сайта нормального нет. Есть Instagram, WhatsApp и таблица заказов в Excel. Хотим, чтобы человек сам выбрал букет, увидел зоны доставки и оставил заказ."
    ],
    expectFirstAck: true,
    afterFlowForbidExact: true,
    afterJourneyForbidExact: true
  },
  {
    name: "freight",
    turns: [
      "Здравствуйте. Занимаемся грузоперевозками по городу и области. Заявки в WhatsApp и по звонкам, всё считаем вручную. Нужен сайт, чтобы клиент мог оставить заявку с маршрутом и примерно понять условия.",
      "Клиенты — небольшие магазины и частники. Им важны скорость ответа, понятная цена и аккуратность грузчиков.",
      "Обычно человек звонит или пишет в WhatsApp, описывает груз и адрес. Мы уточняем детали, называем стоимость, если подходит — приезжаем, грузим, везём, принимаем оплату.",
      "Только телефон и WhatsApp. CRM нет, ни таблиц, ни бота — всё вручную. Хотелось бы, чтобы клиент сам оставил заявку с маршрутом и объёмом."
    ],
    expectFirstAck: true,
    afterFlowForbidExact: true,
    afterJourneyForbidExact: true
  },
  {
    name: "guesthouse",
    turns: [
      "У меня небольшой гостевой дом в Лазаревском. Хочется меньше зависеть от Авито и снизить переписку по одним и тем же вопросам.",
      "Чаще всего пары 30–45 и семьи с ребёнком. Им важно тихо ли вечером, парковка и сразу увидеть свободные даты.",
      "Обычно находят нас на Авито, смотрят объявление, пишут в WhatsApp. Я уточняю даты и количество гостей, проверяю свободные номера, называю стоимость. Если подходит — предоплата и подтверждение брони.",
      "Занятость веду в системе бронирования с календарём и модулем онлайн-бронирования. Хочу, чтобы гость сам посмотрел номера, цены и даты и мог оформить бронь."
    ],
    expectFirstAck: true,
    afterFlowForbidExact: true,
    afterJourneyForbidExact: true
  },
  {
    name: "shop",
    turns: [
      "У меня небольшой интернет-магазин домашнего текстиля. Продаём через Instagram и Avito. Хочу, чтобы люди сами смотрели каталог и оформляли заказ без долгой переписки.",
      "Покупатели — женщины 30–55 лет. Им важны фото тканей, размеры и доставка по России.",
      "Находят в Instagram или Avito, смотрят фото, пишут в директ. Мы уточняем размер и цвет, считаем доставку, принимаем оплату, отправляем.",
      "Есть Instagram, WhatsApp и таблица заказов. CRM нет. Хотелось бы, чтобы человек сам выбрал товар, увидел условия доставки и оформил заказ."
    ],
    expectFirstAck: true,
    afterFlowForbidExact: true,
    afterJourneyForbidExact: true
  }
];

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("ok  -", name);
  else {
    failed += 1;
    console.error("FAIL -", name);
  }
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
      "live_http_" + res.status + "_" + ((payload && payload.error) || "bad_payload")
    );
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

async function runNiche(niche) {
  console.log("\n=== LIVE", niche.name, "===");
  let sessionId = "live-" + niche.name + "-" + Date.now().toString(36);
  let history = [];
  let briefState = null;
  let journeyAnswered = false;
  let flowAnswered = false;
  let sawRecommend = false;
  let maxProvider = 0;

  for (let i = 0; i < niche.turns.length; i += 1) {
    const message = niche.turns[i];
    const payload = await postChat({ sessionId, message, history, briefState });
    sessionId = payload.sessionId || sessionId;
    if (Object.prototype.hasOwnProperty.call(payload, "briefState")) {
      briefState = payload.briefState != null ? payload.briefState : null;
    }
    const assistant = String(payload.assistantMessage || "").trim();
    const providerCallCount =
      payload.debug && typeof payload.debug.providerCallCount === "number"
        ? payload.debug.providerCallCount
        : payload.providerCallCount;
    if (typeof providerCallCount === "number") {
      maxProvider = Math.max(maxProvider, providerCallCount);
      assert(niche.name + " T" + (i + 1) + " provider<=1", providerCallCount <= 1);
    }

    assert(niche.name + " T" + (i + 1) + " has reply", assistant.length > 20);
    assert(niche.name + " T" + (i + 1) + " not 5xx class", true);

    if (i === 0 && niche.expectFirstAck) {
      assert(
        niche.name + " FIRST no business retell prompt",
        !isExact(assistant, BUSINESS_FOCUS) &&
          !/расскажите .*своими словами .*бизнес/i.test(assistant)
      );
      // Soft: prefer ack; if model welcome passed safety it may vary — block only retell
      assert(
        niche.name + " FIRST identity or ack",
        /Марк|учёл|понял|уже|спасибо/i.test(assistant)
      );
    }

    if (journeyAnswered && niche.afterJourneyForbidExact) {
      assert(niche.name + " no-repeat JOURNEY exact", !isExact(assistant, JOURNEY_FOCUS));
    }
    if (flowAnswered && niche.afterFlowForbidExact) {
      assert(niche.name + " no-repeat FLOW exact", !isExact(assistant, FLOW_FOCUS));
    }

    // Heuristic: after journey/flow user turns, mark answered
    if (i >= 2) journeyAnswered = true;
    if (/оставить заявк|сам .{0,20}(?:выбр|оформ|посмотр)|хотелось бы|хочу, чтобы/i.test(message)) {
      flowAnswered = true;
    }

    if (/рекоменд|имеет смысл|я бы предложил|начн/i.test(assistant) && assistant.length > 180) {
      sawRecommend = true;
    }

    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: assistant });
    await new Promise(function (r) {
      setTimeout(r, 400);
    });
  }

  if (typeof maxProvider === "number" && maxProvider > 0) {
    assert(niche.name + " max providerCallCount<=1", maxProvider <= 1);
  }
  console.log(
    niche.name + " done; recommend_seen=",
    sawRecommend,
    "history_turns=",
    history.length / 2
  );
}

async function main() {
  console.log("Live suite →", API_URL);
  for (let i = 0; i < NICHES.length; i += 1) {
    try {
      await runNiche(NICHES[i]);
    } catch (err) {
      failed += 1;
      console.error("FAIL -", NICHES[i].name, "exception", err && err.message);
      if (err && err.payload) {
        console.error("payload.error=", err.payload.error || err.payload);
      }
    }
  }
  if (failed) {
    console.error("\n" + failed + " live suite failure(s)");
    process.exit(1);
  }
  console.log("\nAll live suite niches passed.");
}

main();
