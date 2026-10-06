/**
 * FINAL LIVE ACCEPTANCE — real TEST Worker (Yandex), no product code changes.
 * Usage: node scripts/_live-acceptance.mjs
 */
import { writeFileSync } from "fs";

const API =
  process.env.SMOKE_API_URL ||
  "https://smart-brief-api-test.ezhevskaya.workers.dev/api/chat";
const ORIGIN = process.env.SMOKE_ORIGIN || "https://ezhevskaya.ru";

async function chat(sessionId, message, history, briefState) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN
        },
        body: JSON.stringify({
          sessionId,
          message,
          history,
          briefState
        })
      });
      const raw = await res.text();
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        console.error("bad_json body", String(raw || "").slice(0, 240));
        lastErr = new Error("bad_json:" + res.status);
        await sleep(2000 * attempt);
        continue;
      }
      return { status: res.status, payload };
    } catch (err) {
      lastErr = err;
      console.error("fetch retry", attempt, String(err && err.message || err));
      await sleep(1500 * attempt);
    }
  }
  return {
    status: 0,
    payload: { ok: false, error: "fetch_failed", message: String(lastErr && lastErr.message || lastErr) }
  };
}

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

/**
 * Adaptive answers keyed by rough question intent detected from Mark's text.
 * New natural wording — not regression fixtures.
 */
function answerFor(markText, bank, used) {
  const t = String(markText || "").toLowerCase();
  let key = "default";
  if (/чем\s+именно|о\s+вашем\s+бизнесе|что\s+предлагаете/.test(t)) key = "business";
  else if (/какого\s+результата|что\s+должно\s+измениться|какую\s+задач/.test(t)) key = "goal";
  else if (/кто\s+(?:чаще|обычно)|основные\s+(?:клиент|покупател|ученик|гост)|останавливается|покупает/.test(t))
    key = "who";
  else if (/важнее\s+всего|что\s+для\s+(?:этих|них|гостей|клиентов)|при\s+выборе/.test(t))
    key = "matters";
  else if (/следующий\s+шаг|как\s+обычно\s+проходит|путь\s+клиента|что\s+происходит\s+дальше|как\s+доходит/.test(t))
    key = "journey";
  else if (/теряется\s+время|где\s+сейчас\s+больше/.test(t)) key = "friction";
  else if (/помимо|инструмент|таблиц|crm|календар|ведёте|пользуетесь/.test(t)) key = "tools";
  else if (/как\s+бы\s+вы\s+хотели|в\s+идеале|идеальный\s+первый/.test(t)) key = "flow";
  else if (/оплат|предоплат|стабильн|расписан|преподавател|мест\s|одинаков|предварительн/.test(t))
    key = "disc";

  const pool = [].concat(bank[key] || [], bank.disc || [], bank.default || []);
  for (let i = 0; i < pool.length; i += 1) {
    const a = pool[i];
    if (a && !used[a]) {
      used[a] = true;
      return a;
    }
  }
  return (
    bank.fallback ||
    "Могу добавить: почти всё сейчас вручную, хочу упростить первый контакт без лишней сложности."
  );
}

async function runScenario(scenario) {
  const sid = "live-acc-" + scenario.id + "-" + Date.now();
  const transcript = [];
  const used = Object.create(null);
  let history = [];
  let briefState = null;
  let message = scenario.open;
  let lastMark = "";
  let recommend = null;
  const markQuestions = [];

  for (let turn = 0; turn < 12; turn += 1) {
    if (turn > 0) await sleep(800);
    const r = await chat(sid, message, history, briefState);
    const p = r.payload || {};
    const mark = String(p.assistantMessage || "");
    const phase = p.phase || "";
    transcript.push({ role: "user", text: message });
    transcript.push({
      role: "mark",
      text: mark,
      phase: phase,
      http: r.status,
      ok: p.ok
    });

    if (!p.ok || r.status !== 200) {
      return {
        id: scenario.id,
        domain: scenario.domain,
        transcript,
        ended: "error",
        error: p.error || p.message || ("http_" + r.status)
      };
    }

    history = history.concat([
      { role: "user", content: message },
      { role: "assistant", content: mark }
    ]);
    if (p.briefState) briefState = p.briefState;

    if (phase === "recommend" || phase === "handoff") {
      recommend = mark;
      break;
    }

    // track clarify questions for repeat detection
    markQuestions.push(mark);
    lastMark = mark;
    message = answerFor(mark, scenario.answers, used);
  }

  return {
    id: scenario.id,
    domain: scenario.domain,
    transcript,
    recommend,
    markQuestions,
    ended: recommend ? "recommend" : "no_recommend"
  };
}

const SCENARIOS = [
  {
    id: "1_b2b_tax_advisor",
    domain: "professional/B2B",
    open:
      "Я консультирую небольшие компании по налогам и отчётности. Обычно ко мне приходят по рекомендации знакомых и сначала пишут в Telegram.",
    answers: {
      business: [
        "Я налоговый консультант для малого бизнеса: помогаю с отчётностью, выбором режима и сопровождением проверок. Работаю удалённо."
      ],
      goal: [
        "Хочу тратить меньше времени на первое знакомство: сейчас каждому отдельно рассказываю, чем могу помочь, какие документы нужны и примерно сколько стоит сопровождение."
      ],
      who: [
        "Чаще всего это собственники маленьких ООО и ИП, иногда главбухи, которые ищут внешнего специалиста."
      ],
      matters: [
        "Для них важно, что я реально разбираюсь в их схеме, отвечаю быстро и сразу понятно, что входит в услугу и какая вилка по цене."
      ],
      journey: [
        "Человек пишет в Telegram коротко про задачу. Я уточняю форму бизнеса, систему налогообложения и что именно нужно. Потом объясняю формат работы, называю ориентир по стоимости. Если подходим друг другу — запрашиваю документы и переходим к договору."
      ],
      friction: [
        "Самое энергозатратное — повторять одни и те же пояснения про услуги и входные данные в каждой новой переписке."
      ],
      tools: [
        "Отдельной CRM нет. Переписка в Telegram, ключевые детали иногда заношу в заметки или Google-таблицу. Заявки нигде отдельно не копятся."
      ],
      flow: [
        "Хотелось бы, чтобы человек сначала сам прочитал, какие задачи я беру и на каких условиях, ответил на несколько вопросов о бизнесе, и я уже до созвона понимала, подходит ли обращение."
      ],
      disc: [
        "Набор уточняющих вопросов в целом похож для большинства. После такого сбора данных почти всегда нужен короткий личный разговор. Оплата по договору, онлайн не требуется."
      ],
      default: [
        "Сейчас всё держится на ручной переписке; хочу более спокойный и понятный вход для новых обращений."
      ]
    }
  },
  {
    id: "2_pilates_studio",
    domain: "studio/scheduling",
    open:
      "Держу небольшую студию пилатеса. Люди находят нас в Instagram, а запись на занятия администратор делает вручную в переписке.",
    answers: {
      business: [
        "Это студия группового и персонального пилатеса: несколько залов, занятия по расписанию, запись через администратора."
      ],
      goal: [
        "Нужно упростить запись: сейчас администратор по полдня отвечает на вопросы про время, свободные места и уровень группы."
      ],
      who: [
        "В основном женщины 28–45 лет, кто-то новичок, кто-то уже ходит регулярно."
      ],
      matters: [
        "Им важно удобное время, понятная стоимость абонемента и чтобы не ждать ответа часами."
      ],
      journey: [
        "Смотрят Instagram, пишут в Direct. Администратор рассказывает про занятия и окна, смотрит занятость в таблице и записывает человека вручную."
      ],
      friction: [
        "Много однотипной переписки про расписание и места — из-за этого запись тормозит."
      ],
      tools: [
        "CRM нет. Есть Google-таблица и общий календарь, плюс Instagram и WhatsApp. Онлайн-записи как сервиса нет."
      ],
      flow: [
        "Хочу, чтобы человек сам видел актуальное расписание и мог записаться на занятие без долгой переписки."
      ],
      disc: [
        "Онлайн-оплата пока не обязательна — достаточно записи. Расписание меняется довольно часто, ведут несколько инструкторов, места в группах ограничены."
      ],
      default: [
        "Пока достаточно простой записи без онлайн-оплаты; главное — снять ручную координацию слотов."
      ]
    }
  },
  {
    id: "3_sea_apartments",
    domain: "lodging",
    open:
      "Сдаём несколько апартаментов у моря посуточно. Гости чаще приходят из соцсетей и Авито, а подтверждение дат я сейчас собираю вручную в переписке.",
    answers: {
      business: [
        "Сдаём посуточно несколько апартаментов у моря: заселение, уборка и подтверждение дат — на нашей стороне."
      ],
      goal: [
        "Хочу меньше отвечать на одни и те же вопросы про даты, заезд и предоплату и быстрее закрывать бронь."
      ],
      who: [
        "Чаще пары и семьи с детьми, обычно на выходные или короткий отпуск."
      ],
      matters: [
        "Им важны чистота, расстояние до моря, понятные фото и чтобы сразу было ясно по цене и свободным датам."
      ],
      journey: [
        "Смотрят объявление или профиль, пишут в WhatsApp. Я уточняю даты и состав гостей, проверяю занятость, называю стоимость. Если всё ок — беру предоплату и подтверждаю бронь."
      ],
      friction: [
        "Много ручных ответов про наличие дат и условия — на это уходит вечер почти каждый день."
      ],
      tools: [
        "Есть модуль онлайн-бронирования с календарём, плюс WhatsApp. Своего нормального сайта почти нет, гостей веду ещё в таблице."
      ],
      flow: [
        "В идеале гость сам смотрит свободные даты и бронирует, а мне остаётся только подтверждение и заселение."
      ],
      disc: [
        "Предоплата при бронировании нужна. Занятость меняется часто в сезон."
      ],
      default: [
        "Главное — чтобы гость мог сам понять доступность и оставить бронь без долгой переписки."
      ]
    }
  },
  {
    id: "4_bike_workshop",
    domain: "retail/service",
    open:
      "У меня мастерская по ремонту и обслуживанию велосипедов. Клиенты обычно пишут в WhatsApp или заходят с улицы, запись на ремонт веду в блокноте.",
    answers: {
      business: [
        "Мастерская: ремонт, ТО и мелкий тюнинг велосипедов, работаем с городскими райдерами и родителями."
      ],
      goal: [
        "Хочу меньше хаоса в заявках: сейчас сложно понять, кто на когда записан и что именно нужно сделать с великом."
      ],
      who: [
        "Городские велосипедисты и родители детей — возраст примерно 20–45."
      ],
      matters: [
        "Им важны срок готовности, понятная цена ремонта и чтобы велик не «потерялся» в очереди."
      ],
      journey: [
        "Человек пишет или заходит, описывает проблему. Я смотрю загрузку, называю срок и цену, записываю в блокнот, потом ремонтирую и отдаю."
      ],
      friction: [
        "Путаница в очередях и повторные сообщения «ну что там с моим?» — всё вручную."
      ],
      tools: [
        "Только WhatsApp, телефон и бумажный блокнот. Ни сайта, ни CRM."
      ],
      flow: [
        "Хотелось бы, чтобы человек оставлял заявку с описанием поломки и удобным днём, а я видела очередь в одном месте."
      ],
      disc: [
        "Онлайн-оплата не нужна, расчёт на месте. Поток относительно ровный, без резких скачков каждую неделю."
      ],
      default: [
        "Нужен более спокойный приём заявок без блокнота и бесконечных уточнений в чате."
      ]
    }
  },
  {
    id: "5_home_tutor_unclear",
    domain: "unknown/generic",
    open:
      "Я помогаю школьникам подтянуть математику. Родители находят меня через знакомых и пишут в WhatsApp. Сама не уверена, что мне лучше сделать — сайт, бота или что-то проще.",
    answers: {
      business: [
        "Репетитор по математике для школьников: индивидуальные занятия, помогаю подтянуть программу и подготовку к контрольным."
      ],
      goal: [
        "Хочу, чтобы до переписки было понятно, с какими классами я работаю и как проходит занятие, и чтобы заявка приходила уже с базовыми вводными."
      ],
      who: [
        "Обычно родители детей 5–9 класса, иногда сами подростки."
      ],
      matters: [
        "Им важны спокойный темп, понятная цена абонемента и чтобы ребёнку было не страшно ошибаться."
      ],
      journey: [
        "Пишут в WhatsApp, я рассказываю про формат, уточняю класс и цели, подбираю время, потом начинаем. Оплату обсуждаем уже в переписке."
      ],
      friction: [
        "Каждому родителю заново объясняю одно и то же про формат и цены — это утомляет."
      ],
      tools: [
        "WhatsApp и простая таблица с учениками. Отдельной записи или CRM нет."
      ],
      flow: [
        "Пусть родитель сам посмотрит, кому я подхожу, выберет удобный слот пробного и оставит короткое описание задачи ребёнка."
      ],
      disc: [
        "Оплата после пробного, не онлайн сразу. Расписание довольно стабильное, веду занятия сама."
      ],
      default: [
        "Не хочу сложную систему — достаточно понятного входа и меньше повторов в переписке."
      ]
    }
  }
];

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function analyze(result) {
  const notes = [];
  const soft = [];
  let verdict = "PASS";
  const marks = result.transcript.filter(function (t) {
    return t.role === "mark";
  });
  const clarifies = marks.filter(function (t) {
    return t.phase !== "recommend" && t.phase !== "handoff";
  });

  if (result.ended !== "recommend") {
    notes.push("Не дошли до recommendation: " + result.ended + (result.error ? " / " + result.error : ""));
    verdict = "FAIL";
  }

  // exact repeats among clarify turns
  const seen = Object.create(null);
  const repeats = [];
  for (let i = 0; i < clarifies.length; i += 1) {
    const n = norm(clarifies[i].text);
    // strip welcome prefix for comparison of question tail
    const q = n.replace(/^здравствуйте.*?\. /, "");
    if (seen[q]) repeats.push({ turn: i + 1, text: clarifies[i].text.slice(0, 120) });
    seen[q] = true;
  }
  if (repeats.length) {
    notes.push("Exact/semantic clarify repeat(s): " + repeats.map(function (r) {
      return "T" + r.turn + " «" + r.text + "…»";
    }).join("; "));
    verdict = "FAIL";
  }

  // discriminator-ish repeats (payment/schedule asked twice)
  const discIdx = [];
  for (let i = 0; i < clarifies.length; i += 1) {
    if (/оплат|расписан|стабильн|предоплат|мест[аеу]?\s|преподавател|одинаков.*вопрос/i.test(clarifies[i].text)) {
      discIdx.push(i + 1);
    }
  }
  if (discIdx.length > 1) {
    notes.push("Несколько discriminator-подобных вопросов: turns " + discIdx.join(", "));
    if (verdict === "PASS") verdict = "SOFT ISSUE";
  }

  // domain leaks
  const blob = marks.map(function (m) {
    return m.text;
  }).join(" \n ");
  if (result.domain.indexOf("B2B") !== -1 || result.domain.indexOf("professional") !== -1 || result.domain.indexOf("generic") !== -1 || result.domain.indexOf("retail") !== -1) {
    if (/(?:^|[^а-яё])гост(?:ь|я|ю|ем|и|ей)/i.test(" " + blob) && result.domain.indexOf("lodging") === -1) {
      // allow гостевой? no - guest person
      if (!/гостев/i.test(blob) || /гостю|гостя|гости\b/i.test(blob)) {
        notes.push("Possible guest vocabulary outside lodging");
        verdict = "FAIL";
      }
    }
    if (/брон(?:ь|и|ю|ирован)/i.test(blob) && result.domain.indexOf("lodging") === -1 && result.domain.indexOf("studio") === -1) {
      notes.push("Possible booking vocabulary leak");
      if (verdict !== "FAIL") verdict = "SOFT ISSUE";
    }
  }
  if (result.domain.indexOf("studio") !== -1 || result.domain.indexOf("generic") !== -1 || result.domain.indexOf("B2B") !== -1) {
    // lodging guest leak already covered
  }

  // compound / leading
  for (let i = 0; i < clarifies.length; i += 1) {
    const t = clarifies[i].text;
    if ((t.match(/\?/g) || []).length >= 2 && /и\s+что|и\s+кто|и\s+как/.test(t)) {
      soft.push("Возможно compound на clarify T" + (i + 1));
      if (verdict === "PASS") verdict = "SOFT ISSUE";
    }
    if (/мог бы сделать сам|оставить заявку, верно/i.test(t)) {
      notes.push("Leading question T" + (i + 1));
      verdict = "FAIL";
    }
  }

  // business/goal re-ask after substantial answer
  let askedBusiness = 0;
  let askedGoal = 0;
  for (let i = 0; i < clarifies.length; i += 1) {
    if (/чем\s+именно|о\s+вашем\s+бизнесе|что\s+предлагаете/.test(clarifies[i].text)) askedBusiness += 1;
    if (/какого\s+результата/.test(clarifies[i].text)) askedGoal += 1;
  }
  if (askedBusiness > 1) {
    notes.push("Повтор BUSINESS-вопроса (" + askedBusiness + ")");
    verdict = "FAIL";
  }
  if (askedGoal > 1) {
    notes.push("Повтор GOAL-вопроса (" + askedGoal + ")");
    verdict = "FAIL";
  }

  // recommendation quality
  let recNotes = [];
  if (result.recommend) {
    const rec = result.recommend;
    if (rec.length < 100) recNotes.push("Слишком короткая");
    if (/не удалось безопасно/i.test(rec)) {
      recNotes.push("READY_FALLBACK вместо рекомендации");
      verdict = "FAIL";
    }
    const grounded =
      /telegram|whatsapp|таблиц|вручную|расписан|мест|преподавател|инструктор|апартамент|предоплат|блокнот|ремонт|налог|отчётн|абонемент|instagram|заявк|переписк/i.test(
        rec
      );
    if (!grounded) {
      recNotes.push("Слабая привязка к фактам диалога");
      if (verdict === "PASS") verdict = "SOFT ISSUE";
    }
    if (/вам подойдёт онлайн-система,\s*которая упростит работу/i.test(rec)) {
      recNotes.push("Generic online-system dump");
      verdict = "FAIL";
    }
    const websiteBias =
      /нужен сайт|сделайте сайт|сайт — единствен/i.test(rec) &&
      !/не\s+«?просто сайт|не сайт ради сайта|не\s+строить/i.test(rec);
    if (websiteBias) {
      recNotes.push("Website-by-default сигнал");
      if (verdict === "PASS") verdict = "SOFT ISSUE";
    }
    if (!/альтернатив|вместо|можно сначала|либо |вариант/i.test(rec)) {
      soft.push("В recommendation слабо виден alternative class");
      if (verdict === "PASS") verdict = "SOFT ISSUE";
    }
  }

  if (soft.length && verdict === "PASS") verdict = "SOFT ISSUE";

  return {
    verdict,
    notes: notes.concat(soft),
    repeats,
    discTurns: discIdx,
    recNotes
  };
}

const results = [];
for (let i = 0; i < SCENARIOS.length; i += 1) {
  console.error("Running " + SCENARIOS[i].id + " ...");
  try {
    const r = await runScenario(SCENARIOS[i]);
    const a = analyze(r);
    r.analysis = a;
    results.push(r);
  } catch (err) {
    results.push({
      id: SCENARIOS[i].id,
      domain: SCENARIOS[i].domain,
      transcript: [],
      ended: "crash",
      error: String(err && err.message || err),
      analysis: { verdict: "FAIL", notes: ["crash: " + String(err && err.message || err)], repeats: [], discTurns: [], recNotes: [] }
    });
  }
  await sleep(2000);
}

writeFileSync("scripts/_live-acceptance-out.json", JSON.stringify(results, null, 2), "utf8");
console.log(JSON.stringify(results, null, 2));
