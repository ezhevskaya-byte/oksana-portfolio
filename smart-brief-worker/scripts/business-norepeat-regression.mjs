/**
 * LIVE NO-REPEAT: BUSINESS recovery vs acknowledgement desync + cross-domain A–G.
 */
import {
  buildUserTurns,
  mergeBriefCoverage,
  evaluateBriefReady,
  resolveClarifyTarget,
  selectClarifyMessage,
  buildFirstTurnWelcome,
  inferDialogueContext,
  looksLikeBusinessEvidence,
  scoreDialogueDomains
} from "../src/gate.js";

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("ok  -", name);
  else {
    console.error("FAIL -", name);
    failed += 1;
  }
}

const U1 =
  "Я веду бухгалтерское сопровождение малого бизнеса. Работаю в основном с ИП и небольшими ООО. Новые клиенты чаще приходят по рекомендациям и обычно сначала пишут мне в мессенджер.";
const U2 =
  "Я беру бухгалтерию бизнеса на сопровождение: учёт, отчётность, налоги и связанные с этим текущие вопросы. Но сейчас хочу улучшить именно работу с новыми обращениями — на первичное общение уходит слишком много времени.";

console.log("\n=== exact LIVE business no-repeat ===");
{
  const welcome = buildFirstTurnWelcome(U1);
  const ut1 = buildUserTurns([], U1);
  const m1 = mergeBriefCoverage(null, {}, ut1);
  const b1 = evaluateBriefReady(m1.coverage, ut1);
  const t1 = resolveClarifyTarget(b1.missing, m1.coverage, ut1);
  const ctx1 = inferDialogueContext(m1.coverage, ut1);

  assert("U1 domain professional", ctx1.domain === "professional");
  assert("U1 BUSINESS known", m1.coverage.business.status === "known");
  assert("U1 next focus not BUSINESS", t1.focus !== "business");
  assert("U1 next focus GOAL", t1.focus === "goal");
  assert("U1 welcome not business re-ask", !/чем\s+именно\s+вы\s+занимаетесь|что\s+предлагаете/i.test(welcome));
  assert("U1 welcome asks goal", /какого\s+результата/i.test(welcome));

  const hist = [
    { role: "user", content: U1 },
    { role: "assistant", content: welcome }
  ];
  const ut2 = buildUserTurns(hist, U2);
  const m2 = mergeBriefCoverage(m1.briefState, {}, ut2);
  const b2 = evaluateBriefReady(m2.coverage, ut2);
  const t2 = resolveClarifyTarget(b2.missing, m2.coverage, ut2);
  const q2 = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "business", reason: "stale" },
      clarifyFallbackMessage:
        "Расскажите немного подробнее о вашем бизнесе: чем именно вы занимаетесь и что предлагаете клиентам?",
      recommendationMode: "none",
      phase: "clarify"
    },
    b2.missing,
    m2.coverage,
    ut2
  );

  assert("U2 BUSINESS known", m2.coverage.business.status === "known");
  assert("U2 GOAL known", m2.coverage.goal.status === "known");
  assert(
    "U2 friction evidence",
    m2.coverage.friction.status === "known" || m2.coverage.friction.status === "partial"
  );
  assert("U2 next not BUSINESS", t2.focus !== "business");
  assert("U2 next not GOAL", t2.focus !== "goal");
  assert("U2 question not business", !/чем\s+именно\s+вы\s+занимаетесь|что\s+предлагаете/i.test(q2));
  assert("U2 question not goal", !/какого\s+результата/i.test(q2));
  assert("U2 question non-empty", q2.length > 20);
}

console.log("\n=== cross-domain BUSINESS A–F ===");
{
  const cases = [
    ["A", "У меня небольшая студия йоги"],
    ["B", "Сдаю несколько квартир посуточно"],
    ["C", "Шью текстиль для дома на заказ"],
    ["D", "Помогаю компаниям вести кадровый учёт"],
    ["E", "Провожу занятия по английскому для детей"],
    ["F", "Продаём оборудование для кафе"]
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const id = cases[i][0];
    const text = cases[i][1];
    assert(id + " detector", looksLikeBusinessEvidence(text) === true);
    const ut = buildUserTurns([], text);
    const merged = mergeBriefCoverage(null, {}, ut);
    assert(id + " BUSINESS known", merged.coverage.business.status === "known");
    const welcome = buildFirstTurnWelcome(text);
    assert(id + " no business re-ask", !/чем\s+именно\s+вы\s+занимаетесь/i.test(welcome));
  }
}

console.log("\n=== G long first message multi-fact ===");
{
  const long =
    "У меня небольшая студия йоги. Клиенты — женщины 25–45. Приходят из соцсетей, пишут в Direct, администратор записывает вручную. Хочу, чтобы клиент сам видел расписание и оставлял заявку. Сейчас каждому заново отвечаю на одни и те же вопросы.";
  const ut = buildUserTurns([], long);
  const merged = mergeBriefCoverage(null, {}, ut);
  assert("G business known", merged.coverage.business.status === "known");
  assert("G goal known", merged.coverage.goal.status === "known");
  assert(
    "G audience at least partial",
    merged.coverage.audienceInput.status === "known" ||
      merged.coverage.audienceInput.status === "partial"
  );
  assert(
    "G journey at least partial",
    merged.coverage.customerJourney.status === "known" ||
      merged.coverage.customerJourney.status === "partial"
  );
  const brief = evaluateBriefReady(merged.coverage, ut);
  const target = resolveClarifyTarget(brief.missing, merged.coverage, ut);
  assert("G next not business", target.focus !== "business");
  assert("G next not goal", target.focus !== "goal");
  const welcome = buildFirstTurnWelcome(long);
  assert("G welcome not business/goal loop", !/чем\s+именно\s+вы\s+занимаетесь|какого\s+результата/i.test(welcome));
}

console.log("\n=== hotelos regression ===");
{
  assert(
    "hotelos lodging score 0",
    scoreDialogueDomains("Хотелось бы, чтобы потенциальный клиент посмотрел услуги").lodging === 0
  );
  const turns = buildUserTurns(
    [
      {
        role: "user",
        content:
          "Я оказываю бухгалтерские услуги небольшим компаниям и ИП. Большинство новых клиентов приходит по рекомендациям."
      },
      { role: "assistant", content: "ok" }
    ],
    "Хотелось бы, чтобы потенциальный клиент сначала сам посмотрел информацию об услугах, а потом ответил на несколько вопросов о своём бизнесе."
  );
  const ctx = inferDialogueContext(null, turns);
  assert("hotelos stays professional", ctx.domain === "professional");
}

if (failed) {
  console.error("\n" + failed + " business no-repeat regression(s) failed");
  process.exit(1);
}
console.log("\nAll business no-repeat regressions passed.");
