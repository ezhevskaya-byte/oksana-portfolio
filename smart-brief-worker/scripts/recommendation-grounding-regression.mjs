/**
 * Recommendation grounding + problem-shape regressions (A–K).
 * Source of truth: SMART-BRIEF-DIALOGUE.md
 */
import {
  buildUserTurns,
  mergeBriefCoverage,
  collectSolutionEvidence,
  collectInvalidatedHypotheses,
  buildEvidenceBackedRecommendation,
  evaluateExpertPlan,
  evaluateSolutionReady,
  looksLikeFrictionEvidence,
  resolveProblemShape,
  inferDialogueContext
} from "../src/gate.js";
import {
  detectProjectStage as dialogueStage,
  assessDialogueUnderstanding,
  planNextUsefulStep
} from "../src/dialogue.js";

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("ok  -", name);
  else {
    console.error("FAIL -", name);
    failed += 1;
  }
}

function turnsFrom(...msgs) {
  let hist = [];
  let turns = [];
  let prior = null;
  let merged = null;
  for (let i = 0; i < msgs.length; i += 1) {
    turns = buildUserTurns(hist, msgs[i]);
    merged = mergeBriefCoverage(prior, {}, turns);
    prior = merged.briefState;
    hist = hist.concat([{ role: "user", content: msgs[i] }]);
  }
  return { turns, hist, merged };
}

const TEXTILE_BIZ =
  "У меня небольшой магазин домашнего текстиля: постельное бельё, полотенца, одеяла, подушки, халаты и пледы. Магазин работает офлайн, есть группа ВКонтакте и Telegram. Покупатели в основном женщины, примерно 90%. Хотелось бы увеличить продажи и привлечь новых клиентов.";
const TEXTILE_MATTERS =
  "Чаще всего для них важны качество, цена и чтобы можно было спокойно выбрать всё в одном месте. Ещё многие ценят, когда можно посмотреть товар вживую и получить нормальную консультацию.";
const TEXTILE_FRICTION =
  "Больше всего времени уходит на консультации в магазине. Люди часто долго выбирают, спрашивают про размеры, состав и отличия товаров, а иногда уходят подумать и не возвращаются.";
const TEXTILE_TOOLS =
  "Заказы отдельно нигде не ведём. В основном всё вручную: человек приходит в магазин или пишет в ВКонтакте/Telegram, продавец отвечает, помогает выбрать и оформляет заказ. Отдельной CRM и бота нет.";
const TEXTILE_FLOW =
  "Хочу, чтобы человек мог заранее посмотреть товары, цены и основные характеристики, понять, что ему подходит, при необходимости получить помощь с выбором, а потом быстро оформить заказ или прийти в магазин уже понимая, что хочет купить.";
const TEXTILE_PAY =
  "Онлайн-оплата пока не нужна. Мне достаточно, чтобы человек оставил заявку или связался с магазином, а дальше продавец уже поможет оформить покупку.";
const TEXTILE_REJECT =
  "У меня нет проблемы с очередью или хаосом заявок. Главная проблема в другом: продавцы тратят много времени на повторяющиеся консультации, а часть заинтересованных покупателей не возвращается после того, как ушла подумать.";

const BIKE_U1 =
  "У меня небольшой сервис по ремонту велосипедов. Клиенты обычно пишут или звонят, чтобы узнать стоимость ремонта и можно ли привезти велосипед. Сейчас всё принимаем вручную, отдельной системы учёта нет. Больше всего времени уходит на одинаковые вопросы о стоимости и сроках, а иногда человек после разговора пропадает.";
const BIKE_GOAL =
  "Хочу, чтобы люди могли заранее узнать стоимость и сроки ремонта, понять, что им подходит, и быстрее записываться на ремонт. И хотелось бы меньше тратить времени на одинаковые вопросы.";
const BIKE_WHO = "В основном это обычные городские велосипедисты: люди, которые ездят на велосипеде для прогулок, по делам и иногда на работу.";
const BIKE_TOOLS =
  "Почти всё вручную. Есть только телефон и переписка, отдельной CRM, календаря или системы заявок нет.";
const BIKE_FLOW =
  "Хочу, чтобы человек мог сам посмотреть основные цены и сроки ремонта, понять, что ему подходит, а если нужны уточнения — быстро задать вопрос. После этого он должен иметь возможность оставить заявку на ремонт, а продавец уже связаться с ним и согласовать детали.";
const BIKE_NEXT =
  "Сразу следующий шаг: человек должен иметь возможность записаться на ремонт, но окончательные детали продавец согласует с ним после обращения.";

const BAD_QUEUE_REC =
  "По тому, что вы описали, я бы начал с направления: Простой контур приёма заявок и очереди (форма/чат → единый список статусов). Главная боль — хаос заявок и очереди, а не отсутствие полноценного сайта. Сейчас: собрать заявку + одну очередь вместо блокнота.";

const DEFAULT_BAN =
  /упорядочить\s+запись\s+и\s+заявки|минимальный\s+контур\s+заявки\/записи|автоответы\s+и\s+напоминания\s+по\s+мере\s+необходимости/i;

console.log("\n=== A. Bike repair info-first → booking ===");
{
  const { turns, merged } = turnsFrom(BIKE_U1, BIKE_GOAL, BIKE_WHO, BIKE_TOOLS, BIKE_FLOW, BIKE_NEXT);
  const ev = collectSolutionEvidence(merged.coverage, turns);
  const rec = buildEvidenceBackedRecommendation(merged.coverage, turns);
  const msg = rec.assistantMessage || "";
  assert("A shape info_first_to_booking", ev.problemShape === "info_first_to_booking");
  assert("A no queueChaos", ev.queueChaos === false);
  assert("A no CRM/queue bias", !/хаос\s+заявк|упорядочить\s+запись|crm/i.test(msg) || /без\s+полноценной\s+crm|не\s+строить\s+crm/i.test(msg));
  assert("A grounded info+booking", /цен|срок|заявк|запис/i.test(msg));
  assert("A no DEFAULT", !DEFAULT_BAN.test(msg));
  assert("A realProblem pain", /стоим|срок|пропал/i.test((rec.expertPlan && rec.expertPlan.realProblem) || ""));
}

console.log("\n=== B. Bike without WhatsApp/Telegram ===");
{
  const { turns, merged } = turnsFrom(BIKE_U1, BIKE_GOAL, BIKE_WHO, BIKE_TOOLS, BIKE_FLOW, BIKE_NEXT);
  const text = turns.map((t) => t.text).join(" ");
  assert("B no messenger named", !/whatsapp|telegram|телеграм|ватсап/i.test(text));
  const rec = buildEvidenceBackedRecommendation(merged.coverage, turns);
  assert("B still recommends", rec.phase === "recommend");
  assert("B info-first path", /цен|срок|страниц|прайс|мини-сервис/i.test(rec.assistantMessage || ""));
}

console.log("\n=== C. Bike without paymentStance → solution ready ===");
{
  const { turns, merged } = turnsFrom(BIKE_U1, BIKE_GOAL, BIKE_WHO, BIKE_TOOLS, BIKE_FLOW, BIKE_NEXT);
  const ev = collectSolutionEvidence(merged.coverage, turns);
  const sol = evaluateSolutionReady(merged.coverage, turns);
  assert("C paymentStance false", ev.paymentStance === false);
  assert("C solution ready", sol.ready === true);
  assert("C no payment question forced", !/онлайн-?оплат/i.test(sol.question || ""));
}

console.log("\n=== D. Raw opening turn not in reuse/realProblem ===");
{
  const { turns, merged } = turnsFrom(BIKE_U1, BIKE_GOAL, BIKE_WHO, BIKE_TOOLS, BIKE_FLOW, BIKE_NEXT);
  const rec = buildEvidenceBackedRecommendation(merged.coverage, turns);
  const dump = /у меня небольшой сервис по ремонту велосипедов\. клиенты обычно пишут/i;
  assert("D reuseNote clean", !dump.test((rec.expertPlan && rec.expertPlan.reuseNote) || ""));
  assert("D realProblem clean", !dump.test((rec.expertPlan && rec.expertPlan.realProblem) || ""));
  assert("D message clean", !dump.test(rec.assistantMessage || ""));
  assert(
    "D reuse not fake stack",
    !/переиспользовать уже названные инструменты:\s*у меня/i.test(
      (rec.expertPlan && rec.expertPlan.reuseNote) || ""
    )
  );
}

console.log("\n=== E. No default for unmatched ===");
{
  const { turns, merged } = turnsFrom("Здравствуйте. Хочу что-то цифровое для бизнеса.");
  const rec = buildEvidenceBackedRecommendation(merged.coverage, turns);
  assert("E clarify or unmatched", rec.phase === "clarify" || rec.unmatched === true);
  assert("E no DEFAULT boilerplate", !DEFAULT_BAN.test(rec.assistantMessage || ""));
}

console.log("\n=== F. Textile case preserved ===");
{
  const { turns, merged } = turnsFrom(
    TEXTILE_BIZ,
    TEXTILE_MATTERS,
    TEXTILE_FRICTION,
    TEXTILE_TOOLS,
    TEXTILE_FLOW,
    TEXTILE_PAY
  );
  const ev = collectSolutionEvidence(merged.coverage, turns);
  const rec = buildEvidenceBackedRecommendation(merged.coverage, turns);
  const msg = rec.assistantMessage || "";
  assert("F queueChaos false", ev.queueChaos === false);
  assert("F no хаос заявок", !/хаос\s+заявк/i.test(msg));
  assert("F catalog/consult", /каталог|витрин|характеристик|консультац/i.test(msg));
  assert("F no DEFAULT", !DEFAULT_BAN.test(msg));
}

console.log("\n=== G. Rejected hypothesis not reused ===");
{
  const base = turnsFrom(BIKE_U1, BIKE_GOAL, BIKE_WHO, BIKE_TOOLS, BIKE_FLOW, BIKE_NEXT);
  const hist = base.hist.concat([
    { role: "assistant", content: BAD_QUEUE_REC },
    { role: "user", content: TEXTILE_REJECT }
  ]);
  const turns = buildUserTurns(
    base.hist.concat([{ role: "assistant", content: BAD_QUEUE_REC }]),
    TEXTILE_REJECT
  );
  const merged = mergeBriefCoverage(null, {}, turns);
  const inv = collectInvalidatedHypotheses(turns, hist);
  const rec = buildEvidenceBackedRecommendation(merged.coverage, turns, hist);
  assert("G invalidated queue", inv.queueChaos === true);
  assert("G no queue claim", !/хаос\s+заявк|контур\s+при[её]ма\s+заявк/i.test(rec.assistantMessage || ""));
}

console.log("\n=== H. Website bias ===");
{
  const { turns, merged } = turnsFrom(
    "Клиенты пишут в Telegram про услуги. Одинаковые вопросы о цене. Всё вручную. Хочу чтобы человек заранее понял условия и оставил заявку."
  );
  const rec = buildEvidenceBackedRecommendation(merged.coverage, turns);
  const primary = (rec.expertPlan && rec.expertPlan.primarySolution) || "";
  assert(
    "H not bare website-first without evidence",
    !/^(?:компактн\w*\s+)?сайт$/i.test(primary.trim()) || /telegram|бот|форм|витрин|информац|цен|срок/i.test(primary)
  );
}

console.log("\n=== I. Multi-fact answer ===");
{
  const { turns, merged } = turnsFrom(
    "Я преподаватель английского. Ученики 28–40, им важен график. Приходят в Telegram. Хочу страницу с заявкой. Веду в таблице. Онлайн-оплата не нужна."
  );
  const und = assessDialogueUnderstanding(merged.coverage, turns);
  assert("I closes several gaps", und.gaps.length <= 3);
  const ev = collectSolutionEvidence(merged.coverage, turns);
  assert("I no false queueChaos", ev.queueChaos === false);
}

console.log("\n=== J. Generic service: no CRM → no queue ===");
{
  const { turns, merged } = turnsFrom(
    BIKE_U1,
    BIKE_GOAL,
    BIKE_WHO,
    BIKE_TOOLS,
    BIKE_FLOW,
    BIKE_NEXT
  );
  const ev = collectSolutionEvidence(merged.coverage, turns);
  const rec = buildEvidenceBackedRecommendation(merged.coverage, turns);
  assert("J no queueChaos from no CRM", ev.queueChaos === false);
  assert("J not queue primary", !/очеред|хаос\s+заявк|упорядочить\s+запись/i.test((rec.expertPlan && rec.expertPlan.primarySolution) || ""));
  assert("J domain service or info shape", ev.problemShape === "info_first_to_booking");
}

console.log("\n=== K. Existing / IDEA / LAUNCH stages ===");
{
  const existing = turnsFrom(
    "У меня гостевой дом. Гости семьи. Им важны тишина. Авито → WhatsApp. Много ручных ответов. Excel. Хочу календарь и заявку. Онлайн-оплата не нужна."
  );
  assert("K existing stage", dialogueStage(existing.turns, existing.merged.coverage) === "EXISTING");
  const idea = turnsFrom(
    "Есть идея с нуля сделать каталог для домашнего текстиля. Клиентов пока нет."
  );
  assert("K idea stage", dialogueStage(idea.turns, idea.merged.coverage) === "IDEA");
  const launch = turnsFrom(
    "Собираюсь запускать студию йоги через месяц. Часть расписания уже продумана, но записи пока нет."
  );
  assert("K launch stage", dialogueStage(launch.turns, launch.merged.coverage) === "LAUNCH");
  assert(
    "K friction evidence still works",
    looksLikeFrictionEvidence(
      "Больше всего времени уходит на одинаковые вопросы о стоимости и сроках."
    )
  );
}

if (failed) {
  console.error("\nrecommendation-grounding-regression failures:", failed);
  process.exit(1);
}
console.log("\nrecommendation-grounding-regression: all passed");
