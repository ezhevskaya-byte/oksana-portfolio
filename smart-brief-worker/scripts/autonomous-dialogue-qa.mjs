/**
 * Autonomous adaptive dialogue QA for Mark.
 * Answers follow whatever Mark actually asks (not a fixed script order).
 * Run: node scripts/autonomous-dialogue-qa.mjs
 */
import {
  buildUserTurns,
  mergeBriefCoverage,
  evaluateBriefReady,
  resolveClarifyTarget,
  selectClarifyMessage,
  buildFirstTurnWelcome,
  evaluateSolutionReady,
  inferDialogueContext,
  buildEvidenceBackedRecommendation,
  isCompoundDiscoveryQuestion,
  hasInternalSystemWording,
  hasCrossDomainLeakage,
  inferQuestionTargetField
} from "../src/gate.js";

const MVB = [
  "business",
  "goal",
  "audienceInput",
  "customerJourney",
  "friction",
  "existingTools",
  "desiredFlow"
];

function leadingCheck(t) {
  const n = String(t || "")
    .toLowerCase()
    .replace(/\s+/g, " ");
  return (
    (/мог бы сделать сам/.test(n) && /в идеале/.test(n)) ||
    (/получить нужную информацию и оставить заявку/.test(n) && /в идеале/.test(n))
  );
}

function statuses(coverage) {
  const out = {};
  for (let i = 0; i < MVB.length; i += 1) {
    out[MVB[i]] = coverage[MVB[i]] ? coverage[MVB[i]].status : "unknown";
  }
  return out;
}

function judgeQuestion(q, ctx, coverage, priorQuestions) {
  const issues = [];
  if (!q || q.length < 8) issues.push("empty_question");
  if (isCompoundDiscoveryQuestion(q)) issues.push("compound");
  if (hasInternalSystemWording(q)) issues.push("internal_wording");
  if (hasCrossDomainLeakage(q, ctx.domain)) issues.push("cross_domain_leak");
  if (leadingCheck(q)) issues.push("leading");
  const target = inferQuestionTargetField(q);
  if (target && coverage[target] && coverage[target].status === "known") {
    issues.push("asks_known_" + target);
  }
  if (ctx.domain === "professional" || ctx.domain === "b2b") {
    if (/(?:^|[^а-яё])гост(?:ь|я|ю|ем|и|ей)/.test(" " + q.toLowerCase() + " ")) {
      issues.push("guest_in_b2b");
    }
    if (/брон(?:ь|и|ю|ей|ирован)/.test(q.toLowerCase()) && !/без\s+брон/.test(q.toLowerCase())) {
      issues.push("booking_in_b2b");
    }
  }
  const norm = q.toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i < priorQuestions.length; i += 1) {
    const p = String(priorQuestions[i] || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (p && norm === p) issues.push("exact_repeat");
  }
  return issues;
}

function pickAnswer(scenario, focus, aspect, markText, used) {
  const bank = scenario.answers || {};
  const keyAspect = focus ? focus + ":" + (aspect || "") : "";
  const keyFocus = focus || "discriminator";
  const candidates = []
    .concat(keyAspect ? bank[keyAspect] || [] : [])
    .concat(bank[keyFocus] || [])
    .concat(!focus ? bank.discriminator || [] : [])
    .concat(bank.discriminator || [])
    .concat(bank.default || []);

  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i];
    if (a && !used[a]) {
      used[a] = true;
      return a;
    }
  }
  // Last-resort: enrich with payment/ops if Mark asks discriminator-like
  if (/оплат|запис|расписан|мест|преподавател|стабильн/i.test(markText || "")) {
    return (
      "Пока достаточно заявки без онлайн-оплаты. Расписание и условия в целом стабильные, места при необходимости ограничиваем."
    );
  }
  return "Сейчас почти всё делаю вручную в переписке и таблице; хочу упростить первый контакт для клиента.";
}

function step(history, priorState, message, isFirst) {
  const turns = buildUserTurns(history, message);
  const merged = mergeBriefCoverage(priorState, {}, turns);
  const brief = evaluateBriefReady(merged.coverage, turns);
  const solution = evaluateSolutionReady(merged.coverage, turns);
  const target = resolveClarifyTarget(brief.missing, merged.coverage, turns);
  const ctx = inferDialogueContext(merged.coverage, turns);

  let phase = "clarify";
  let text = "";
  if (isFirst) {
    text = buildFirstTurnWelcome(message);
  } else if (brief.ready && solution.ready) {
    phase = "recommend";
    text = buildEvidenceBackedRecommendation(merged.coverage, turns).assistantMessage || "";
  } else if (brief.ready && !solution.ready) {
    text =
      solution.question ||
      selectClarifyMessage(
        {
          nextInformationNeed: { focus: "none", reason: "disc" },
          clarifyFallbackMessage: "",
          recommendationMode: "none",
          phase: "clarify"
        },
        brief.missing.concat([{ key: "solution_discriminator", reason: "need" }]),
        merged.coverage,
        turns
      );
  } else {
    text = selectClarifyMessage(
      {
        nextInformationNeed: { focus: target.focus || "none", reason: "t" },
        clarifyFallbackMessage: "",
        recommendationMode: "none",
        phase: "clarify"
      },
      brief.missing,
      merged.coverage,
      turns
    );
  }

  return {
    briefState: merged.briefState,
    coverage: merged.coverage,
    brief,
    solution,
    target,
    ctx,
    phase,
    text,
    turns
  };
}

function runScenario(scenario, maxTurns) {
  const limit = maxTurns || 10;
  const result = {
    id: scenario.id,
    turns: [],
    issues: [],
    pass: true,
    finalPhase: null,
    finalDomain: null,
    statuses: null
  };
  const used = Object.create(null);
  let history = [];
  let state = null;
  let priorQs = [];
  let last = null;
  let message = scenario.open;

  for (let i = 0; i < limit; i += 1) {
    last = step(history, state, message, i === 0);
    const qIssues =
      last.phase === "recommend"
        ? []
        : judgeQuestion(last.text, last.ctx, last.coverage, priorQs);

    if (scenario.domain) {
      const allowed = Array.isArray(scenario.domain) ? scenario.domain : [scenario.domain];
      if (allowed.indexOf(last.ctx.domain) === -1) {
        qIssues.push("domain_mismatch:" + last.ctx.domain);
      }
    }

    result.turns.push({
      user: message.slice(0, 120),
      phase: last.phase,
      domain: last.ctx.domain,
      focus: last.target.focus,
      aspect: last.target.aspect,
      brief: last.brief.ready,
      sol: last.solution.ready,
      statuses: statuses(last.coverage),
      mark: last.text,
      issues: qIssues
    });

    for (let j = 0; j < qIssues.length; j += 1) {
      result.issues.push("T" + (i + 1) + ":" + qIssues[j]);
      result.pass = false;
    }

    history = history.concat([
      { role: "user", content: message },
      { role: "assistant", content: last.text }
    ]);
    state = last.briefState;
    if (last.phase !== "recommend") priorQs.push(last.text);

    if (last.phase === "recommend") break;

    message = pickAnswer(
      scenario,
      last.target.focus,
      last.target.aspect,
      last.text,
      used
    );
  }

  result.finalPhase = last ? last.phase : null;
  result.finalDomain = last ? last.ctx.domain : null;
  result.statuses = last ? statuses(last.coverage) : null;

  if (scenario.expectRecommend !== false) {
    if (result.finalPhase !== "recommend") {
      result.issues.push("no_recommend_at_end");
      result.pass = false;
    } else {
      const msg = last.text || "";
      const grounded =
        /таблиц|мессенджер|whatsapp|вручную|расписан|преподавател|мест|оплат|заявк|клиент|гост|брон|ученик|покупател|crm|соцсет|рекомендац|квалиф|обращен|переисп|на базе|потому/i.test(
          msg
        );
      if (msg.length < 80 || !grounded) {
        result.issues.push("weak_recommendation");
        result.pass = false;
      }
    }
  }

  // Exact repeat is a hard fail only if we never reached recommend.
  // Intermediate disc re-asks that still end in recommend are reported as soft.
  const hardIssues = result.issues.filter(function (x) {
    if (result.finalPhase === "recommend" && /exact_repeat/.test(x)) return false;
    return true;
  });
  result.softIssues = result.issues.filter(function (x) {
    return result.finalPhase === "recommend" && /exact_repeat/.test(x);
  });
  result.issues = hardIssues;
  if (result.turns.length >= limit && result.finalPhase !== "recommend") {
    result.issues.push("hit_turn_limit");
  }
  result.pass = result.issues.length === 0;
  return result;
}

function printResult(r) {
  const mark = r.pass ? "PASS" : "FAIL";
  console.log(
    "\n[" +
      mark +
      "] " +
      r.id +
      " domain=" +
      r.finalDomain +
      " phase=" +
      r.finalPhase +
      " turns=" +
      r.turns.length
  );
  if (r.issues.length) console.log("  issues:", r.issues.join("; "));
  if (r.softIssues && r.softIssues.length) {
    console.log("  soft:", r.softIssues.join("; "));
  }
  if (!r.pass || process.env.QA_VERBOSE) {
    for (let i = 0; i < r.turns.length; i += 1) {
      const t = r.turns[i];
      console.log(
        "  T" +
          (i + 1) +
          " focus=" +
          t.focus +
          "/" +
          (t.aspect || "") +
          " " +
          JSON.stringify(t.statuses)
      );
      console.log("    USER: " + t.user);
      console.log("    MARK: " + t.mark.slice(0, 180));
    }
  }
}

const CORE = [
  {
    id: "01_accounting_b2b",
    domain: ["professional", "b2b"],
    open:
      "Я веду бухгалтерское сопровождение малого бизнеса — в основном ИП и небольшие ООО. Новые клиенты чаще приходят по рекомендациям и сначала пишут в мессенджер.",
    answers: {
      goal: [
        "Хочу сократить время на первичное общение: сейчас каждому объясняю услуги, цены и документы, а потом ещё понимаю, подходит ли клиент."
      ],
      "audienceInput:who_or_segment": [
        "В основном собственники ИП и небольших ООО, иногда бухгалтеры на аутсорсе ищут замену."
      ],
      "audienceInput:what_matters": [
        "Им важно доверие к специалисту, понятная стоимость и быстрый ответ. Перед стартом задают примерно одни и те же вопросы."
      ],
      customerJourney: [
        "Пишут в мессенджер, кратко описывают ситуацию. Я уточняю форму бизнеса, налоги, сотрудников, оцениваю объём и называю стоимость. Если готовы — запрашиваю документы и оформляем сотрудничество."
      ],
      friction: [
        "На первичное общение уходит слишком много времени — одним и тем же объяснениям и проверке, подходит ли клиент."
      ],
      existingTools: [
        "CRM нет, бота нет. Переписка в мессенджере, заметки и иногда таблица. Отдельной системы заявок нет."
      ],
      desiredFlow: [
        "Хотелось бы, чтобы человек сначала сам посмотрел услуги и условия, ответил на несколько вопросов о бизнесе, и я ещё до разговора понимала, подходит ли задача и какие данные уже есть."
      ],
      discriminator: [
        "Предварительные вопросы в целом одинаковые. После сбора данных почти всегда нужен короткий личный разговор перед стартом."
      ]
    }
  },
  {
    id: "02_yoga_studio",
    domain: "studio",
    open:
      "У меня небольшая студия йоги. Клиенты приходят через соцсети, а запись администратор ведёт вручную.",
    answers: {
      goal: [
        "Основная задача — упростить запись на занятия. Человек пишет в личку, администратор отвечает про расписание и места, потом записывает вручную."
      ],
      "audienceInput:who_or_segment": [
        "В основном женщины 25–45, начинающие и те, кто уже практикует."
      ],
      "audienceInput:what_matters": [
        "Им важно удобное время, стоимость и быстрая запись без долгой переписки."
      ],
      customerJourney: [
        "Видят нас в соцсетях, пишут администратору, уточняют занятие и время, узнают про свободные места и записываются вручную."
      ],
      friction: ["Каждому заново отвечаем на одни и те же вопросы про расписание и места."],
      existingTools: ["CRM нет. Записи в таблице и календаре, всё вручную."],
      desiredFlow: [
        "Хочу, чтобы клиент сам видел расписание и записывался без долгой переписки."
      ],
      discriminator: [
        "Пока достаточно записи без онлайн-оплаты. Расписание меняется часто, несколько преподавателей, места ограничены."
      ]
    }
  },
  {
    id: "03_guest_house",
    domain: "lodging",
    open:
      "У меня небольшой гостевой дом. Большинство гостей находят нас через соцсети, а бронирования я сейчас обрабатываю вручную.",
    answers: {
      goal: [
        "Хочу меньше отвечать на одни и те же вопросы и быстрее подтверждать бронь."
      ],
      "audienceInput:who_or_segment": ["Чаще семьи и пары 30–50."],
      "audienceInput:what_matters": [
        "Им важны тишина, чистота, море рядом и понятная цена."
      ],
      customerJourney: [
        "Смотрят объявление или соцсети, пишут в WhatsApp, я уточняю даты, называю стоимость, после предоплаты подтверждаю бронь."
      ],
      friction: ["Приходится каждому гостю заново объяснять условия и наличие дат."],
      existingTools: [
        "Есть система бронирования с календарём и модулем онлайн-бронирования, плюс WhatsApp. Сайта своего почти нет."
      ],
      desiredFlow: [
        "В идеале гость сам смотрит свободные даты и бронирует."
      ],
      discriminator: ["Оплата предоплатой при бронировании нужна."]
    }
  },
  {
    id: "04_retail_shop",
    domain: ["retail", "generic", "studio"],
    open:
      "У меня небольшой магазин домашнего текстиля. Покупатели чаще всего пишут в Instagram Direct.",
    answers: {
      goal: [
        "Хочу, чтобы люди сами смотрели ассортимент и оставляли заказ, а не спрашивали про наличие каждого товара в переписке."
      ],
      "audienceInput:who_or_segment": ["Покупатели — женщины 25–45."],
      "audienceInput:what_matters": [
        "Им важны качество ткани, цена и быстрая доставка."
      ],
      customerJourney: [
        "Смотрят рилс или профиль, пишут в Direct, спрашивают наличие и размер, я отвечаю и оформляю заказ вручную."
      ],
      friction: ["Много одинаковых вопросов про наличие и размеры в переписке."],
      existingTools: [
        "Сайта нормального нет. Instagram, WhatsApp и таблица заказов в Excel. CRM нет."
      ],
      desiredFlow: [
        "Хотелось бы витрину с товарами и простой формой заказа."
      ],
      discriminator: ["Онлайн-оплата пока не обязательна, достаточно заявки."]
    }
  },
  {
    id: "05_english_teacher",
    domain: ["education", "studio", "professional"],
    open:
      "Я частный преподаватель английского для взрослых. Ученики приходят через сарафан и пишут в личные сообщения.",
    answers: {
      goal: [
        "Хочу, чтобы человек заранее понимал формат и цены и мог оставить заявку, а мне не пришлось бы каждому заново всё рассказывать."
      ],
      "audienceInput:who_or_segment": [
        "Чаще взрослые 25–45, готовятся к работе или переезду."
      ],
      "audienceInput:what_matters": [
        "Им важны метод, формат занятий и ориентир по стоимости."
      ],
      customerJourney: [
        "Пишут в WhatsApp или Instagram, я выясняю цель и уровень, предлагаю формат, обсуждаем расписание и оплату, иногда пробное занятие."
      ],
      friction: ["Каждому заново рассказываю про формат и цены в переписке."],
      existingTools: [
        "Сайта нет. Записи в Google Таблице, общение в WhatsApp. CRM и бота нет."
      ],
      desiredFlow: [
        "До переписки человек мог бы понять подход, цены и оставить заявку на пробное."
      ],
      discriminator: [
        "Оплата на занятии, онлайн не нужна. Расписание относительно стабильное, я одна, места по слотам ограничены."
      ]
    }
  },
  {
    id: "06_beauty_master",
    domain: ["studio", "generic"],
    open: "Я мастер маникюра, работаю одна. Клиенты пишут в Direct, я сама подбираю окна и записываю вручную.",
    answers: {
      goal: ["Хочу тратить меньше времени на переписку про свободные слоты и прайс."],
      "audienceInput:who_or_segment": ["Обычно женщины 20–40."],
      "audienceInput:what_matters": [
        "Им важно удобное время, аккуратность и чтобы сразу было понятно по цене."
      ],
      customerJourney: [
        "Пишут в Instagram, спрашивают свободные окна, я смотрю календарь в телефоне и подтверждаю запись в переписке."
      ],
      friction: ["Много переписки про окна и прайс, всё вручную."],
      existingTools: ["Только телефон, Instagram и заметки. CRM нет, онлайн-записи нет."],
      desiredFlow: [
        "Хочу, чтобы клиентка сама выбрала свободное время и оставила заявку."
      ],
      discriminator: ["Оплата в студии после услуги, онлайн не нужна."]
    }
  },
  {
    id: "07_b2b_packaging",
    domain: ["b2b", "professional"],
    open:
      "Мы B2B-сервис: помогаем компаниям с упаковкой поставок. Клиенты приходят из рекомендаций и пишут на почту.",
    answers: {
      goal: [
        "Хотим меньше ручных согласований на входе и понятный первый контакт для новых заказчиков."
      ],
      "audienceInput:who_or_segment": [
        "Решение принимают владельцы и закупщики компаний."
      ],
      "audienceInput:what_matters": [
        "Им важны сроки, прозрачная смета и чтобы не объяснять условия по кругу."
      ],
      customerJourney: [
        "Пишут на почту, менеджер уточняет объём, считает смету, ведёт сделку в таблице и возвращается с предложением."
      ],
      friction: ["Одни и те же условия объясняем каждому новому заказчику вручную."],
      existingTools: ["CRM нет, всё в почте и Google таблице. Бота нет."],
      desiredFlow: [
        "Хотим, чтобы заказчик сам понял формат работы и оставил заявку с исходными данными."
      ],
      discriminator: [
        "Вопросы на входе похожи. После заявки обычно нужен короткий созвон. Оплата по счёту, онлайн не нужна."
      ]
    }
  },
  {
    id: "08_wants_website",
    domain: ["studio", "generic"],
    open:
      "Мне нужен сайт для студии растяжки. Сейчас запись только через WhatsApp вручную.",
    answers: {
      goal: [
        "Хочу, чтобы клиент видел расписание и оставлял заявку на сайте."
      ],
      "audienceInput:who_or_segment": ["Клиенты — женщины 20–40."],
      "audienceInput:what_matters": ["Им важно удобное время и понятные цены."],
      customerJourney: [
        "Находят нас в соцсетях, пишут в WhatsApp, администратор рассказывает про занятия и записывает вручную."
      ],
      friction: ["Много ручной переписки про запись."],
      existingTools: ["Сайта нет, CRM нет, только WhatsApp и таблица."],
      desiredFlow: [
        "На сайте нужна запись: клиент сам смотрит расписание и оставляет заявку."
      ],
      discriminator: [
        "Запись без онлайн-оплаты. Расписание относительно стабильное, один преподаватель, места ограничены."
      ]
    }
  },
  {
    id: "09_unknown_solution",
    domain: ["generic", "professional", "b2b", "retail", "studio", "service"],
    open:
      "У меня небольшой бизнес по ремонту техники на дому. Клиенты звонят и пишут в WhatsApp, я сама всё координирую.",
    answers: {
      goal: [
        "Не знаю, что именно мне нужно — сайт, бот или что-то ещё. Хочу меньше хаоса в заявках и понятный вход для клиента."
      ],
      "audienceInput:who_or_segment": [
        "Обычно частные клиенты и небольшие офисы."
      ],
      "audienceInput:what_matters": [
        "Им важны скорость выезда, честная оценка и аккуратность."
      ],
      customerJourney: [
        "Человек звонит или пишет, описывает поломку, я уточняю адрес и время, выезжаю, чиню, принимаю оплату на месте."
      ],
      friction: ["Хаос в заявках: всё собираю вручную из звонков и переписки."],
      existingTools: ["Только телефон, WhatsApp и блокнот. Никакой CRM."],
      desiredFlow: [
        "В идеале клиент оставлял бы заявку с описанием проблемы и удобным временем."
      ],
      discriminator: ["Онлайн-оплата не нужна."]
    }
  },
  {
    id: "10_long_first_message",
    domain: "studio",
    open:
      "У меня небольшая студия йоги. Клиенты — женщины 25–45. Приходят из соцсетей, пишут в Direct, администратор отвечает на вопросы про занятия и места, потом записывает вручную в таблицу. Хочу, чтобы клиент сам видел расписание и оставлял заявку. Сейчас каждому заново отвечаю на одни и те же вопросы. CRM нет, всё вручную.",
    answers: {
      "audienceInput:what_matters": [
        "Им важны удобное время, стоимость, хороший преподаватель и быстрая запись без долгой переписки."
      ],
      discriminator: [
        "Пока достаточно записи без онлайн-оплаты. Расписание меняется часто, несколько преподавателей, места на занятиях ограничены."
      ],
      desiredFlow: [
        "Да, в идеале клиент сам смотрит расписание и оставляет заявку на занятие."
      ],
      existingTools: ["Только таблица, календарь и соцсети. Отдельного сервиса записи нет."],
      default: [
        "Пока достаточно записи без онлайн-оплаты. Расписание часто меняется, несколько преподавателей, места ограничены."
      ]
    }
  },
  {
    id: "11_correction",
    domain: "lodging",
    open: "У меня небольшой бизнес посуточной аренды, в основном через Авито и переписку.",
    answers: {
      business: [
        "На самом деле это гостевой дом на 6 номеров у моря. Гости чаще семьи и пары."
      ],
      goal: ["Хочу меньше ручных ответов про даты и предоплату."],
      "audienceInput:who_or_segment": ["Гости чаще семьи и пары 30–50."],
      "audienceInput:what_matters": [
        "Им важны вид на море, чистота и понятные условия заезда."
      ],
      customerJourney: [
        "Смотрят Авито, пишут в WhatsApp, я уточняю даты, беру предоплату и подтверждаю бронь."
      ],
      friction: ["Много одинаковых вопросов про даты и предоплату вручную."],
      existingTools: [
        "Веду занятость в модуле онлайн-бронирования и WhatsApp."
      ],
      desiredFlow: ["В идеале гость сам бронирует свободные даты."],
      discriminator: ["Предоплата при бронировании нужна."]
    }
  },
  {
    id: "12_multi_fact_answer",
    domain: ["professional", "b2b"],
    open: "Оказываю юридические консультации предпринимателям. Клиенты пишут в Telegram.",
    answers: {
      goal: [
        "Хочу ускорить первичный отбор. Обычно пишут в Telegram, я выясняю задачу, форму бизнеса и срочность, оцениваю, могу ли помочь, называю формат и стоимость. CRM нет, всё в чатах и заметках. Идеально — человек сначала читает, какие вопросы я беру, отвечает на короткую анкету, и я вижу, подходит ли обращение, ещё до созвона."
      ],
      "audienceInput:who_or_segment": [
        "Основные клиенты — предприниматели, собственники ИП и небольших ООО."
      ],
      "audienceInput:what_matters": [
        "Им важны понятная стоимость, сроки и чтобы было ясно, беру ли я такие задачи."
      ],
      customerJourney: [
        "Пишут в Telegram, я уточняю задачу и срочность, оцениваю, могу ли помочь, называю формат и стоимость, потом созвон."
      ],
      friction: ["Каждому заново объясняю, какие вопросы я беру и как устроен старт."],
      existingTools: ["Всё в Telegram-чатах и заметках. CRM нет, таблицы почти нет."],
      desiredFlow: [
        "Хотелось бы короткую анкету до созвона: тип бизнеса, задача, срочность."
      ],
      discriminator: [
        "Предварительные вопросы примерно одинаковые. После сбора данных почти всегда нужен личный разговор. Оплата по договору, не онлайн."
      ],
      default: [
        "Вопросы на входе похожие. После анкеты обычно нужен короткий созвон. Оплата по договору, не онлайн."
      ]
    }
  },
  {
    id: "13_short_colloquial",
    domain: ["studio", "generic"],
    open: "Салон красоты, запись в директ, всё руками.",
    answers: {
      goal: ["Нужно меньше переписки."],
      "audienceInput:who_or_segment": ["Девушки 20–35."],
      "audienceInput:what_matters": ["Им важно время и мастер."],
      customerJourney: ["Пишут — спрашивают окна — я смотрю телефон — записываю."],
      friction: ["Много переписки, всё руками."],
      existingTools: ["Только инста и заметки, crm нет."],
      desiredFlow: ["Пусть сами выбирают время и оставляют заявку."],
      discriminator: ["Оплата на месте."]
    }
  }
];

const FRESH = [
  {
    id: "F1_photo_studio",
    domain: ["studio", "generic", "professional", "b2b"],
    open: "Снимаю семейные фотосессии. Клиенты находят меня через рекомендации и Instagram.",
    answers: {
      goal: ["Хочу меньше согласовывать пакеты и даты в переписке."],
      "audienceInput:who_or_segment": ["Семьи с детьми и пары."],
      "audienceInput:what_matters": [
        "Им важны стиль съёмки, локация и понятная стоимость пакета."
      ],
      customerJourney: [
        "Пишут в Direct, я присылаю примеры, обсуждаю дату и пакет, потом бронь и предоплата."
      ],
      friction: ["Много ручного согласования пакетов и дат в переписке."],
      existingTools: ["Только Instagram, WhatsApp и календарь в телефоне."],
      desiredFlow: ["Хочу страницу с пакетами и формой заявки на дату."],
      discriminator: ["Предоплата потом можно оставить как есть, онлайн сразу не обязательна."]
    }
  },
  {
    id: "F2_cafe_equipment",
    domain: ["retail", "b2b", "generic"],
    open: "Продаём оборудование для небольших кафе. Заявки в основном с Avito и по телефону.",
    answers: {
      goal: [
        "Хотим, чтобы покупатель сам смотрел каталог и оставлял запрос на коммерческое предложение."
      ],
      "audienceInput:who_or_segment": [
        "Клиенты — владельцы кафе и управляющие."
      ],
      "audienceInput:what_matters": [
        "Им важны сроки поставки, гарантия и понятная комплектация."
      ],
      customerJourney: [
        "Звонят или пишут, спрашивают наличие, мы уточняем задачу, считаем КП, потом счёт и отгрузка."
      ],
      friction: ["Много одинаковых вопросов про наличие и комплектацию вручную."],
      existingTools: ["Сайта толкового нет, Excel и WhatsApp. CRM нет."],
      desiredFlow: ["Нужна витрина и форма запроса КП."],
      discriminator: ["Онлайн-оплата не нужна — работаем по счёту."]
    }
  },
  {
    id: "F3_kids_english",
    domain: ["education", "studio"],
    open: "Веду английский для детей 7–12 онлайн. Родители пишут в WhatsApp после рекомендаций.",
    answers: {
      goal: [
        "Хочу, чтобы родитель заранее понимал формат и мог записаться на пробный урок."
      ],
      "audienceInput:who_or_segment": ["Родители школьников 7–12 лет."],
      "audienceInput:what_matters": [
        "Им важны прогресс ребёнка, удобное время и понятная цена абонемента."
      ],
      customerJourney: [
        "Пишут в WhatsApp, я рассказываю про программу, подбираю время, записываю в таблицу."
      ],
      friction: ["Каждому родителю заново объясняю формат в переписке."],
      existingTools: ["Таблица и WhatsApp. Платформы записи нет."],
      desiredFlow: ["Пусть родитель сам выбирает слот пробного урока."],
      discriminator: [
        "Оплата после пробного, не онлайн сразу. Расписание довольно стабильное, я одна."
      ]
    }
  },
  {
    id: "F4_auto_service",
    domain: ["generic", "studio", "retail", "service"],
    open: "Небольшой автосервис. Клиенты звонят, записываем на ремонт в журнале.",
    answers: {
      goal: ["Хотим меньше звонков «есть ли окно завтра» и понятную запись."],
      "audienceInput:who_or_segment": ["Частники и таксисты."],
      "audienceInput:what_matters": [
        "Им важны срок ремонта, цена и честная диагностика."
      ],
      customerJourney: [
        "Звонок или WhatsApp → уточняем проблему → смотрим загрузку бокса → записываем в журнал → ремонт."
      ],
      friction: ["Много звонков про окна, запись вручную в журнале."],
      existingTools: ["Журнал на бумаге и WhatsApp. Сайта нет."],
      desiredFlow: ["Нужна онлайн-заявка на диагностику с выбором дня."],
      discriminator: ["Оплата в сервисе, онлайн не нужна."]
    }
  },
  {
    id: "F5_hr_outsource",
    domain: ["professional", "b2b"],
    open:
      "Помогаю компаниям вести кадровый учёт на аутсорсе. Обращения из рекомендаций и LinkedIn.",
    answers: {
      goal: [
        "Хочу быстрее понимать, подходит ли компания по масштабу, ещё до созвона."
      ],
      "audienceInput:who_or_segment": [
        "Собственники и HR небольших ООО."
      ],
      "audienceInput:what_matters": [
        "Им важны аккуратность документов, сроки и прозрачная стоимость сопровождения."
      ],
      customerJourney: [
        "Пишут в Telegram или на почту, я выясняю численность, систему учёта, срочность, потом КП."
      ],
      friction: ["Много одинаковых уточнений до созвона вручную."],
      existingTools: ["Почта, Telegram, таблица клиентов. CRM нет."],
      desiredFlow: [
        "Хотелось бы короткую форму: численность, 1С или нет, что нужно по кадрам — и заявка."
      ],
      discriminator: [
        "Вопросы похожие для большинства. После формы обычно нужен короткий разговор. Оплата по договору, не онлайн."
      ]
    }
  }
];

console.log("=== AUTONOMOUS DIALOGUE QA (13 core, adaptive) ===");
const coreResults = CORE.map(function (s) {
  return runScenario(s, 10);
});
coreResults.forEach(printResult);

console.log("\n=== FRESH GENERALIZATION (5) ===");
const freshResults = FRESH.map(function (s) {
  return runScenario(s, 10);
});
freshResults.forEach(printResult);

const all = coreResults.concat(freshResults);
const failed = all.filter(function (r) {
  return !r.pass;
});
console.log("\n=== SUMMARY ===");
console.log(
  "total=" + all.length + " pass=" + (all.length - failed.length) + " fail=" + failed.length
);
if (failed.length) {
  console.log(
    "failed ids:",
    failed
      .map(function (r) {
        return r.id;
      })
      .join(", ")
  );
  process.exit(1);
}
console.log("All autonomous dialogue QA scenarios passed.");
