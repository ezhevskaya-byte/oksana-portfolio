/**
 * Live smoke: bike-repair info-first → booking on TEST.
 * Usage: node scripts/_live-bike-recommend-smoke.mjs
 */
const API =
  process.env.SMOKE_API_URL ||
  "https://smart-brief-api-test.ezhevskaya.workers.dev/api/chat";
const ORIGIN = process.env.SMOKE_ORIGIN || "http://localhost:5173";

const TURNS = [
  "У меня небольшой сервис по ремонту велосипедов. Клиенты обычно пишут или звонят, чтобы узнать стоимость ремонта и можно ли привезти велосипед. Сейчас всё принимаем вручную, отдельной системы учёта нет. Больше всего времени уходит на одинаковые вопросы о стоимости и сроках, а иногда человек после разговора пропадает.",
  "Хочу, чтобы люди могли заранее узнать стоимость и сроки ремонта, понять, что им подходит, и быстрее записываться на ремонт. И хотелось бы меньше тратить времени на одинаковые вопросы.",
  "В основном это обычные городские велосипедисты: люди, которые ездят на велосипеде для прогулок, по делам и иногда на работу.",
  "Почти всё вручную. Есть только телефон и переписка, отдельной CRM, календаря или системы заявок нет.",
  "Хочу, чтобы человек мог сам посмотреть основные цены и сроки ремонта, понять, что ему подходит, а если нужны уточнения — быстро задать вопрос. После этого он должен иметь возможность оставить заявку на ремонт, а продавец уже связаться с ним и согласовать детали.",
  "Сразу следующий шаг: человек должен иметь возможность записаться на ремонт, но окончательные детали продавец согласует с ним после обращения."
];

const REJECT =
  "У меня нет проблемы с очередью или хаосом заявок. Главная проблема — повторяющиеся вопросы о стоимости и сроках, и часть людей пропадает после разговора.";

const RAW_U1 =
  /у меня небольшой сервис по ремонту велосипедов\. клиенты обычно пишут/i;

function badQueueOrCrm(text) {
  const t = String(text || "").toLowerCase();
  return (
    /хаос\s+заявк/.test(t) ||
    /главная\s+боль.{0,40}очеред/.test(t) ||
    /вместо\s+блокнота/.test(t) ||
    /контур\s+при[её]ма\s+заявк.{0,40}очеред/.test(t) ||
    /полноценн\w*\s+crm/.test(t) ||
    /упорядочить\s+запись\s+и\s+заявки/.test(t) ||
    /минимальный\s+контур/.test(t) ||
    /автоответы\s+и\s+напоминания\s+по\s+мере\s+необходимости/.test(t)
  );
}

function infoFirstOk(text) {
  const t = String(text || "").toLowerCase();
  return (
    (/цен|стоим|срок|прайс|информац/.test(t) || /повтор|одинаков|вопрос/.test(t)) &&
    (/заявк|запис|страниц|мини-сервис|витрин/.test(t) || /соглас/.test(t))
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
      console.error("retry", attempt, String((err && err.message) || err));
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr || new Error("chat_failed");
}

async function main() {
  let sessionId = "bike-smoke-" + Date.now().toString(36);
  let history = [];
  let briefState = null;
  let recommendMsg = "";
  let failed = 0;
  let sawPaymentAsk = false;

  console.log("TEST API:", API);
  for (let i = 0; i < TURNS.length; i += 1) {
    const p = await chat(sessionId, TURNS[i], history, briefState);
    sessionId = p.sessionId || sessionId;
    briefState = Object.prototype.hasOwnProperty.call(p, "briefState") ? p.briefState : briefState;
    const msg = String(p.assistantMessage || "");
    console.log("\nU" + (i + 1), "phase=" + p.phase);
    console.log(msg.slice(0, 360));

    if (/онлайн-?оплат/i.test(msg) && p.phase !== "recommend") {
      sawPaymentAsk = true;
      console.error("note - payment question asked before recommend");
    }

    if (p.phase === "recommend") {
      recommendMsg = msg;
      if (badQueueOrCrm(msg)) {
        console.error("FAIL - queue/chaos/CRM/DEFAULT on recommend");
        failed += 1;
      } else {
        console.log("ok  - no queue/chaos/CRM/DEFAULT");
      }
      if (RAW_U1.test(msg)) {
        console.error("FAIL - raw USER_TURN in recommend");
        failed += 1;
      } else {
        console.log("ok  - no raw opening USER_TURN");
      }
      if (infoFirstOk(msg)) {
        console.log("ok  - info-first + booking framing");
      } else {
        console.error("FAIL - missing info-first/booking framing");
        failed += 1;
      }
      if (/пропал|не возвращ|после разговор|повтор|одинаков|стоим|срок/i.test(msg)) {
        console.log("ok  - pain (repeat FAQ / lost-after-contact) reflected");
      } else {
        console.error("FAIL - pain not reflected");
        failed += 1;
      }
    }

    history = history.concat([
      { role: "user", content: TURNS[i] },
      { role: "assistant", content: msg }
    ]);
  }

  if (!recommendMsg) {
    console.error("FAIL - never reached recommend");
    failed += 1;
  }

  if (sawPaymentAsk && !recommendMsg) {
    console.error("FAIL - stuck on payment question");
    failed += 1;
  } else if (!sawPaymentAsk) {
    console.log("ok  - no forced payment question");
  } else {
    console.log("ok  - recommend reached despite earlier payment ask");
  }

  const rejectPayload = await chat(sessionId, REJECT, history, briefState);
  const after = String(rejectPayload.assistantMessage || "");
  console.log("\nREJECT phase=" + rejectPayload.phase);
  console.log(after.slice(0, 360));

  if (badQueueOrCrm(after)) {
    console.error("FAIL - rejected queue/chaos returned");
    failed += 1;
  } else {
    console.log("ok  - rejected hypothesis not reused");
  }
  if (RAW_U1.test(after)) {
    console.error("FAIL - raw USER_TURN after reject");
    failed += 1;
  }

  if (failed) {
    console.error("\nlive bike smoke FAILED:", failed);
    process.exit(1);
  }
  console.log("\nlive bike smoke PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
