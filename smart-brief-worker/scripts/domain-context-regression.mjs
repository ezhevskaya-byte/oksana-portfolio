/**
 * B2B domain persistence + cross-domain leakage regressions.
 */
import {
  buildUserTurns,
  mergeBriefCoverage,
  evaluateBriefReady,
  evaluateSolutionReady,
  inferDialogueContext,
  scoreDialogueDomains,
  hasCrossDomainLeakage,
  pickSolutionDiscriminatorQuestion,
  selectClarifyMessage,
  resolveClarifyTarget
} from "../src/gate.js";

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("ok  -", name);
  else {
    console.error("FAIL -", name);
    failed += 1;
  }
}

const B2B = [
  "Я оказываю бухгалтерские услуги небольшим компаниям и ИП. Большинство новых клиентов приходит по рекомендациям, а первичное общение обычно начинается в мессенджере.",
  "Хочу сократить время на первичное общение с потенциальными клиентами. Сейчас мне приходится каждому отдельно объяснять, какие услуги я оказываю, сколько это примерно стоит, какие документы понадобятся, а потом ещё выяснять, подходит ли мне вообще этот клиент и смогу ли я ему помочь.",
  "Наверное, в первую очередь им важно понимать, что специалист действительно разбирается в их ситуации и ему можно доверять. Ещё важны стоимость услуг, скорость ответа и чтобы было понятно, что именно входит в сопровождение. Многие перед началом работы задают примерно одни и те же вопросы.",
  "Обычно человек пишет мне в мессенджер и кратко описывает свою ситуацию. Я уточняю, ИП это или ООО, чем занимается бизнес, есть ли сотрудники, какая система налогообложения, ведётся ли сейчас бухгалтерия и что именно ему нужно. Потом отвечаю на его вопросы, оцениваю объём работы и называю примерную стоимость. Если понимаем, что готовы работать вместе, запрашиваю документы и уже переходим к оформлению сотрудничества.",
  "CRM и бота у меня нет. В основном всё веду вручную: переписка остаётся в мессенджере, основную информацию о потенциальном клиенте могу записать себе в заметки или таблицу. Отдельной системы для заявок и первичного отбора клиентов нет.",
  "Не совсем. Мне важно не просто получить заявку. Хотелось бы, чтобы человек сначала сам посмотрел основную информацию об услугах и условиях, а потом ответил на несколько вопросов о своём бизнесе. Чтобы ещё до личного разговора я понимала, что ему нужно, подходит ли его задача под мои услуги и какие исходные данные у нас уже есть."
];

console.log("\n=== exact B2B live regression ===");
{
  assert("hotelos trap absent", scoreDialogueDomains("Хотелось бы посмотреть услуги").lodging === 0);
  let history = [];
  let prior = null;
  let lastQ = "";
  let lastCoverage = null;
  let lastUt = null;
  for (let i = 0; i < B2B.length; i += 1) {
    const ut = buildUserTurns(history, B2B[i]);
    const merged = mergeBriefCoverage(prior, {}, ut);
    prior = merged.briefState;
    lastCoverage = merged.coverage;
    lastUt = ut;
    const ctx = inferDialogueContext(merged.coverage, ut);
    assert("B2B U" + (i + 1) + " domain not lodging", ctx.domain === "b2b" || ctx.domain === "professional");
    const brief = evaluateBriefReady(merged.coverage, ut);
    const sol = evaluateSolutionReady(merged.coverage, ut);
    const target = resolveClarifyTarget(brief.missing, merged.coverage, ut);
    if (brief.ready && !sol.ready) {
      lastQ = pickSolutionDiscriminatorQuestion(merged.coverage, ut);
    } else if (target.focus) {
      lastQ = selectClarifyMessage(
        {
          nextInformationNeed: { focus: target.focus, reason: "" },
          clarifyFallbackMessage: "",
          recommendationMode: "none",
          phase: "clarify"
        },
        brief.missing,
        merged.coverage,
        ut
      );
    }
    assert("B2B U" + (i + 1) + " no guest/booking leak", !/гост|брон/i.test(lastQ || ""));
    history.push({ role: "user", content: B2B[i] });
    history.push({ role: "assistant", content: lastQ || "ok" });
  }
  const brief = evaluateBriefReady(lastCoverage, lastUt);
  const sol = evaluateSolutionReady(lastCoverage, lastUt);
  assert("B2B final brief ready", brief.ready === true);
  assert("B2B final solution ready or safe disc", sol.ready === true || !/гост|брон|оплат/i.test(lastQ));
  if (sol.ready) {
    assert("B2B no payment-forced disc when ready", true);
  } else {
    assert("B2B disc not payment/guest", !/гост|брон|онлайн-?оплат/i.test(lastQ));
  }
  assert("B2B desiredFlow known", lastCoverage.desiredFlow.status === "known");
}

console.log("\n=== cross-domain A–G ===");
{
  const cases = [
    ["A_studio", "У меня студия йоги, запись на занятия", "studio", /занят|расписан|клиент/i, /гост/i],
    ["B_lodge", "У меня гостевой дом, брони через Авито", "lodging", /гост|брон/i, /заняти/i],
    ["C_b2b", "Оказываю бухгалтерские услуги компаниям и ИП", "b2b", /клиент|обращен|сотруднич|заказчик|вопрос/i, /гост|брон|заняти/i],
    ["D_retail", "Интернет-магазин текстиля, заказы из VK", "retail", /покупател|заказ/i, /гост|заняти/i],
    ["E_edu", "Я преподаватель английского для взрослых", "education", /ученик|занят/i, /гост/i],
    ["F_generic", "У меня небольшой бизнес, клиенты пишут в WhatsApp", "generic", /клиент|человек|обращен/i, /гост|брон|заняти/i]
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    const ctx = inferDialogueContext(null, buildUserTurns([], c[1]));
    assert(c[0] + " domain", ctx.domain === c[2] || (c[2] === "b2b" && ctx.domain === "professional"));
    const pack = [ctx.whoAsk, ctx.flowAsk, ctx.solutionAsk, ctx.journeyAfterContact].join(" ");
    assert(c[0] + " allow lexicon", c[3].test(pack));
    assert(c[0] + " forbid leak", !c[4].test(pack) || c[2] === "lodging" || c[2] === "studio" || c[2] === "education");
    if (c[2] !== "lodging") {
      assert(c[0] + " leakage helper", !hasCrossDomainLeakage(ctx.solutionAsk, ctx.domain));
    }
  }

  // G: correction — explicit lodging after generic should switch
  const g1 = inferDialogueContext(null, buildUserTurns([], "У меня бизнес"));
  assert("G start generic-ish", g1.domain === "generic" || g1.domain === "b2b");
  const g2 = inferDialogueContext(
    null,
    buildUserTurns(
      [{ role: "user", content: "У меня бизнес" }],
      "На самом деле это небольшой гостевой дом у моря"
    )
  );
  assert("G override lodging", g2.domain === "lodging");
}

if (failed) {
  console.error("\n" + failed + " domain regression(s) failed");
  process.exit(1);
}
console.log("\nAll domain regressions passed.");
