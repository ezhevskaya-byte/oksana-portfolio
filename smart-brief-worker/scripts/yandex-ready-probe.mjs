/**
 * One-shot Yandex READY-path probe against test Worker.
 * Classifies public outcome; does not print secrets.
 * Usage: node scripts/yandex-ready-probe.mjs
 */
const API =
  process.env.SMOKE_API_URL ||
  "https://smart-brief-api-test.ezhevskaya.workers.dev/api/chat";
const ORIGIN = process.env.SMOKE_ORIGIN || "http://localhost:5173";

const READY_FALLBACK_SNIP =
  "не удалось безопасно собрать рекомендацию";

const TURNS = [
  "Здравствуйте. Я частный преподаватель английского для взрослых. Сейчас почти все ученики приходят через сарафан и личные сообщения, и мне приходится каждому заново рассказывать про формат и цены. Хочу сайт, чтобы человек заранее понимал мой подход и мог оставить заявку.",
  "Чаще всего ко мне обращаются взрослые 25–45 лет, которые готовятся к переезду или работе. Им важно понять мой метод, формат занятий и примерно стоимость до первой переписки.",
  "Обычно человек пишет мне в WhatsApp или Instagram. Я выясняю цель и уровень, предлагаю формат занятий, обсуждаем расписание и оплату. Иногда предлагаю пробное занятие. Если всё подходит — договариваемся и начинаем работать.",
  "Сайта нет. Веду записи в Google Таблице, общаюсь в WhatsApp и Instagram. CRM и бота нет, всё вручную.",
  "Но хотелось бы, чтобы до переписки человек уже мог понять, кому и с какими задачами я помогаю, как проходят занятия, примерно сколько это стоит, получить ответы на основные вопросы и оставить заявку или выбрать время для пробного."
];

async function post(sessionId, message, history, briefState) {
  const t0 = Date.now();
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ sessionId, message, history, briefState })
  });
  const ms = Date.now() - t0;
  const payload = await res.json().catch(function () {
    return null;
  });
  return { res, payload, ms };
}

function classify(msg, phase) {
  const text = String(msg || "");
  if (text.indexOf(READY_FALLBACK_SNIP) !== -1) return "READY_FALLBACK";
  if (phase === "recommend" || phase === "handoff") return "MODEL_RECOMMEND";
  return "CLARIFY";
}

function signals(msg) {
  const t = String(msg || "").toLowerCase();
  return {
    insight: /главн|рычаг|суть|на самом деле|не просто сайт|ключев/.test(t),
    alternative: /альтернатив|вместо|можно сначала|мессенджер|бот|либо/.test(t),
    roadmap: /сейчас|сначала|позже|затем|не нужно|не строить|минимум|перв/.test(t),
    reuse: /таблиц|whatsapp|переисп|уже есть|подключ|существующ/.test(t)
  };
}

const sessionId = "probe-" + Date.now().toString(36);
let history = [];
let briefState = null;

for (let i = 0; i < TURNS.length; i += 1) {
  const { res, payload, ms } = await post(sessionId, TURNS[i], history, briefState);
  const msg = payload && payload.assistantMessage;
  const phase = payload && payload.phase;
  const kind = classify(msg, phase);
  const sig = signals(msg);
  console.log(
    "T" + (i + 1),
    "http=" + res.status,
    "ok=" + (payload && payload.ok),
    "err=" + (payload && payload.error),
    "phase=" + phase,
    "kind=" + kind,
    "ms=" + ms,
    "len=" + String(msg || "").length,
    "sig=" + JSON.stringify(sig)
  );
  console.log("  ", String(msg || "").slice(0, 160).replace(/\s+/g, " "));
  if (payload && Object.prototype.hasOwnProperty.call(payload, "briefState")) {
    briefState = payload.briefState;
  }
  history = history.concat([
    { role: "user", content: TURNS[i] },
    { role: "assistant", content: String(msg || "") }
  ]);
}
