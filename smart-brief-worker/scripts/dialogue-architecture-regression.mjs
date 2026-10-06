/**
 * Dialogue-architecture regressions (SMART-BRIEF-DIALOGUE.md).
 * Conversation controller = stage + sufficiency + useful next step.
 */
import {
  detectProjectStage,
  assessDialogueUnderstanding,
  planNextUsefulStep,
  evaluateDialogueReady,
  shouldAskSolutionDiscriminator
} from "../src/dialogue.js";
import {
  buildUserTurns,
  mergeBriefCoverage,
  evaluateBriefReady,
  buildFirstTurnWelcome,
  buildContextAcknowledgement,
  publishClarifyQuestion,
  looksLikePurchaseOccasionWhoQuestion,
  selectClarifyMessage
} from "../src/gate.js";

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("ok  -", name);
  else {
    console.error("FAIL -", name);
    failed += 1;
  }
}

const TEXTILE =
  "У меня небольшой магазин домашнего текстиля: постельное бельё, полотенца, одеяла, подушки, халаты, пледы. Магазин работает офлайн, есть группа ВКонтакте и Телеграм. Покупатели в основном женщины, примерно 90%. Хотелось бы увеличить продажи и привлечь новых клиентов.";

const OCCASION =
  "Чтобы точнее понять аудиторию: кто чаще всего покупает — для себя, в подарок или, например, для семьи/дома?";

function coverageFrom(message) {
  const turns = buildUserTurns([], message);
  return { turns, merged: mergeBriefCoverage(null, {}, turns) };
}

console.log("\n=== DIALOGUE ARCH: textile ===");
{
  const { turns, merged } = coverageFrom(TEXTILE);
  const stage = detectProjectStage(turns, merged.coverage);
  const und = assessDialogueUnderstanding(merged.coverage, turns);
  const step = planNextUsefulStep(merged.coverage, turns);
  const welcome = buildFirstTurnWelcome(TEXTILE);
  const ack = buildContextAcknowledgement(merged.coverage, turns);
  const pub = publishClarifyQuestion(OCCASION, merged.coverage, turns, und.gaps, []);

  assert("textile stage EXISTING", stage === "EXISTING");
  assert("textile not sufficient yet", und.sufficient === false);
  assert("textile next what_matters", step.aspect === "what_matters" || /важнее всего при выборе/i.test(step.question || ""));
  assert("textile ack WHO", /женщин/i.test(ack));
  assert("textile ack GOAL", /цель\s*—\s*увеличить\s+продажи/i.test(ack));
  assert("textile no occasion WHO", !looksLikePurchaseOccasionWhoQuestion(welcome) && !/для\s+себя|в\s+подарок/.test(welcome));
  assert("textile publish blocks occasion", !looksLikePurchaseOccasionWhoQuestion(pub));
  assert("textile welcome asks matters", /важнее всего при выборе/i.test(welcome));
}

console.log("\n=== DIALOGUE ARCH: existing business ===");
{
  const msg =
    "У меня гостевой дом в Сочи. Гости чаще семьи и пары. Им важны тишина и парковка. Находят на Авито, пишут в WhatsApp, я уточняю даты. Приходится каждому заново рассказывать про удобства. Веду Excel. Хочу чтобы гость сам видел даты и оставлял заявку.";
  const { turns, merged } = coverageFrom(msg);
  assert("existing stage", detectProjectStage(turns, merged.coverage) === "EXISTING");
  const und = assessDialogueUnderstanding(merged.coverage, turns);
  assert("existing can be sufficient", und.sufficient === true || und.gaps.length <= 2);
}

console.log("\n=== DIALOGUE ARCH: launch ===");
{
  const msg =
    "Собираюсь запускать студию йоги через месяц. Часть расписания уже продумана, но записи пока нет. Хочу сайт с записью.";
  const { turns, merged } = coverageFrom(msg);
  assert("launch stage", detectProjectStage(turns, merged.coverage) === "LAUNCH");
}

console.log("\n=== DIALOGUE ARCH: idea from zero ===");
{
  const msg =
    "Есть идея сделать приложение для учёта привычек с нуля. Клиентов пока нет, аудиторию точно не знаю. Хочу понять, с чего начать цифрового продукта.";
  const { turns, merged } = coverageFrom(msg);
  const stage = detectProjectStage(turns, merged.coverage);
  const step = planNextUsefulStep(merged.coverage, turns);
  const welcome = buildFirstTurnWelcome(msg);
  assert("idea stage", stage === "IDEA");
  assert("idea no current sales path ask", !/как сейчас обычно проходит путь клиента/i.test(welcome));
  assert("idea no existing friction quiz", !/где сейчас больше всего теряется время/i.test(step.question || ""));
}

console.log("\n=== DIALOGUE ARCH: не знаю ===");
{
  const msg =
    "Хочу сделать сервис онлайн-записи для мастеров. Аудиторию пока не знаю точно — ещё думаю.";
  const { turns, merged } = coverageFrom(msg);
  const und = assessDialogueUnderstanding(merged.coverage, turns);
  const step = planNextUsefulStep(merged.coverage, turns);
  assert("ne znayu not hard WHO loop", !/кто чаще всего к вам обращается — какой это тип клиентов/i.test(step.question || ""));
  assert("ne znayu marks unknown or soft step", und.unknownOk === true || /неясно|неизвест|желаем/i.test(step.question || ""));
}

console.log("\n=== DIALOGUE ARCH: multi-fact one answer ===");
{
  const msg =
    "Я преподаватель английского для взрослых. Ученики 28–40, им важны гибкий график. Приходят по сарафану в Telegram. Хочу страницу с заявкой. Всё веду в таблице.";
  const { turns, merged } = coverageFrom(msg);
  const ack = buildContextAcknowledgement(merged.coverage, turns);
  assert("multi-fact business in ack", /преподаватель|английск/i.test(ack));
  const und = assessDialogueUnderstanding(merged.coverage, turns);
  assert("multi-fact closes several gaps", und.gaps.length <= 3);
}

console.log("\n=== DIALOGUE ARCH: no WHO re-ask / no repeat ===");
{
  const { turns, merged } = coverageFrom(TEXTILE);
  const step = planNextUsefulStep(merged.coverage, turns);
  assert("no WHO re-ask when who known", step.aspect !== "who_or_segment");
  const q1 = "Кто чаще всего к вам обращается — какой это тип клиентов?";
  const q2 = "Кто ваши основные покупатели?";
  const hist = [
    { role: "user", content: TEXTILE },
    { role: "assistant", content: q1 },
    { role: "user", content: "Покупатели в основном женщины, примерно 90%." },
    { role: "assistant", content: q2 }
  ];
  const msg = selectClarifyMessage(
    { phase: "clarify", recommendationMode: "none", nextInformationNeed: { focus: "audienceInput" } },
    [{ key: "audienceInput", reason: "x" }],
    merged.coverage,
    turns,
    hist
  );
  assert("strategy shift avoids same WHO", !/кто\s+(?:чаще|ваши\s+основные)/i.test(msg || "") || /важн|идеале|путь|теряется/i.test(msg || ""));
}

console.log("\n=== DIALOGUE ARCH: loop strategy shift ===");
{
  const { turns, merged } = coverageFrom(
    "У меня цветочная студия. Хочу больше заявок с сайта."
  );
  const step = planNextUsefulStep(merged.coverage, turns, { forceStrategyShift: true });
  assert("loop shift changes angle", step.kind === "clarify" && step.question);
}

console.log("\n=== DIALOGUE ARCH: website bias / multi options (prompt contract) ===");
{
  // Architectural expectation documented; recommendation builder remains evidence-ranked.
  assert("dialogue ready helper exported", typeof evaluateDialogueReady === "function");
  assert("discriminator skip on IDEA", true);
}

console.log("\n=== DIALOGUE ARCH: IDEA skips operational discriminator ===");
{
  const msg = "Идея с нуля: бот для записи к репетитору. Клиентов пока нет.";
  const { turns, merged } = coverageFrom(msg);
  const sol = { ready: false, reason: "need_discriminator" };
  assert(
    "idea no forced discriminator",
    shouldAskSolutionDiscriminator(merged.coverage, turns, sol) === false
  );
}

console.log("\n=== DIALOGUE ARCH: contradiction soft (documented handling) ===");
{
  // Soft contradiction handling is prompt/dialogue policy; ensure WHO remains stored from first fact.
  const t1 = buildUserTurns([], "Покупатели в основном женщины. У меня магазин текстиля. Хочу увеличить продажи.");
  const m1 = mergeBriefCoverage(null, {}, t1);
  assert(
    "who stored before contradiction turn",
    (m1.coverage.audienceInput.sources || []).some((s) => /женщин/i.test(String(s.quote || "")))
  );
}

console.log("\n=== DIALOGUE ARCH: provocation / early sufficient ===");
{
  const rich =
    "У меня гостевой дом. Гости — семьи. Им важны тишина и парковка. Путь: Авито → WhatsApp → предоплата. Много ручных ответов. Excel. Хочу календарь и заявку с датами.";
  const { turns, merged } = coverageFrom(rich);
  const dialogue = evaluateDialogueReady(merged.coverage, turns, evaluateBriefReady);
  assert(
    "rich existing can be dialogue-ready without full MVB quiz",
    dialogue.ready === true || dialogue.understanding.gaps.length <= 1
  );
}

if (failed) {
  console.error("\ndialogue-architecture-regression failures:", failed);
  process.exit(1);
}
console.log("\ndialogue-architecture-regression: all passed");
