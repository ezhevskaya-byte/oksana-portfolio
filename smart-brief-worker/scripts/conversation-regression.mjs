/**
 * Deterministic multi-niche conversation regressions (no OpenAI).
 * Run: node scripts/conversation-regression.mjs
 */
import {
  mergeBriefCoverage,
  evaluateBriefReady,
  resolveClarifyTarget,
  selectClarifyMessage,
  selectFirstTurnMessage,
  buildFirstTurnWelcome,
  buildUserTurns,
  isDesiredFlowSufficient,
  isCustomerJourneySufficient,
  isExistingToolsSufficient,
  isAudienceWhoEvidence,
  encodeBriefState,
  parseBriefState,
  enforceGates,
  applySupersedePolicy,
  countLowEngagementStreak
} from "../src/gate.js";

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("ok  -", name);
  else {
    failed += 1;
    console.error("FAIL -", name);
  }
}

function src(turnId, quote, aspect, operation) {
  return {
    turnId,
    quote,
    aspect,
    operation: operation === "replace" ? "replace" : "support"
  };
}
function field(status, sources) {
  return { status, sources: sources || [] };
}
function emptyCoverage() {
  return {
    business: field("unknown", []),
    goal: field("unknown", []),
    audienceInput: field("unknown", []),
    customerJourney: field("unknown", []),
    friction: field("unknown", []),
    existingTools: field("unknown", []),
    desiredFlow: field("unknown", [])
  };
}

const FOCUS = {
  audience: "Кто чаще всего к вам обращается, и что этим людям обычно важно при выборе?",
  flow: "В идеале что клиент должен иметь возможность сделать сам, и что должно стать проще для вас?",
  journey:
    "Как сейчас обычно проходит путь клиента: от первого знакомства до заявки или покупки?"
};

const KEYS = [
  "business",
  "goal",
  "audienceInput",
  "customerJourney",
  "friction",
  "existingTools",
  "desiredFlow"
];

function runNiche(name, steps) {
  console.log("\n=== NICHE", name, "===");
  let history = [];
  let priorState = null;
  const closed = Object.create(null);
  let reachedReady = false;

  const first = steps[0].message;
  const welcome = buildFirstTurnWelcome(first);
  const firstOut = selectFirstTurnMessage(
    {
      clarifyFallbackMessage: welcome,
      assistantMessage: welcome,
      phase: "clarify",
      recommendationMode: "none",
      expertPlan: null
    },
    first
  );
  if (steps[0].expectAck) {
    assert(name + " FIRST ack", /учёл|не буду просить/i.test(firstOut));
    assert(name + " FIRST no retell", !/Расскажите своими словами/i.test(firstOut));
  } else {
    assert(name + " FIRST free discovery", /не анкета|своими словами/i.test(firstOut));
  }
  assert(name + " FIRST identity", /Марк/i.test(firstOut));

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const message = step.message;
    const turnsBuilt = buildUserTurns(history, message);
    const modelCoverage = Object.assign(emptyCoverage(), step.modelSources || {});
    const merged = mergeBriefCoverage(priorState, modelCoverage, turnsBuilt);
    priorState = merged.briefState;
    const coverage = merged.coverage;
    const ready = evaluateBriefReady(coverage, turnsBuilt);
    const target = resolveClarifyTarget(ready.missing, coverage, turnsBuilt);

    for (let k = 0; k < KEYS.length; k += 1) {
      if (coverage[KEYS[k]].status === "known") closed[KEYS[k]] = true;
    }

    if (closed.business) assert(name + " T" + (i + 1) + " no-repeat BUSINESS", target.focus !== "business");
    if (closed.goal) assert(name + " T" + (i + 1) + " no-repeat GOAL", target.focus !== "goal");
    if (closed.audienceInput) {
      assert(name + " T" + (i + 1) + " no-repeat AUDIENCE", target.focus !== "audienceInput");
    }
    if (closed.customerJourney) {
      assert(name + " T" + (i + 1) + " no-repeat JOURNEY", target.focus !== "customerJourney");
    }
    if (closed.existingTools) {
      assert(name + " T" + (i + 1) + " no-repeat TOOLS", target.focus !== "existingTools");
    }
    if (closed.desiredFlow) {
      assert(name + " T" + (i + 1) + " no-repeat FLOW", target.focus !== "desiredFlow");
      const blocked = selectClarifyMessage(
        {
          nextInformationNeed: { focus: "desiredFlow", reason: "insist" },
          clarifyFallbackMessage: FOCUS.flow
        },
        ready.missing,
        coverage,
        turnsBuilt
      );
      assert(name + " T" + (i + 1) + " block FLOW_FOCUS", blocked !== FOCUS.flow);
    }

    if (step.expectKnown) {
      for (let e = 0; e < step.expectKnown.length; e += 1) {
        const key = step.expectKnown[e];
        assert(
          name + " T" + (i + 1) + " known " + key,
          coverage[key] && coverage[key].status === "known"
        );
      }
    }

    if (ready.ready) {
      reachedReady = true;
      const plan = {
        realProblem: "Повторяющиеся вопросы до контакта и слабый прямой канал",
        audienceHypothesis: "Типичные клиенты уже описаны в диалоге",
        primarySolution: "Компактный сайт/витрина с переиспользованием текущего стека",
        alternative: "Сначала усилить FAQ в мессенджере — слабее для доверия",
        whyPrimary: "Снимает трение до обращения без лишней сложности",
        reuseNote: "Переиспользовать уже названные инструменты",
        startNow: "Минимальная витрина с ключевой информацией и заявкой",
        addLater: "Контент и сегментные акценты",
        doNotBuildYet: "Не строить сложную платформу с нуля",
        insight: "Главный рычаг — информирование до диалога, а не «просто сайт»"
      };
      const gates = enforceGates(
        {
          briefCoverage: coverage,
          recommendationMode: "normal",
          phase: "recommend",
          expertPlan: plan,
          assistantMessage:
            "Рекомендую начать с компактной витрины: ключевая информация и простая заявка. " +
            "Альтернатива — усилить мессенджер. Сейчас не нужно строить сложную платформу. Переиспользуем текущий стек.",
          clarifyFallbackMessage: "",
          nextInformationNeed: { focus: "none", reason: "" },
          lowEngagement: false,
          done: true
        },
        { history, message }
      );
      assert(
        name + " recommend path",
        gates.action === "allow" &&
          gates.publicTurn &&
          gates.publicTurn.phase === "recommend"
      );
    }

    history.push({ role: "user", content: message });
    history.push({
      role: "assistant",
      content:
        i === 0
          ? firstOut
          : target.focus
            ? selectClarifyMessage(
                {
                  nextInformationNeed: { focus: target.focus, reason: "" },
                  clarifyFallbackMessage: FOCUS[target.focus] || FOCUS.audience
                },
                ready.missing,
                coverage,
                turnsBuilt
              )
            : "Понял, спасибо."
    });
  }

  assert(name + " closed enough", Object.keys(closed).length >= 4 || reachedReady);
  return { closed, reachedReady };
}

const teacherFlow =
  "Но хотелось бы, чтобы до переписки человек уже мог понять, кому и с какими задачами я помогаю, как проходят занятия, " +
  "примерно сколько это стоит, получить ответы на основные вопросы и, если ему подходит мой формат, оставить заявку " +
  "или выбрать время для пробного занятия. Тогда в личном общении мне уже не пришлось бы каждый раз заново рассказывать одно и то же.";

const teacherJourney =
  "Обычно человек пишет мне в WhatsApp или Instagram. Я выясняю цель и уровень, предлагаю формат занятий, " +
  "обсуждаем расписание и оплату. Иногда предлагаю пробное занятие. Если всё подходит — договариваемся и начинаем работать.";

runNiche("teacher", [
  {
    message:
      "Здравствуйте. Я частный преподаватель английского для взрослых. Сейчас почти все ученики приходят через сарафан " +
      "и личные сообщения, и мне приходится каждому заново рассказывать про формат и цены. Хочу сайт, чтобы человек заранее " +
      "понимал мой подход и мог оставить заявку.",
    expectAck: true,
    modelSources: {
      business: field("known", [
        src("u1", "Я частный преподаватель английского для взрослых", "what_business")
      ]),
      goal: field("known", [
        src(
          "u1",
          "Хочу сайт, чтобы человек заранее понимал мой подход и мог оставить заявку",
          "desired_outcome"
        )
      ]),
      friction: field("known", [
        src(
          "u1",
          "мне приходится каждому заново рассказывать про формат и цены",
          "pain"
        )
      ])
    },
    expectKnown: ["business", "goal", "friction"]
  },
  {
    message:
      "Чаще всего ко мне обращаются взрослые 25–45 лет, которые готовятся к переезду или работе. Им важно понять мой метод, " +
      "формат занятий и примерно стоимость до первой переписки.",
    modelSources: {
      audienceInput: field("known", [
        src(
          "u2",
          "Чаще всего ко мне обращаются взрослые 25–45 лет, которые готовятся к переезду или работе",
          "who_or_segment"
        ),
        src(
          "u2",
          "Им важно понять мой метод, формат занятий и примерно стоимость до первой переписки",
          "what_matters"
        )
      ])
    },
    expectKnown: ["audienceInput"]
  },
  {
    message: teacherJourney,
    modelSources: {
      customerJourney: field("known", [src("u3", teacherJourney, "path_steps")])
    },
    expectKnown: ["customerJourney"]
  },
  {
    message:
      "Сайта нет. Веду записи в Google Таблице, общаюсь в WhatsApp и Instagram. CRM и бота нет, всё вручную.",
    modelSources: {
      existingTools: field("known", [
        src(
          "u4",
          "Сайта нет. Веду записи в Google Таблице, общаюсь в WhatsApp и Instagram. CRM и бота нет, всё вручную",
          "tools"
        )
      ])
    },
    expectKnown: ["existingTools"]
  },
  {
    message: teacherFlow,
    modelSources: {
      desiredFlow: field("known", [src("u5", teacherFlow, "ideal_flow")])
    },
    expectKnown: ["desiredFlow"]
  }
]);

runNiche("flowers", [
  {
    message:
      "Добрый день. У меня цветочная студия в городе, делаем букеты и оформление. Сейчас заказы в основном из Instagram и по телефону, " +
      "хочется свой сайт с доставкой и чтобы меньше отвечать на одни и те же вопросы про состав и цены.",
    expectAck: true,
    modelSources: {
      business: field("known", [
        src("u1", "У меня цветочная студия в городе, делаем букеты и оформление", "what_business")
      ]),
      goal: field("known", [
        src(
          "u1",
          "хочется свой сайт с доставкой и чтобы меньше отвечать на одни и те же вопросы про состав и цены",
          "desired_outcome"
        )
      ]),
      friction: field("known", [
        src("u1", "меньше отвечать на одни и те же вопросы про состав и цены", "pain")
      ])
    },
    expectKnown: ["business", "goal"]
  },
  {
    message:
      "Обычно заказывают женщины 25–50 лет — на день рождения, свидания, корпоративы. Им важно увидеть фото свежих работ, понять цену и зону доставки.",
    modelSources: {
      audienceInput: field("known", [
        src(
          "u2",
          "Обычно заказывают женщины 25–50 лет — на день рождения, свидания, корпоративы",
          "who_or_segment"
        ),
        src(
          "u2",
          "Им важно увидеть фото свежих работ, понять цену и зону доставки",
          "what_matters"
        )
      ])
    },
    expectKnown: ["audienceInput"]
  },
  {
    message:
      "Люди находят нас в Instagram, смотрят работы, пишут в директ или звонят. Мы уточняем повод и бюджет, предлагаем варианты, " +
      "согласовываем доставку, потом оплата и сборка букета.",
    modelSources: {
      customerJourney: field("known", [
        src(
          "u3",
          "Люди находят нас в Instagram, смотрят работы, пишут в директ или звонят. Мы уточняем повод и бюджет, предлагаем варианты, согласовываем доставку, потом оплата и сборка букета",
          "path_steps"
        )
      ])
    },
    expectKnown: ["customerJourney"]
  },
  {
    message:
      "Сайта нормального нет. Есть Instagram, WhatsApp и таблица заказов в Excel. Хотим, чтобы человек сам выбрал букет, увидел зоны доставки и оставил заказ.",
    modelSources: {
      existingTools: field("known", [
        src(
          "u4",
          "Сайта нормального нет. Есть Instagram, WhatsApp и таблица заказов в Excel",
          "tools"
        )
      ]),
      desiredFlow: field("known", [
        src(
          "u4",
          "Хотим, чтобы человек сам выбрал букет, увидел зоны доставки и оставил заказ",
          "ideal_flow"
        )
      ])
    },
    expectKnown: ["existingTools", "desiredFlow"]
  }
]);

runNiche("freight", [
  {
    message:
      "Здравствуйте. Занимаемся грузоперевозками по городу и области. Заявки приходят в WhatsApp и по звонкам, всё считаем вручную. " +
      "Нужен сайт, чтобы клиент мог оставить заявку с маршрутом и примерно понять условия.",
    expectAck: true,
    modelSources: {
      business: field("known", [
        src("u1", "Занимаемся грузоперевозками по городу и области", "what_business")
      ]),
      goal: field("known", [
        src(
          "u1",
          "Нужен сайт, чтобы клиент мог оставить заявку с маршрутом и примерно понять условия",
          "desired_outcome"
        )
      ]),
      friction: field("known", [
        src("u1", "Заявки приходят в WhatsApp и по звонкам, всё считаем вручную", "pain")
      ])
    },
    expectKnown: ["business", "goal"]
  },
  {
    message:
      "Клиенты — небольшие магазины и частники, которым нужно перевезти мебель или товар. Им важно скорость ответа, понятная цена и аккуратность.",
    modelSources: {
      audienceInput: field("known", [
        src(
          "u2",
          "Клиенты — небольшие магазины и частники, которым нужно перевезти мебель или товар",
          "who_or_segment"
        ),
        src(
          "u2",
          "Им важно скорость ответа, понятная цена и аккуратность",
          "what_matters"
        )
      ])
    },
    expectKnown: ["audienceInput"]
  },
  {
    message:
      "Обычно человек звонит или пишет в WhatsApp, описывает груз и адрес. Мы уточняем детали, называем стоимость, если подходит — приезжаем, грузим, везём, принимаем оплату.",
    modelSources: {
      customerJourney: field("known", [
        src(
          "u3",
          "Обычно человек звонит или пишет в WhatsApp, описывает груз и адрес. Мы уточняем детали, называем стоимость, если подходит — приезжаем, грузим, везём, принимаем оплату",
          "path_steps"
        )
      ])
    },
    expectKnown: ["customerJourney"]
  },
  {
    message:
      "Из инструментов только телефон и WhatsApp. CRM нет, ни системы бронирования, ни таблиц, ни бота — всё вручную. " +
      "Хотелось бы, чтобы клиент сам оставил заявку с маршрутом и объёмом, а мы уже уточняли детали.",
    modelSources: {
      existingTools: field("known", [
        src(
          "u4",
          "Из инструментов только телефон и WhatsApp. CRM нет, ни системы бронирования, ни таблиц, ни бота — всё вручную",
          "tools"
        )
      ]),
      desiredFlow: field("known", [
        src(
          "u4",
          "Хотелось бы, чтобы клиент сам оставил заявку с маршрутом и объёмом, а мы уже уточняли детали",
          "ideal_flow"
        )
      ])
    },
    expectKnown: ["existingTools", "desiredFlow"]
  }
]);

runNiche("guesthouse", [
  {
    message:
      "У меня небольшой гостевой дом в Лазаревском. Хочется меньше зависеть от Авито и снизить переписку по одним и тем же вопросам про цены и удобства.",
    expectAck: true,
    modelSources: {
      business: field("known", [
        src("u1", "У меня небольшой гостевой дом в Лазаревском", "what_business")
      ]),
      goal: field("known", [
        src(
          "u1",
          "Хочется меньше зависеть от Авито и снизить переписку по одним и тем же вопросам",
          "desired_outcome"
        )
      ]),
      friction: field("known", [
        src(
          "u1",
          "снизить переписку по одним и тем же вопросам про цены и удобства",
          "pain"
        )
      ])
    },
    expectKnown: ["business", "goal"]
  },
  {
    message:
      "Чаще всего пары 30–45 и семьи с ребёнком. Им важно тихо ли вечером, парковка и сразу увидеть свободные даты.",
    modelSources: {
      audienceInput: field("known", [
        src("u2", "Чаще всего пары 30–45 и семьи с ребёнком", "who_or_segment"),
        src(
          "u2",
          "Им важно тихо ли вечером, парковка и сразу увидеть свободные даты",
          "what_matters"
        )
      ])
    },
    expectKnown: ["audienceInput"]
  },
  {
    message:
      "Обычно находят нас на Авито. Смотрят объявление, потом пишут мне или переходят в WhatsApp. Я уточняю даты и количество гостей, проверяю свободные номера, называю стоимость. Если всё подходит, гость переводит предоплату, и я подтверждаю бронь.",
    modelSources: {
      customerJourney: field("known", [
        src(
          "u3",
          "Обычно находят нас на Авито. Смотрят объявление, потом пишут мне или переходят в WhatsApp. Я уточняю даты и количество гостей, проверяю свободные номера, называю стоимость. Если всё подходит, гость переводит предоплату, и я подтверждаю бронь",
          "path_steps"
        )
      ])
    },
    expectKnown: ["customerJourney"]
  },
  {
    message:
      "Занятость веду в системе бронирования с календарём и модулем онлайн-бронирования. Хочу, чтобы гость сам посмотрел номера, цены и свободные даты и мог оформить бронь.",
    modelSources: {
      existingTools: field("known", [
        src(
          "u4",
          "Занятость веду в системе бронирования с календарём и модулем онлайн-бронирования",
          "tools"
        )
      ]),
      desiredFlow: field("known", [
        src(
          "u4",
          "Хочу, чтобы гость сам посмотрел номера, цены и свободные даты и мог оформить бронь",
          "ideal_flow"
        )
      ])
    },
    expectKnown: ["existingTools", "desiredFlow"]
  }
]);

runNiche("shop", [
  {
    message:
      "У меня небольшой интернет-магазин домашнего текстиля. Продаём через Instagram и Avito, своего нормального сайта почти нет. " +
      "Хочу, чтобы люди сами смотрели каталог и оформляли заказ без долгой переписки.",
    expectAck: true,
    modelSources: {
      business: field("known", [
        src("u1", "У меня небольшой интернет-магазин домашнего текстиля", "what_business")
      ]),
      goal: field("known", [
        src(
          "u1",
          "Хочу, чтобы люди сами смотрели каталог и оформляли заказ без долгой переписки",
          "desired_outcome"
        )
      ]),
      friction: field("known", [
        src("u1", "оформляли заказ без долгой переписки", "pain")
      ])
    },
    expectKnown: ["business", "goal"]
  },
  {
    message:
      "Покупатели — женщины 30–55 лет, обновляют спальню. Им важны фото тканей, размеры и доставка по России.",
    modelSources: {
      audienceInput: field("known", [
        src("u2", "Покупатели — женщины 30–55 лет, обновляют спальню", "who_or_segment"),
        src(
          "u2",
          "Им важны фото тканей, размеры и доставка по России",
          "what_matters"
        )
      ])
    },
    expectKnown: ["audienceInput"]
  },
  {
    message:
      "Находят в Instagram или Avito, смотрят фото, пишут в директ. Мы уточняем размер и цвет, считаем доставку, принимаем оплату, отправляем.",
    modelSources: {
      customerJourney: field("known", [
        src(
          "u3",
          "Находят в Instagram или Avito, смотрят фото, пишут в директ. Мы уточняем размер и цвет, считаем доставку, принимаем оплату, отправляем",
          "path_steps"
        )
      ])
    },
    expectKnown: ["customerJourney"]
  },
  {
    message:
      "Есть Instagram, WhatsApp и таблица заказов. CRM нет. Хотелось бы, чтобы человек сам выбрал товар, увидел условия доставки и оформил заказ.",
    modelSources: {
      existingTools: field("known", [
        src("u4", "Есть Instagram, WhatsApp и таблица заказов. CRM нет", "tools")
      ]),
      desiredFlow: field("known", [
        src(
          "u4",
          "Хотелось бы, чтобы человек сам выбрал товар, увидел условия доставки и оформил заказ",
          "ideal_flow"
        )
      ])
    },
    expectKnown: ["existingTools", "desiredFlow"]
  }
]);

runNiche("b2b", [
  {
    message:
      "Мы делаем небольшие партии упаковки для локальных брендов. Сейчас заявки из сарафана и Telegram, много одинаковых вопросов про сроки и MOQ. " +
      "Нужна страница, где клиент сам поймёт формат работы и оставит заявку.",
    expectAck: true,
    modelSources: {
      business: field("known", [
        src(
          "u1",
          "Мы делаем небольшие партии упаковки для локальных брендов",
          "what_business"
        )
      ]),
      goal: field("known", [
        src(
          "u1",
          "Нужна страница, где клиент сам поймёт формат работы и оставит заявку",
          "desired_outcome"
        )
      ]),
      friction: field("known", [
        src("u1", "много одинаковых вопросов про сроки и MOQ", "pain")
      ])
    },
    expectKnown: ["business", "goal"]
  },
  {
    message:
      "Обращаются владельцы небольших брендов косметики и еды. Им важны сроки, минимальный тираж и можно ли сделать пробную партию.",
    modelSources: {
      audienceInput: field("known", [
        src(
          "u2",
          "Обращаются владельцы небольших брендов косметики и еды",
          "who_or_segment"
        ),
        src(
          "u2",
          "Им важны сроки, минимальный тираж и можно ли сделать пробную партию",
          "what_matters"
        )
      ])
    },
    expectKnown: ["audienceInput"]
  },
  {
    message:
      "Обычно пишут в Telegram, мы выясняем задачу и тираж, предлагаем формат и сроки, после предоплаты запускаем производство и отгружаем.",
    modelSources: {
      customerJourney: field("known", [
        src(
          "u3",
          "Обычно пишут в Telegram, мы выясняем задачу и тираж, предлагаем формат и сроки, после предоплаты запускаем производство и отгружаем",
          "path_steps"
        )
      ])
    },
    expectKnown: ["customerJourney"]
  },
  {
    message:
      "Есть Telegram, Google Таблицы для заказов, отдельной CRM нет. Хотим, чтобы клиент сам увидел типовые условия и оставил заявку с тиражом.",
    modelSources: {
      existingTools: field("known", [
        src(
          "u4",
          "Есть Telegram, Google Таблицы для заказов, отдельной CRM нет",
          "tools"
        )
      ]),
      desiredFlow: field("known", [
        src(
          "u4",
          "Хотим, чтобы клиент сам увидел типовые условия и оставил заявку с тиражом",
          "ideal_flow"
        )
      ])
    },
    expectKnown: ["existingTools", "desiredFlow"]
  }
]);

console.log("\n=== CROSS partial / correction / state / low-eng ===");

{
  const who = "Чаще всего ко мне обращаются взрослые 25–40 лет";
  const hist = [
    { role: "user", content: "Я репетитор, нужен сайт." },
    { role: "assistant", content: FOCUS.audience }
  ];
  const turns = buildUserTurns(hist, who);
  const m = mergeBriefCoverage(null, emptyCoverage(), turns);
  assert("PARTIAL audience status", m.coverage.audienceInput.status === "partial");
  const target = resolveClarifyTarget(
    [{ key: "audienceInput", reason: "status_partial" }],
    m.coverage,
    turns
  );
  assert("PARTIAL asks what_matters only", target.aspect === "what_matters");
  const msg = selectClarifyMessage(
    {
      nextInformationNeed: { focus: "audienceInput", reason: "" },
      clarifyFallbackMessage: FOCUS.audience
    },
    [{ key: "audienceInput", reason: "status_partial" }],
    m.coverage,
    turns
  );
  assert("PARTIAL not full audience", msg !== FOCUS.audience);
}

{
  const t1 = "У меня гостевой дом на 4 номера рядом с морем";
  const t2 = "Уточнение: на самом деле у нас 6 номеров, не 4";
  const hist = [{ role: "user", content: t1 }, { role: "assistant", content: "ok" }];
  const turns = buildUserTurns(hist, t2);
  const model = Object.assign(emptyCoverage(), {
    business: field("known", [
      src("u1", "гостевой дом на 4 номера рядом с морем", "what_business"),
      src("u2", "у нас 6 номеров, не 4", "what_business", "replace")
    ])
  });
  const m = mergeBriefCoverage(null, model, turns);
  const superseded = applySupersedePolicy(m.coverage.business.sources || []);
  const quotes = superseded
    .map(function (s) {
      return s.quote;
    })
    .join(" | ");
  assert("CORRECTION keeps replace evidence", /6 номер/.test(quotes));
}

{
  const cov = Object.assign(emptyCoverage(), {
    business: field("known", [src("u1", "цветочная студия в центре города", "what_business")])
  });
  const encoded = encodeBriefState(cov);
  const parsed = parseBriefState(encoded);
  assert(
    "STATE encode/parse",
    parsed &&
      parsed.fields &&
      parsed.fields.business &&
      parsed.fields.business.sources.length === 1
  );
  const malformed = parseBriefState("{not-json");
  assert(
    "STATE malformed safe",
    malformed &&
      malformed.fields &&
      malformed.fields.business &&
      malformed.fields.business.sources.length === 0
  );

  const forgedTurns = buildUserTurns([], "Я продаю торты на заказ в своём городе");
  const forgedMerged = mergeBriefCoverage(
    {
      business: {
        status: "known",
        sources: [src("u9", "секретный завод полного цикла", "what_business")]
      }
    },
    Object.assign(emptyCoverage(), {
      business: field("known", [src("u1", "ядерный реактор в подвале дома", "what_business")])
    }),
    forgedTurns
  );
  const forgedQuotes = (forgedMerged.coverage.business.sources || [])
    .map(function (s) {
      return s.quote;
    })
    .join(" ");
  assert("STATE forged dropped", !/реактор|завод/.test(forgedQuotes));
}

{
  const hist = [
    { role: "user", content: "нужен сайт" },
    { role: "assistant", content: "q1" },
    { role: "user", content: "не знаю" },
    { role: "assistant", content: "q2" },
    { role: "user", content: "хз" },
    { role: "assistant", content: "q3" }
  ];
  assert("LOW ENGAGEMENT streak", countLowEngagementStreak(hist, "ок") >= 2);
}

assert("helper FLOW teacher", isDesiredFlowSufficient([src("u1", teacherFlow, "ideal_flow")]));
assert(
  "helper JOURNEY teacher",
  isCustomerJourneySufficient([src("u1", teacherJourney, "path_steps")])
);
assert(
  "helper TOOLS table",
  isExistingToolsSufficient([
    src(
      "u1",
      "Веду записи в Google Таблице, общаюсь в WhatsApp. CRM нет, бота нет, всё вручную",
      "tools"
    )
  ])
);

// Negative: validators must not be overly permissive
assert(
  "NEG flow pain-only",
  !isDesiredFlowSufficient([
    src("u1", "Мне приходится каждому гостю заново отвечать на одни и те же вопросы", "ideal_flow")
  ])
);
assert(
  "NEG flow less-manual",
  !isDesiredFlowSufficient([
    src("u1", "Хочу меньше ручной работы и меньше переписки", "ideal_flow")
  ])
);
assert(
  "NEG flow want-site",
  !isDesiredFlowSufficient([src("u1", "Хочу сайт для своего бизнеса", "ideal_flow")])
);
assert(
  "NEG journey social-only",
  !isCustomerJourneySufficient([
    src("u1", "Основные клиенты приходят из соцсетей", "path_steps")
  ])
);
assert(
  "NEG journey whatsapp-only",
  !isCustomerJourneySufficient([src("u1", "Обычно пишут в WhatsApp", "path_steps")])
);
assert(
  "NEG journey tools-list",
  !isCustomerJourneySufficient([
    src("u1", "У нас есть WhatsApp, Instagram, телефон и таблицы заказов", "path_steps")
  ])
);
assert(
  "NEG who abstract people",
  isAudienceWhoEvidence("Обычно к нам приходят люди") === false
);
assert(
  "NEG who product-only",
  isAudienceWhoEvidence("У нас гостевой дом с бассейном и парковкой рядом с морем") === false
);

if (failed) {
  console.error("\n" + failed + " conversation regression(s) failed");
  process.exit(1);
}
console.log("\nAll conversation regressions passed.");
