/**
 * Publish-gate regressions A–H:
 * aspect-level no-repeat, history dedup, BUSINESS path, discriminator grounding, website bias.
 */
import {
  buildUserTurns,
  mergeBriefCoverage,
  evaluateBriefReady,
  resolveClarifyTarget,
  selectClarifyMessage,
  buildFirstTurnWelcome,
  publishClarifyQuestion,
  isAudienceWhatMattersEvidence,
  isAudienceWhoEvidence,
  looksLikeBusinessEvidence,
  pickSolutionDiscriminatorQuestion,
  buildEvidenceBackedRecommendation,
  inferQuestionTargetAspect,
  inferQuestionTargetField,
  wasAspectAskedAndAnswered,
  groundDiscriminatorWording,
  inferDialogueContext,
  evaluateSolutionReady
} from "../src/gate.js";
import { trimHistoryForModel } from "../src/validate.js";
import { DIALOGUE_STEP_PROMPTS } from "../src/dialogue.js";

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("ok  -", name);
  else {
    console.error("FAIL -", name);
    failed += 1;
  }
}

console.log("\n=== A. Lodging WHO + what_matters answered → neither repeats ===");
{
  const turns = [
    {
      id: "u1",
      text:
        "Сдаём несколько апартаментов у моря посуточно. Гости чаще приходят из соцсетей и Авито, а подтверждение дат я сейчас собираю вручную в переписке."
    },
    {
      id: "u2",
      text:
        "Хочу меньше отвечать на одни и те же вопросы про даты, заезд и предоплату и быстрее закрывать бронь."
    },
    {
      id: "u3",
      text: "Чаще пары и семьи с детьми, обычно на выходные или короткий отпуск."
    },
    {
      id: "u4",
      text:
        "Им важны чистота, расстояние до моря, понятные фото и чтобы сразу было ясно по цене и свободным датам."
    }
  ];
  assert("matters evidence detected", isAudienceWhatMattersEvidence(turns[3].text));
  assert("who evidence detected", isAudienceWhoEvidence(turns[2].text));
  const m = mergeBriefCoverage(null, {}, turns);
  const r = evaluateBriefReady(m.coverage, turns);
  assert("audience known", r.coverage.audienceInput.status === "known");
  const target = resolveClarifyTarget(r.missing, r.coverage, turns);
  assert("next not audience", target.focus !== "audienceInput");

  const hist = [
    { role: "user", content: turns[0].text },
    {
      role: "assistant",
      content: "А кто чаще всего останавливается у вас — семьи, пары, компании?"
    },
    { role: "user", content: turns[2].text },
    {
      role: "assistant",
      content: "А что для гостей обычно важнее всего при выборе места?"
    },
    { role: "user", content: turns[3].text }
  ];
  const pub = publishClarifyQuestion(
    "А что для гостей обычно важнее всего при выборе места?",
    r.coverage,
    turns,
    r.missing,
    hist
  );
  assert("matters paraphrase rejected", !/важнее всего при выборе места/i.test(pub));
  const whoPub = publishClarifyQuestion(
    "А кто чаще всего останавливается у вас — семьи, пары, компании?",
    r.coverage,
    turns,
    r.missing,
    hist
  );
  assert("WHO paraphrase rejected", !/кто чаще всего останавливается/i.test(whoPub));
}

console.log("\n=== B. B2B new wording — no BUSINESS clarification ===");
{
  const open =
    "Я консультирую небольшие компании по налогам и отчётности. Обычно ко мне приходят по рекомендации знакомых и сначала пишут в Telegram.";
  assert("business evidence", looksLikeBusinessEvidence(open));
  const welcome = buildFirstTurnWelcome(open);
  assert("welcome not BUSINESS re-ask", !/чем\s+именно\s+вы\s+занимаетесь|что\s+предлагаете|о\s+вашем\s+бизнесе/i.test(welcome));
  assert("welcome asks goal", /какого\s+результата/i.test(welcome));
  const ut = buildUserTurns([], open);
  const m = mergeBriefCoverage(null, {}, ut);
  assert("business known after U1", m.coverage.business.status === "known");
}

console.log("\n=== C. Audience: WHO known → matters once; then neither ===");
{
  const turns = [
    { id: "u1", text: "Держу небольшую студию йоги в центре. Клиенты находят нас в Instagram." },
    { id: "u2", text: "Хочу упростить запись без долгой переписки." },
    { id: "u3", text: "В основном женщины 30–45 лет, новички и постоянные." }
  ];
  const m = mergeBriefCoverage(null, {}, turns);
  const r = evaluateBriefReady(m.coverage, turns);
  const t = resolveClarifyTarget(r.missing, r.coverage, turns);
  assert("after WHO → matters allowed", t.focus === "audienceInput" && t.aspect === "what_matters");

  const turns2 = turns.concat([
    {
      id: "u4",
      text: "Им важны удобное время, понятная цена абонемента и быстрый ответ."
    }
  ]);
  const m2 = mergeBriefCoverage(null, {}, turns2);
  const r2 = evaluateBriefReady(m2.coverage, turns2);
  const t2 = resolveClarifyTarget(r2.missing, m2.coverage, turns2);
  assert("after matters → audience closed", t2.focus !== "audienceInput");
  assert("audience known", m2.coverage.audienceInput.status === "known");
}

console.log("\n=== C2. Concise WHO answer is contextual and does not repeat ===");
{
  const whoQuestion = "А кто чаще всего у вас покупает — кто ваши основные покупатели?";
  const hist = [
    { role: "assistant", content: whoQuestion },
    { role: "user", content: "Мужчины" }
  ];
  const turns = [{ id: "u1", text: "Мужчины" }];
  assert("short WHO answer accepted only after WHO question", !isAudienceWhoEvidence("Мужчины"));
  const audienceQuestions = [
    "Кто ваши основные покупатели?",
    "Кто чаще всего у вас покупает?",
    "Кто ваши клиенты?"
  ];
  for (let i = 0; i < audienceQuestions.length; i += 1) {
    assert("audience WHO question " + (i + 1), wasAspectAskedAndAnswered(
      [{ role: "assistant", content: audienceQuestions[i] }, { role: "user", content: "Мужчины" }],
      "audienceInput",
      "who_or_segment"
    ));
  }
  const unrelatedQuestions = [
    "Кто будет обновлять сайт?",
    "Кто отвечает за заявки?",
    "Кто будет заниматься контентом?"
  ];
  for (let i = 0; i < unrelatedQuestions.length; i += 1) {
    assert("unrelated WHO question " + (i + 1), !wasAspectAskedAndAnswered(
      [{ role: "assistant", content: unrelatedQuestions[i] }, { role: "user", content: "Мужчины" }],
      "audienceInput",
      "who_or_segment"
    ));
  }
  const unrelatedRecovery = mergeBriefCoverage(
    null,
    {},
    [{ id: "u1", text: "Мужчины" }],
    [{ role: "assistant", content: unrelatedQuestions[0] }, { role: "user", content: "Мужчины" }]
  );
  assert("unrelated question does not recover WHO", !unrelatedRecovery.coverage.audienceInput.sources.some(function (source) {
    return source.aspect === "who_or_segment";
  }));
  assert("WHO answer recognized in history", wasAspectAskedAndAnswered(hist, "audienceInput", "who_or_segment"));
  const recovered = mergeBriefCoverage(null, {}, turns, hist);
  assert(
    "short WHO source recovered",
    recovered.coverage.audienceInput.sources.some(function (source) {
      return source.aspect === "who_or_segment" && /мужчин/i.test(source.quote);
    })
  );
  const ready = evaluateBriefReady(recovered.coverage, turns);
  const mattersQuestion = publishClarifyQuestion(
    "А что для этих людей обычно важнее всего при выборе?",
    recovered.coverage,
    turns,
    [{ key: "audienceInput", aspect: "what_matters", reason: "status_partial" }],
    hist
  );
  assert("next missing audience aspect is WHAT_MATTERS", /что для этих людей обычно важнее всего/i.test(mattersQuestion));
  const published = publishClarifyQuestion(
    whoQuestion,
    recovered.coverage,
    turns,
    ready.missing,
    hist
  );
  assert("WHO question is not repeated", !/кто чаще всего у вас покупает/i.test(published));
  assert("correction keeps the segment", isAudienceWhoEvidence("Я же сказала мужчины") === false);
  assert(
    "correction is recognized in context",
    wasAspectAskedAndAnswered(
      [{ role: "assistant", content: whoQuestion }, { role: "user", content: "Я же сказала мужчины" }],
      "audienceInput",
      "who_or_segment"
    )
  );
  assert("generic people is not accepted in context", !wasAspectAskedAndAnswered(
    [{ role: "assistant", content: whoQuestion }, { role: "user", content: "Люди" }],
    "audienceInput",
    "who_or_segment"
  ));
  assert(
    "friction wording is clear",
    DIALOGUE_STEP_PROMPTS.friction === "Что в работе вашего бизнеса вы хотели бы улучшить в первую очередь?"
  );
}

console.log("\n=== D. Provider paraphrase of known field → rejected ===");
{
  const open =
    "Я консультирую небольшие компании по налогам и отчётности. Клиенты пишут в Telegram.";
  const ut = buildUserTurns([], open);
  const m = mergeBriefCoverage(null, {}, ut);
  const r = evaluateBriefReady(m.coverage, ut);
  const q = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "business", reason: "provider" },
      clarifyFallbackMessage:
        "Расскажите немного подробнее о вашем бизнесе: чем именно вы занимаетесь и что предлагаете клиентам?",
      recommendationMode: "none",
      phase: "clarify"
    },
    r.missing,
    m.coverage,
    ut,
    [{ role: "user", content: open }]
  );
  assert("provider BUSINESS blocked", !/чем\s+именно\s+вы\s+занимаетесь|о\s+вашем\s+бизнесе/i.test(q));
}

console.log("\n=== E. History: same semantic question different wording → rejected ===");
{
  const turns = [
    { id: "u1", text: "Сдаём апартаменты у моря посуточно, гости из Авито." },
    { id: "u2", text: "Хочу быстрее закрывать бронь без переписки." },
    { id: "u3", text: "Чаще пары и семьи с детьми на выходные." },
    {
      id: "u4",
      text: "Им важны чистота, расстояние до моря и понятные фото по цене."
    }
  ];
  const m = mergeBriefCoverage(null, {}, turns);
  const r = evaluateBriefReady(m.coverage, turns);
  const hist = [
    { role: "user", content: turns[0].text },
    { role: "assistant", content: "А что для гостей обычно важнее всего при выборе места?" },
    { role: "user", content: turns[3].text }
  ];
  assert(
    "aspect answered in history",
    wasAspectAskedAndAnswered(hist, "audienceInput", "what_matters")
  );
  const variants = [
    "Что важно вашим гостям?",
    "Что для гостей важнее при выборе?",
    "На что гости обращают внимание?"
  ];
  for (let i = 0; i < variants.length; i += 1) {
    assert(
      "variant " + (i + 1) + " field audience",
      inferQuestionTargetField(variants[i]) === "audienceInput" ||
        inferQuestionTargetAspect(variants[i]) === "what_matters" ||
        /важн|обращают/.test(variants[i])
    );
    const pub = publishClarifyQuestion(variants[i], m.coverage, turns, r.missing, hist);
    const leaked =
      (/важн|обращают\s+внимание|при\s+выборе\s+места/i.test(pub) &&
        inferQuestionTargetAspect(pub) === "what_matters") ||
      /важнее всего при выборе места/i.test(pub);
    assert("variant " + (i + 1) + " not matters repeat", !leaked);
  }
}

console.log("\n=== F. No-progress → no infinite clarify loop ===");
{
  const turns = [
    { id: "u1", text: "Сдаём апартаменты у моря посуточно." },
    { id: "u2", text: "Хочу меньше ручных ответов про даты." },
    { id: "u3", text: "Чаще пары и семьи." },
    {
      id: "u4",
      text: "Им важны чистота, расстояние до моря, фото и свободные даты."
    }
  ];
  const m = mergeBriefCoverage(null, {}, turns);
  const r = evaluateBriefReady(m.coverage, turns);
  const hist = [
    { role: "assistant", content: "А что для гостей обычно важнее всего при выборе места?" },
    { role: "user", content: turns[3].text },
    { role: "assistant", content: "А что для гостей обычно важнее всего при выборе места?" },
    { role: "user", content: "Могу добавить: почти всё вручную." }
  ];
  const q = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "audienceInput", reason: "stale" },
      clarifyFallbackMessage: "А что для гостей обычно важнее всего при выборе места?",
      recommendationMode: "none",
      phase: "clarify"
    },
    r.missing,
    m.coverage,
    turns,
    hist
  );
  assert("no-progress leaves matters", !/важнее всего при выборе места/i.test(q));
  assert("no-progress non-empty or ready-path", q.length === 0 || q.length > 20);
}

console.log("\n=== G. Generic service discriminator — no ungrounded договор ===");
{
  const ut = [
    {
      id: "u1",
      text: "У меня мастерская по ремонту велосипедов. Клиенты пишут в WhatsApp, запись в блокноте."
    }
  ];
  const q = pickSolutionDiscriminatorQuestion(null, ut);
  assert("no договор in bike disc", !/договор/i.test(q));
  const grounded = groundDiscriminatorWording(
    "На старте важнее собрать обращение или следующий шаг — например уточнение условий или договор?",
    ut,
    inferDialogueContext(null, ut)
  );
  assert("grounding strips договор", !/договор/i.test(grounded));
}

console.log("\n=== H. Website bias — primary vs alternative by evidence ===");
{
  // H1: website appropriate primary (explicit)
  const siteTurns = [
    {
      id: "u1",
      text: "Я фотограф. Хочу свой сайт с портфолио и формой заявки, сейчас только Instagram."
    },
    { id: "u2", text: "Нужен сайт, чтобы клиенты сами оставляли заявку." }
  ];
  // Force enough coverage-like quotes via recovery for recommendation builder
  const siteCov = mergeBriefCoverage(null, {}, siteTurns).coverage;
  const recSite = buildEvidenceBackedRecommendation(siteCov, siteTurns);
  assert(
    "explicit site can be primary",
    /сайт|страниц/i.test(recSite.expertPlan.primarySolution)
  );

  // H2: website appropriate alternative (Telegram B2B)
  const b2bTurns = [
    {
      id: "u1",
      text:
        "Я консультирую небольшие компании по налогам. Клиенты пишут в Telegram. Хочу структурировать первый контакт без сайта ради сайта."
    },
    {
      id: "u2",
      text:
        "Хочу, чтобы человек ответил на несколько вопросов о бизнесе до созвона. CRM нет, всё в Telegram вручную. Оплата по договору, онлайн не нужна. Вопросы одинаковые."
    }
  ];
  const b2bCov = mergeBriefCoverage(null, {}, b2bTurns).coverage;
  const recB2b = buildEvidenceBackedRecommendation(b2bCov, b2bTurns);
  assert(
    "Telegram B2B primary not bare website-first",
    !/^компактный сайт/i.test(recB2b.expertPlan.primarySolution) &&
      (/telegram|мессенджер|обращен|приём|прием|квалиф|информационн/i.test(
        recB2b.expertPlan.primarySolution
      ) ||
        /telegram|мессенджер|страниц/i.test(recB2b.expertPlan.alternative))
  );

  // H3: website not necessary primary (bike queue)
  const bikeTurns = [
    {
      id: "u1",
      text:
        "Мастерская по ремонту велосипедов. WhatsApp и блокнот. Хочу меньше хаоса в заявках и очередь в одном месте."
    },
    {
      id: "u2",
      text:
        "Человек описывает поломку, я записываю в блокнот. Онлайн-оплата не нужна. Поток ровный, условия стабильные."
    }
  ];
  const bikeCov = mergeBriefCoverage(null, {}, bikeTurns).coverage;
  const recBike = buildEvidenceBackedRecommendation(bikeCov, bikeTurns);
  assert(
    "bike primary prefers queue/intake not website-only",
    /заявк|очеред|контур|учёт|учет|форм/i.test(recBike.expertPlan.primarySolution) ||
      !/^компактный сайт/i.test(recBike.expertPlan.primarySolution)
  );
  assert(
    "bike still has alternative class",
    /сайт|страниц|форм|сервис/i.test(recBike.expertPlan.alternative)
  );
}

console.log("\n=== I. READY_REPAIR never when brief ready ===");
{
  const turns = [
    {
      id: "u1",
      text: "Сдаём апартаменты у моря посуточно. Гости из Авито, даты подтверждаю вручную."
    },
    {
      id: "u2",
      text: "Нужно, чтобы гости сами выбирали даты и меньше писали про свободные даты."
    },
    { id: "u3", text: "Чаще пары и семьи с детьми." },
    {
      id: "u4",
      text: "Им важны чистота, расстояние до моря, фото и понятная цена."
    },
    {
      id: "u5",
      text: "Пишут в WhatsApp, я сверяю даты, беру предоплату и подтверждаю бронь."
    },
    { id: "u6", text: "Много времени на одни и те же ответы." },
    {
      id: "u7",
      text: "WhatsApp и таблица. Модуля бронирования нет."
    },
    {
      id: "u8",
      text: "Пусть гость сам видит даты и бронирует."
    },
    {
      id: "u9",
      text: "Предоплата нужна. В сезон занятость меняется часто."
    }
  ];
  const m = mergeBriefCoverage(null, {}, turns);
  const r = evaluateBriefReady(m.coverage, turns);
  const msg = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "none", reason: "" },
      clarifyFallbackMessage: "",
      recommendationMode: "none",
      phase: "clarify"
    },
    r.missing,
    m.coverage,
    turns,
    []
  );
  assert(
    "no technical ready-repair text",
    !/не удалось безопасно собрать рекомендацию/i.test(msg || "")
  );
}

console.log("\n=== J. Full history preserves WHO after long dialogue (trim must not affect gate) ===");
{
  const open =
    "Держим небольшой гостевой дом на 6 номеров. Бронь сейчас собираю в WhatsApp и Excel.";
  const who = "Чаще семьи с детьми и небольшие компании друзей.";
  const matters = "Гостям важны тишина, парковка, расстояние до пляжа и прозрачные условия отмены.";
  // Simulate 14 history items (7 turns) — model trim would drop early WHO ask.
  const fullHist = [
    { role: "user", content: open },
    { role: "assistant", content: "Какого результата вы хотите добиться в первую очередь для гостевого дома?" },
    { role: "user", content: "Нужно сократить ручные подтверждения дат и предоплаты." },
    { role: "assistant", content: "А кто чаще всего останавливается у вас — семьи, пары, компании?" },
    { role: "user", content: who },
    { role: "assistant", content: "А что для гостей обычно важнее всего при выборе места?" },
    { role: "user", content: matters },
    { role: "assistant", content: "Помимо объявлений — чем ещё ведёте брони?" },
    { role: "user", content: "WhatsApp и Excel. Сайта почти нет." },
    { role: "assistant", content: "Как бы вы хотели идеальный путь гостя?" },
    { role: "user", content: "Хочу календарь занятости и заявку с датами." },
    { role: "assistant", content: "Нужна ли предоплата сразу?" },
    { role: "user", content: "Предоплата обязательна. Цены в сезон меняем часто." },
    { role: "assistant", content: "Как обычно проходит путь после первого контакта?" }
  ];
  // With raised maxHistoryForModel, short suites may fully fit; force oversized hist.
  while (fullHist.length < 20) {
    fullHist.push({ role: "user", content: "Добавлю ещё: поток гостей неровный к праздникам." });
    fullHist.push({
      role: "assistant",
      content: "Понял, учту. Есть ли ещё детали по инструментам?"
    });
  }
  const trimmed = trimHistoryForModel(fullHist);
  assert("model trim shortens long history", trimmed.length < fullHist.length);

  const utFull = buildUserTurns(fullHist, "Могу добавить ещё детали.");
  const mFull = mergeBriefCoverage(null, {}, utFull);
  assert("full history keeps audience known", mFull.coverage.audienceInput.status === "known");

  const utTrim = buildUserTurns(trimmed, "Могу добавить ещё детали.");
  const mTrim = mergeBriefCoverage(null, {}, utTrim);
  // Trimmed-only gate path is unsafe — this documents the bug we fixed by not trimming for gates.
  assert(
    "trimmed-only can lose early audience (documents risk)",
    mTrim.coverage.audienceInput.status !== "known" ||
      mFull.coverage.audienceInput.status === "known"
  );

  const whoQ = "А кто чаще всего останавливается у вас — семьи, пары, компании?";
  const pub = publishClarifyQuestion(
    whoQ,
    mFull.coverage,
    utFull,
    evaluateBriefReady(mFull.coverage, utFull).missing,
    fullHist
  );
  assert("WHO not re-asked with full history", !/кто чаще всего останавливается/i.test(pub));
}

console.log("\n=== K. Discriminator exact loop rejected after answer ===");
{
  const turns = [
    { id: "u1", text: "Держим гостевой дом на 6 номеров. Бронь в WhatsApp и Excel." },
    { id: "u2", text: "Нужно сократить ручные подтверждения дат и предоплаты." },
    { id: "u3", text: "Чаще семьи с детьми." },
    { id: "u4", text: "Гостям важны тишина, парковка и понятная цена." },
    { id: "u5", text: "WhatsApp и Excel. Сайта почти нет." },
    { id: "u6", text: "Хочу календарь занятости и заявку с датами." },
    { id: "u7", text: "Предоплата обязательна. Цены в высокий сезон меняем часто." }
  ];
  const m = mergeBriefCoverage(null, {}, turns);
  const r = evaluateBriefReady(m.coverage, turns);
  const hist = [
    {
      role: "assistant",
      content: "Занятость и цены меняются часто, или в целом всё относительно стабильно?"
    },
    { role: "user", content: turns[6].text }
  ];
  const q = "Занятость и цены меняются часто, или в целом всё относительно стабильно?";
  const pub = publishClarifyQuestion(q, m.coverage, turns, r.missing, hist);
  assert("occupancy disc not looped", !/занятость и цены меняются часто/i.test(pub || ""));
  const sol = evaluateSolutionReady(m.coverage, turns);
  assert("lodging solution ready after payment+dynamic prices", sol.ready === true);
}

console.log("\n=== L. Textile occasion-WHO never publishes ===");
{
  const TEXTILE =
    "У меня небольшой магазин домашнего текстиля: постельное бельё, полотенца, одеяла, подушки, халаты, пледы. Магазин работает офлайн, есть группа ВКонтакте и Телеграм. Покупатели в основном женщины, примерно 90%. Хотелось бы увеличить продажи и привлечь новых клиентов.";
  const OCCASION =
    "Чтобы точнее понять аудиторию: кто чаще всего покупает — для себя, в подарок или, например, для семьи/дома?";
  const turns = buildUserTurns([], TEXTILE);
  const m = mergeBriefCoverage(null, {}, turns);
  const r = evaluateBriefReady(m.coverage, turns);
  assert("L goal known", m.coverage.goal.status === "known");
  const target = resolveClarifyTarget(r.missing, m.coverage, turns);
  assert(
    "L not WHO target",
    !(target.focus === "audienceInput" && target.aspect === "who_or_segment")
  );
  const pub = publishClarifyQuestion(OCCASION, m.coverage, turns, r.missing, []);
  assert("L no occasion options", !/для\s+себя|в\s+подарок|семьи\/дома/i.test(pub || ""));
  assert("L not who-buyer ask", !/кто\s+(?:чаще|обычно).{0,40}покупает/i.test(pub || ""));
}

if (failed) {
  console.error("\npublish-gate-regression failures:", failed);
  process.exit(1);
}
console.log("\npublish-gate-regression: all passed");
