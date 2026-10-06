/**
 * Live smoke: textile recommendation grounding + rejection replanning on TEST.
 * Usage: node scripts/_live-textile-recommend-smoke.mjs
 */
const API =
  process.env.SMOKE_API_URL ||
  "https://smart-brief-api-test.ezhevskaya.workers.dev/api/chat";
const ORIGIN = process.env.SMOKE_ORIGIN || "http://localhost:5173";

const TURNS = [
  "У меня небольшой магазин домашнего текстиля: постельное бельё, полотенца, одеяла, подушки, халаты и пледы. Магазин работает офлайн, есть группа ВКонтакте и Telegram. Покупатели в основном женщины, примерно 90%. Хотелось бы увеличить продажи и привлечь новых клиентов.",
  "Чаще всего для них важны качество, цена и чтобы можно было спокойно выбрать всё в одном месте. Ещё многие ценят, когда можно посмотреть товар вживую и получить нормальную консультацию.",
  "Больше всего времени уходит на консультации в магазине. Люди часто долго выбирают, спрашивают про размеры, состав и отличия товаров, а иногда уходят подумать и не возвращаются.",
  "Заказы отдельно нигде не ведём. В основном всё вручную: человек приходит в магазин или пишет в ВКонтакте/Telegram, продавец отвечает, помогает выбрать и оформляет заказ. Отдельной CRM и бота нет.",
  "Хочу, чтобы человек мог заранее посмотреть товары, цены и основные характеристики, понять, что ему подходит, при необходимости получить помощь с выбором, а потом быстро оформить заказ или прийти в магазин уже понимая, что хочет купить.",
  "Онлайн-оплата пока не нужна. Мне достаточно, чтобы человек оставил заявку или связался с магазином, а дальше продавец уже поможет оформить покупку."
];

const REJECT =
  "У меня нет проблемы с очередью или хаосом заявок. Главная проблема в другом: продавцы тратят много времени на повторяющиеся консультации, а часть заинтересованных покупателей не возвращается после того, как ушла подумать.";

function badQueueClaim(text) {
  const t = String(text || "").toLowerCase();
  return (
    /хаос\s+заявк/.test(t) ||
    /главная\s+боль.{0,40}очеред/.test(t) ||
    /вместо\s+блокнота/.test(t) ||
    /контур\s+при[её]ма\s+заявк.{0,40}очеред/.test(t)
  );
}

async function chat(sessionId, message, history, briefState) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ sessionId, message, history, briefState })
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload || payload.ok !== true) {
        throw new Error("http_" + res.status + "_" + ((payload && payload.error) || "bad"));
      }
      return payload;
    } catch (err) {
      lastErr = err;
      console.error("retry", attempt, String(err && err.message || err));
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr || new Error("chat_failed");
}

async function main() {
  let sessionId = "textile-smoke-" + Date.now().toString(36);
  let history = [];
  let briefState = null;
  let recommendMsg = "";
  let failed = 0;

  console.log("TEST API:", API);
  for (let i = 0; i < TURNS.length; i += 1) {
    const p = await chat(sessionId, TURNS[i], history, briefState);
    sessionId = p.sessionId || sessionId;
    briefState = Object.prototype.hasOwnProperty.call(p, "briefState") ? p.briefState : briefState;
    const msg = String(p.assistantMessage || "");
    console.log("\nU" + (i + 1), "phase=" + p.phase);
    console.log(msg.slice(0, 280));
    if (p.phase === "recommend") {
      recommendMsg = msg;
      if (badQueueClaim(msg)) {
        console.error("FAIL - invented queue/chaos on first recommend");
        failed += 1;
      } else {
        console.log("ok  - first recommend grounded (no queue/chaos invent)");
      }
    }
    history = history.concat([
      { role: "user", content: TURNS[i] },
      { role: "assistant", content: msg }
    ]);
  }

  if (!recommendMsg) {
    // Force one more turn if still clarifying (payment already given).
    console.log("\n(no recommend yet — checking last phase)");
  }

  // If model invented queue earlier somehow, or after recommend — send rejection.
  const rejectPayload = await chat(sessionId, REJECT, history, briefState);
  const after = String(rejectPayload.assistantMessage || "");
  console.log("\nREJECT phase=" + rejectPayload.phase);
  console.log(after.slice(0, 320));

  if (badQueueClaim(after)) {
    console.error("FAIL - queue/chaos repeated after rejection");
    failed += 1;
  } else {
    console.log("ok  - no queue/chaos after rejection");
  }

  if (
    recommendMsg &&
    badQueueClaim(recommendMsg) === false &&
    /каталог|витрин|характеристик|консультац|товар/i.test(recommendMsg + " " + after)
  ) {
    console.log("ok  - retail-aligned wording present");
  } else if (/каталог|витрин|характеристик|консультац/i.test(after)) {
    console.log("ok  - replan after reject uses catalog/consult framing");
  }

  if (failed) {
    console.error("\nlive textile smoke FAILED:", failed);
    process.exit(1);
  }
  console.log("\nlive textile smoke PASSED");
  console.log("version endpoint note: check wrangler deploy output");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
