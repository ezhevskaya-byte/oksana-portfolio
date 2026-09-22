import { GATE_POLICY, LIMITS } from "./config.js";
import { CRITICAL_COVERAGE_KEYS } from "./schema.js";

const FOCUS_PROMPTS = {
  business: "Расскажите немного подробнее о вашем бизнесе: чем именно вы занимаетесь и что предлагаете клиентам?",
  goal: "Какого результата вы хотите добиться в первую очередь — что должно измениться в бизнесе?",
  audienceInput:
    "Кто чаще всего к вам обращается, и что этим людям обычно важно при выборе?",
  audienceInput_who_or_segment:
    "Кто чаще всего к вам обращается — какой это тип клиентов или гостей?",
  audienceInput_what_matters:
    "А что для этих людей обычно важнее всего при выборе?",
  customerJourney:
    "Как сейчас обычно проходит путь клиента: от первого знакомства до заявки или покупки?",
  friction: "Где сейчас больше всего теряется время, заявки или удобство — для вас или для клиентов?",
  existingTools:
    "Какими инструментами вы уже пользуетесь: сайт, соцсети, CRM, система бронирования, таблицы, бот?",
  desiredFlow:
    "В идеале что клиент должен иметь возможность сделать сам, и что должно стать проще для вас?"
};

function promptForFocus(focus, aspect) {
  if (focus === "audienceInput" && aspect === "who_or_segment") {
    return FOCUS_PROMPTS.audienceInput_who_or_segment;
  }
  if (focus === "audienceInput" && aspect === "what_matters") {
    return FOCUS_PROMPTS.audienceInput_what_matters;
  }
  if (focus && FOCUS_PROMPTS[focus]) return FOCUS_PROMPTS[focus];
  return null;
}

/** True if text is an exact server FOCUS_PROMPT (full or aspect-specific). */
export function isServerFocusPrompt(text) {
  const t = normalizeSpan(text);
  if (!t) return false;
  const keys = Object.keys(FOCUS_PROMPTS);
  for (let i = 0; i < keys.length; i += 1) {
    if (normalizeSpan(FOCUS_PROMPTS[keys[i]]) === t) return true;
  }
  return false;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Collapse whitespace for exact-span checks (no fuzzy matching). */
export function normalizeSpan(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build server-assigned user turn ids from history + current message.
 * Only role=user counts. Ids are u1..uN in chronological order.
 */
export function buildUserTurns(history, message) {
  const turns = [];
  const items = Array.isArray(history) ? history : [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || item.role !== "user") continue;
    if (!isNonEmptyString(item.content)) continue;
    turns.push({
      id: "u" + (turns.length + 1),
      text: String(item.content).trim()
    });
  }
  if (isNonEmptyString(message)) {
    turns.push({
      id: "u" + (turns.length + 1),
      text: String(message).trim()
    });
  }
  return turns;
}

export function formatUserTurnsBlock(userTurns) {
  if (!userTurns || !userTurns.length) {
    return "USER_TURNS:\n(none yet)";
  }
  const lines = ["USER_TURNS (only these user messages may be cited as sources):"];
  for (let i = 0; i < userTurns.length; i += 1) {
    const t = userTurns[i];
    lines.push(t.id + ": " + t.text);
  }
  return lines.join("\n");
}

function turnMap(userTurns) {
  const map = Object.create(null);
  for (let i = 0; i < (userTurns || []).length; i += 1) {
    map[userTurns[i].id] = userTurns[i].text;
  }
  return map;
}

function quoteGroundedInTurn(quote, turnText) {
  if (!isNonEmptyString(quote) || !isNonEmptyString(turnText)) return false;
  if (quote.trim().length < GATE_POLICY.minQuoteChars) return false;
  return normalizeSpan(turnText).includes(normalizeSpan(quote));
}

/**
 * Conservative FAQ / guest-question detector.
 * Not full NLP — rejects common "guests ask…" recounts as WHO/WHAT proof.
 */
export function looksLikeGuestFaqRecount(quote) {
  const q = normalizeSpan(quote);
  if (!q) return false;
  if (/при выборе/.test(q)) return false;
  if (
    /спрашивают/.test(q) ||
    /часто спрашивают/.test(q) ||
    /можно ли\s/.test(q) ||
    /есть ли\s/.test(q) ||
    /далеко ли\s/.test(q)
  ) {
    return true;
  }
  return false;
}

/**
 * Count distinct classic buyer-choice criteria in text (closed set).
 * Used to recognize WHAT_MATTERS answers that list price/quality/assortment
 * without repeating the full "при выборе" framing.
 */
function countChoiceCriteria(q) {
  const re =
    /(?:цен[а-я]*|стоимост[а-я]*|качеств[а-я]*|ассортимент[а-я]*|выбор[а-я]*|материал[а-я]*|размер[а-я]*|доставк[а-я]*|ткан[а-я]*|сроки)/g;
  const found = q.match(re);
  if (!found) return 0;
  const seen = Object.create(null);
  let n = 0;
  for (let i = 0; i < found.length; i += 1) {
    const key = found[i].slice(0, 4);
    if (seen[key]) continue;
    seen[key] = true;
    n += 1;
  }
  return n;
}

/**
 * WHO: user explicitly describes who books / visits / is a typical client.
 * Aspect who_or_segment alone is NOT enough.
 */
export function isAudienceWhoEvidence(quote) {
  const q = normalizeSpan(quote);
  if (!q || q.length < GATE_POLICY.minQuoteChars) return false;
  if (looksLikeGuestFaqRecount(quote)) return false;
  // Property / niche alone is not WHO.
  if (
    /гостевой дом|гостиниц|отел/.test(q) &&
    !/(?:отдых|приезж|останавл|бронир|пар|семь|клиент)/.test(q)
  ) {
    return false;
  }

  const frequency = /(?:чаще(?:\s+всего)?|в основном|обычно|типичн)/.test(q);
  // Bare «люди/человек» alone is NOT a meaningful segment.
  const segmentCore =
    /(?:отдых|приезж|останавл|бронир|клиент|гост|пар|семь|женщин|мужчин|покупател|взросл|ученик|владельц|магазин|частник|бренд)/.test(
      q
    );

  const describesSegment = frequency && segmentCore;
  const verbThenSegment =
    /(?:отдых|приезж|останавл|бронир)[а-я]{0,8}\s+(?:у нас\s+)?(?:пар|семь|люди|клиент|гост)/.test(
      q
    );
  const namedClients =
    /(?:наши|основные|типичные)\s+(?:клиенты|гости|покупатели)/.test(q);
  const pairsFamilies =
    /(?:пары|семьи)(?:\s+\d|\s+с\s|\s+и\s|\s*$|,)/.test(q) &&
    /(?:отдых|приезж|останавл|у нас|к нам|чаще|обычно)/.test(q);
  // Demographic + age band: «чаще женщины 30–60 лет» / «взрослые 25–45 лет»
  const demoWithAge =
    frequency &&
    /(?:женщин|мужчин|сем[ьия]|пар[ыа]|покупател|клиент|гост|взросл|ученик)/.test(q) &&
    /(?:\d{1,2}\s*[–\-—]\s*\d{1,2}|\d{1,2}\s*(?:лет|года))/.test(q);
  // «Клиенты — …» / «Покупатели — …» as explicit segment lead
  const labeledSegment =
    /(?:клиенты|покупатели|гости|ученики)\s*[—\-–:]/.test(q) && segmentCore;
  // «ко мне/к нам обращаются …» with a non-generic segment
  const approachSegment =
    /(?:ко\s+мне|к\s+нам)\s+обраща|обраща(?:ются|ется)/.test(q) &&
    (segmentCore || /(?:взросл|владельц|компани|бренд)/.test(q));

  return (
    describesSegment ||
    verbThenSegment ||
    namedClients ||
    pairsFamilies ||
    demoWithAge ||
    labeledSegment ||
    approachSegment
  );
}

/**
 * WHAT_MATTERS: user links criteria / doubts to client choice.
 * Accepts framed answers OR a list of classic purchase criteria.
 * Bare property facts / unframed FAQ without criteria list do not count.
 * Ambiguous noise (e.g. «продавец общается») never invents WHO.
 */
export function isAudienceWhatMattersEvidence(quote) {
  const q = normalizeSpan(quote);
  if (!q || q.length < GATE_POLICY.minQuoteChars) return false;

  const criteriaN = countChoiceCriteria(q);

  // Bare property facts without choice framing and without multi-criteria list.
  if (
    (/до моря/.test(q) || /бассейн/.test(q) || /лазаревск/.test(q) || /гостевой дом/.test(q)) &&
    !/при выборе|важно|сомнева|критер/.test(q) &&
    criteriaN < 2
  ) {
    if (!/при выборе/.test(q)) {
      if (/спрашивают/.test(q) && criteriaN < 2) return false;
      if (!/спрашивают|важно|при выборе/.test(q)) return false;
    }
  }

  // Unframed FAQ recount without a criteria list — not WHAT_MATTERS.
  if (
    /спрашивают/.test(q) &&
    !/при выборе|в первую очередь|им важно|важно при|важн/.test(q) &&
    criteriaN < 2
  ) {
    return false;
  }

  if (/при выборе/.test(q)) return true;
  if (/(?:им|для них|гостям|клиентам)\s+важно/.test(q)) return true;
  if (/важно при (?:выборе|покупке|бронировании)/.test(q)) return true;
  if (/(?:они|гости|клиенты).{0,48}(?:смотрят на|выбирают|обращают внимание|интересует)/.test(q)) {
    return true;
  }
  if (/в первую очередь/.test(q) && /спрашивают|важно|смотр/.test(q)) return true;

  // Importance / attention framing + ≥1 classic criterion.
  if (/(?:важн[а-я]*|главн[а-я]*)/.test(q) && criteriaN >= 1) return true;
  if (/(?:смотрят на|интересует|обращают внимание)/.test(q) && criteriaN >= 1) return true;

  // Two+ classic criteria answers "what matters" even without framing
  // (e.g. «качество, цена, ассортимент» after a full audience question).
  if (criteriaN >= 2) return true;

  return false;
}

function combineSourceQuotes(sources) {
  const parts = [];
  for (let i = 0; i < (sources || []).length; i += 1) {
    if (sources[i] && isNonEmptyString(sources[i].quote)) parts.push(sources[i].quote);
  }
  return normalizeSpan(parts.join(" "));
}

/** Journey stages in accumulated evidence (conservative patterns). */
export function detectJourneyStages(text) {
  const q = normalizeSpan(text);
  const stages = [];
  if (
    /наход|приход|авито|объявлен|соцсет|инстаграм|реклам|видят\s+работ|узнают\s+(?:о\s+нас|через)/.test(
      q
    )
  ) {
    stages.push("discover");
  }
  if (/смотр|фото|описан|сравнива|изуча/.test(q)) stages.push("inspect");
  if (
    /пиш|звон|whatsapp|ватсап|мессенджер|связыв|контакт|личн\w*\s+сообщ|телеграм/.test(q)
  ) {
    stages.push("contact");
  }
  if (
    /уточня|количеств\w*\s+гост|спрашива|выясня\w*.{0,24}(?:цель|уровень)|цель\s+и\s+уровень/.test(
      q
    )
  ) {
    stages.push("qualify");
  }
  if (
    /провер.{0,28}(?:свобод|номер|дат)/.test(q) ||
    /называ.{0,16}(?:стоим|цен)/.test(q) ||
    (/(?:свободн|стоим|цен[аыуе])/.test(q) && /провер|называ|смотр/.test(q))
  ) {
    stages.push("availability");
  }
  if (
    /предоплат|подтвержд|оформ.{0,16}брон|заброн|переводи|оплачива|оплату|оплата|расписание\s+и\s+оплат/.test(
      q
    )
  ) {
    stages.push("book");
  }
  // Service / education process (tutoring, consulting, studios).
  if (/пробн\w*\s+(?:занят|урок)|пробный\s+(?:урок|занят)/.test(q)) stages.push("trial");
  if (/предлага\w*.{0,20}формат|обсужда\w*.{0,20}формат|формат\s+занят/.test(q)) {
    stages.push("offer");
  }
  if (
    /начина\w*\s+(?:занят|работ)|ведём\s+занят|провожу\s+занят|начинаем\s+занят/.test(q)
  ) {
    stages.push("deliver");
  }
  return stages;
}

/**
 * Sufficient customer journey: multiple meaningful stages, not a lone channel.
 * Looks at accumulated grounded sources.
 */
export function isCustomerJourneySufficient(sources) {
  const text = combineSourceQuotes(sources);
  if (!text || text.length < GATE_POLICY.minQuoteChars) return false;

  const stages = detectJourneyStages(text);
  const unique = [];
  for (let i = 0; i < stages.length; i += 1) {
    if (unique.indexOf(stages[i]) === -1) unique.push(stages[i]);
  }

  const hasDeepProcess =
    unique.indexOf("qualify") !== -1 ||
    unique.indexOf("availability") !== -1 ||
    unique.indexOf("book") !== -1 ||
    unique.indexOf("trial") !== -1 ||
    unique.indexOf("offer") !== -1 ||
    unique.indexOf("deliver") !== -1;

  const hasSurfaceProcess = unique.indexOf("inspect") !== -1;

  // Channel-only discover/contact (and even +inspect) is not enough without deeper process.
  if (!hasDeepProcess) return false;
  if (unique.length >= 3) return true;
  if (
    unique.length >= 2 &&
    hasDeepProcess &&
    (unique.indexOf("discover") !== -1 ||
      unique.indexOf("contact") !== -1 ||
      hasSurfaceProcess)
  ) {
    return true;
  }
  return false;
}

function hasOperationalToolSignal(text) {
  const q = text;
  const mentionsCrm = /\bcrm\b/.test(q) && !/(?:нет\s+crm|crm\s+нет|ни\s+crm)/.test(q);
  const mentionsCms = /\bcms\b/.test(q) && !/(?:нет\s+cms|cms\s+нет|ни\s+cms)/.test(q);
  const mentionsBot =
    /(?:есть|веду|использу|работа)\w*.{0,16}(?:бот|чат-?бот)/.test(q) ||
    /(?:бот|чат-?бот)\s+(?:есть|вед|использу)/.test(q);
  return (
    /систем[аыуе]\s+бронир|бронир\w*\s+систем|модул\w*\s+(?:онлайн|бронир)|онлайн-?бронир/.test(q) ||
    /календар/.test(q) ||
    mentionsCrm ||
    mentionsCms ||
    /таблиц/.test(q) && !/(?:нет\s+таблиц|ни\s+таблиц|таблиц\w*\s+нет)/.test(q) ||
    mentionsBot ||
    /баз[аыуе]\s+данн/.test(q) ||
    /интеграц|автоматиз/.test(q) ||
    /форм[аыуе]\s+заяв|заявк\w*\s+форм/.test(q) ||
    /сайт[аеу]?\s+(?:есть|работа|вед|на\s+)/.test(q)
  );
}

function isChannelOnlyToolsText(text) {
  if (hasOperationalToolSignal(text)) return false;
  const hasChannel = /whatsapp|ватсап|телефон|звон|авито|соцсет|инстаграм|телеграм/.test(text);
  const siteOrCrmGone = /сайта?\s+нет|нет\s+сайта|crm\s+нет|нет\s+crm|бота?\s+нет/.test(text);
  return hasChannel || siteOrCrmGone;
}

function hasBroadToolsAbsence(text) {
  const manual = /вручную|ничего не использу|кроме .{0,80}ничего/.test(text);
  const absenceHits =
    (/ни\s+crm|crm\s+нет|нет\s+crm/.test(text) ? 1 : 0) +
    (/ни\s+систем|систем\w*\s+бронир\w*\s+нет|нет\s+систем\w*\s+бронир/.test(text) ? 1 : 0) +
    (/ни\s+таблиц|таблиц\w*\s+нет/.test(text) ? 1 : 0) +
    (/ни\s+бот|бота?\s+нет|нет\s+бота/.test(text) ? 1 : 0) +
    (/ни\s+друг|других\s+програм/.test(text) ? 1 : 0);
  return manual && absenceHits >= 2;
}

/**
 * Sufficient existing tools: operational/reuse systems OR broad explicit absence.
 * Avito/WhatsApp/phone alone (or lone "no site/CRM") are never enough for KNOWN.
 */
export function isExistingToolsSufficient(sources) {
  const text = combineSourceQuotes(sources);
  if (!text || text.length < GATE_POLICY.minQuoteChars) return false;
  if (hasOperationalToolSignal(text)) return true;
  if (hasBroadToolsAbsence(text)) return true;
  if (isChannelOnlyToolsText(text)) return false;
  return false;
}

/**
 * Sufficient desired flow: future client autonomy / process — not owner pain/goal alone.
 * Tolerates natural Russian phrasing (хотелось бы / уже мог / оставить заявку / выбрать время).
 */
export function isDesiredFlowSufficient(sources) {
  const text = combineSourceQuotes(sources);
  if (!text || text.length < GATE_POLICY.minQuoteChars) return false;

  const futureDesire =
    /хочу,?\s+чтобы/.test(text) ||
    /хотелось\s+бы(?:,?\s+чтобы)?/.test(text) ||
    /хотелось\s+бы\s+дать\s+возможность/.test(text) ||
    /в\s+идеале/.test(text) ||
    /чтобы\s+(?:до\s+\w+\s+)*(?:гость|клиент|человек|ученик|он|они)/.test(text);

  const clientSelfServe =
    /сам[аиу]?\s+(?:посмотр|увид|получ|оформ|заброн|выбр|узна|остав)/.test(text) ||
    /мог[лаи]?(?:\s+\w+){0,4}\s+(?:посмотр|увид|получ|оформ|заброн|выбр|узна|поня|остав)/.test(
      text
    ) ||
    /чтобы\s+(?:до\s+\w+\s+)*(?:гость|клиент|человек|ученик|он|они)(?:\s+\w+){0,5}\s+(?:сам|мог|посмотр|оформ|заброн|поня)/.test(
      text
    ) ||
    /самостоятельн/.test(text) ||
    /оставить\s+заявк|выбрать\s+время|оформить\s+(?:заявк|брон)|записаться\s+на/.test(text) ||
    /заранее\s+понять|понять\s+(?:мой\s+)?формат|понять.{0,48}(?:стоим|цен|услов)/.test(text) ||
    /получить\s+ответы\s+на\s+основные/.test(text) ||
    /дать\s+возможность/.test(text);

  const ownerReliefWithSelfServe =
    clientSelfServe &&
    /не\s+пришлось\s+бы|не\s+повторять|не\s+рассказыва|заново\s+рассказ|одно\s+и\s+то\s+же|подключаться\s+уже/.test(
      text
    );

  const painOrGoalOnly =
    /не\s+хочу|не\s+приходилось|одинаков|повторя|меньше\s+(?:тратить|зависеть)|нужен\s+сайт|больше\s+прямых/.test(
      text
    ) && !clientSelfServe;

  if (painOrGoalOnly) return false;
  if (
    clientSelfServe &&
    (futureDesire ||
      ownerReliefWithSelfServe ||
      /брон|номер|дат|цен|свободн|ответ|заявк|формат|занят|доставк|услов/.test(text))
  ) {
    return true;
  }
  return false;
}

function normalizeSources(rawSources) {
  if (!Array.isArray(rawSources)) return [];
  const out = [];
  for (let i = 0; i < rawSources.length; i += 1) {
    const s = rawSources[i];
    if (!s || typeof s !== "object") continue;
    const operation = s.operation === "replace" ? "replace" : "support";
    out.push({
      turnId: typeof s.turnId === "string" ? s.turnId.trim() : "",
      quote: typeof s.quote === "string" ? s.quote.trim() : "",
      aspect: typeof s.aspect === "string" ? s.aspect.trim() : "",
      operation: operation
    });
  }
  return out;
}

function normalizeCoverage(raw) {
  const out = {};
  for (let i = 0; i < CRITICAL_COVERAGE_KEYS.length; i += 1) {
    const key = CRITICAL_COVERAGE_KEYS[i];
    const item = raw && raw[key] ? raw[key] : {};
    out[key] = {
      status: "unknown",
      sources: normalizeSources(item.sources)
    };
  }
  return out;
}

export function turnIndex(turnId) {
  const m = /^u(\d+)$/i.exec(String(turnId || "").trim());
  if (!m) return -1;
  return parseInt(m[1], 10);
}

function aspectAllowedForField(fieldKey, aspect) {
  const allowed = GATE_POLICY.requiredAspects[fieldKey] || [];
  return allowed.indexOf(aspect) !== -1;
}

/**
 * Re-ground a single source against current USER_TURNS.
 * Status from client/model is ignored.
 */
export function reGroundSource(src, turnsById, fieldKey) {
  if (!src || !src.turnId || !turnsById[src.turnId]) return null;
  if (turnIndex(src.turnId) < 1) return null;
  if (!aspectAllowedForField(fieldKey, src.aspect)) return null;
  if (!quoteGroundedInTurn(src.quote, turnsById[src.turnId])) return null;
  if (fieldKey === "audienceInput") {
    if (src.aspect === "who_or_segment" && !isAudienceWhoEvidence(src.quote)) return null;
    if (src.aspect === "what_matters" && !isAudienceWhatMattersEvidence(src.quote)) return null;
  }
  return {
    turnId: src.turnId,
    quote: src.quote,
    aspect: src.aspect,
    operation: src.operation === "replace" ? "replace" : "support"
  };
}

function reGroundSourceList(sources, turnsById, fieldKey) {
  const out = [];
  const list = normalizeSources(sources);
  for (let i = 0; i < list.length; i += 1) {
    const g = reGroundSource(list[i], turnsById, fieldKey);
    if (g) out.push(g);
  }
  return out;
}

function sourceIdentity(s) {
  return (
    String(s.turnId || "") +
    "\0" +
    normalizeSpan(s.quote) +
    "\0" +
    String(s.aspect || "") +
    "\0" +
    (s.operation === "replace" ? "replace" : "support")
  );
}

function dedupeSources(list) {
  const out = [];
  const seen = Object.create(null);
  for (let i = 0; i < (list || []).length; i += 1) {
    const s = list[i];
    if (!s || !s.aspect) continue;
    const id = sourceIdentity(s);
    if (seen[id]) continue;
    seen[id] = true;
    out.push({
      turnId: s.turnId,
      quote: s.quote,
      aspect: s.aspect,
      operation: s.operation === "replace" ? "replace" : "support"
    });
  }
  return out;
}

/**
 * Per aspect:
 * - support + support → accumulate (exact dedupe); newer support does NOT erase older;
 * - grounded replace supersedes older same-aspect evidence (keeps winning replace + newer support).
 * Ungrounded/invalid replace never reaches here (filtered by reGround).
 */
export function applySupersedePolicy(sources, fieldKey, turnsById) {
  const byAspect = Object.create(null);
  for (let i = 0; i < (sources || []).length; i += 1) {
    const s = sources[i];
    if (!s || !s.aspect) continue;
    if (!byAspect[s.aspect]) byAspect[s.aspect] = [];
    byAspect[s.aspect].push(s);
  }

  const out = [];
  const aspects = Object.keys(byAspect);
  for (let a = 0; a < aspects.length; a += 1) {
    const list = byAspect[aspects[a]];
    const replaces = [];
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].operation === "replace") replaces.push(list[i]);
    }

    if (!replaces.length) {
      const kept = dedupeSources(list);
      for (let i = 0; i < kept.length; i += 1) out.push(kept[i]);
      continue;
    }

    let maxReplaceIdx = -1;
    for (let i = 0; i < replaces.length; i += 1) {
      const idx = turnIndex(replaces[i].turnId);
      if (idx > maxReplaceIdx) maxReplaceIdx = idx;
    }

    const winners = [];
    for (let i = 0; i < replaces.length; i += 1) {
      if (turnIndex(replaces[i].turnId) === maxReplaceIdx) winners.push(replaces[i]);
    }
    for (let i = 0; i < list.length; i += 1) {
      const s = list[i];
      if (s.operation === "replace") continue;
      if (turnIndex(s.turnId) > maxReplaceIdx) winners.push(s);
    }

    const kept = dedupeSources(winners);
    for (let i = 0; i < kept.length; i += 1) out.push(kept[i]);
  }

  return pruneSourcesPreservingCoverage(out, fieldKey, turnsById);
}

/**
 * Cap sources without dropping evidence required for field sufficiency.
 * Prefer keeping one valid source per required aspect, then fill remaining slots.
 */
export function pruneSourcesPreservingCoverage(sources, fieldKey, turnsById) {
  const cap = LIMITS.maxSourcesPerField || 8;
  const list = dedupeSources(sources || []);
  if (list.length <= cap) return list;

  const required = GATE_POLICY.requiredAspects[fieldKey] || [];
  const selected = [];
  const used = Object.create(null);

  function mark(s) {
    used[sourceIdentity(s)] = true;
    selected.push(s);
  }

  function isUsed(s) {
    return Boolean(used[sourceIdentity(s)]);
  }

  function pickForAspect(aspect) {
    const candidates = [];
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].aspect === aspect && !isUsed(list[i])) candidates.push(list[i]);
    }
    if (!candidates.length) return null;

    if (fieldKey === "audienceInput") {
      for (let i = 0; i < candidates.length; i += 1) {
        const c = candidates[i];
        if (aspect === "who_or_segment" && isAudienceWhoEvidence(c.quote)) return c;
        if (aspect === "what_matters" && isAudienceWhatMattersEvidence(c.quote)) return c;
      }
    }
    // Prefer replace, then newer turn.
    candidates.sort(function (a, b) {
      const ar = a.operation === "replace" ? 1 : 0;
      const br = b.operation === "replace" ? 1 : 0;
      if (br !== ar) return br - ar;
      return turnIndex(b.turnId) - turnIndex(a.turnId);
    });
    return candidates[0];
  }

  for (let r = 0; r < required.length; r += 1) {
    if (selected.length >= cap) break;
    const pick = pickForAspect(required[r]);
    if (pick) mark(pick);
  }

  // For multi-quote semantic fields: greedily add until sufficient when possible.
  function trySufficiency() {
    if (!turnsById) return true;
    if (fieldKey === "customerJourney") return isCustomerJourneySufficient(selected);
    if (fieldKey === "existingTools") return isExistingToolsSufficient(selected);
    if (fieldKey === "desiredFlow") return isDesiredFlowSufficient(selected);
    if (fieldKey === "audienceInput") {
      return evaluateAudienceKnown(selected, turnsById).ok;
    }
    return true;
  }

  if (
    turnsById &&
    (fieldKey === "customerJourney" ||
      fieldKey === "existingTools" ||
      fieldKey === "desiredFlow" ||
      fieldKey === "audienceInput") &&
    !trySufficiency()
  ) {
    const restPriority = list
      .filter(function (s) {
        return !isUsed(s);
      })
      .sort(function (a, b) {
        return turnIndex(b.turnId) - turnIndex(a.turnId);
      });
    for (let i = 0; i < restPriority.length && selected.length < cap; i += 1) {
      mark(restPriority[i]);
      if (trySufficiency()) break;
    }
  }

  const rest = list
    .filter(function (s) {
      return !isUsed(s);
    })
    .sort(function (a, b) {
      const ar = a.operation === "replace" ? 1 : 0;
      const br = b.operation === "replace" ? 1 : 0;
      if (br !== ar) return br - ar;
      return turnIndex(b.turnId) - turnIndex(a.turnId);
    });
  for (let i = 0; i < rest.length && selected.length < cap; i += 1) {
    mark(rest[i]);
  }

  return selected.slice(0, cap);
}

function validateGroundedSources(sources, turnsById, requiredAspects) {
  const issues = [];
  const grounded = [];
  const aspectsSeen = Object.create(null);

  for (let i = 0; i < sources.length; i += 1) {
    const src = sources[i];
    if (!src.turnId || !turnsById[src.turnId]) {
      issues.push("invalid_turn");
      continue;
    }
    if (!quoteGroundedInTurn(src.quote, turnsById[src.turnId])) {
      issues.push("ungrounded_quote");
      continue;
    }
    grounded.push(src);
    if (src.aspect) aspectsSeen[src.aspect] = true;
  }

  for (let j = 0; j < requiredAspects.length; j += 1) {
    if (!aspectsSeen[requiredAspects[j]]) {
      issues.push("missing_aspect_" + requiredAspects[j]);
    }
  }

  return { ok: issues.length === 0 && grounded.length > 0, issues, grounded, aspectsSeen };
}

function evaluateAudienceKnown(sources, turnsById) {
  const required = GATE_POLICY.requiredAspects.audienceInput || ["who_or_segment", "what_matters"];
  const base = validateGroundedSources(sources, turnsById, required);
  if (!base.ok) {
    return { ok: false, reason: "audience_ungrounded", issues: base.issues };
  }

  let whoOk = false;
  let mattersOk = false;

  for (let i = 0; i < base.grounded.length; i += 1) {
    const src = base.grounded[i];
    if (isAudienceWhoEvidence(src.quote)) whoOk = true;
    if (isAudienceWhatMattersEvidence(src.quote)) mattersOk = true;
  }

  if (!whoOk) {
    return { ok: false, reason: "audience_who_insufficient", issues: ["who_not_evidenced"] };
  }
  if (!mattersOk) {
    return {
      ok: false,
      reason: "audience_what_matters_insufficient",
      issues: ["what_matters_not_evidenced"]
    };
  }
  return { ok: true, reason: "audience_ok", issues: [] };
}

/**
 * Derive server status from sources only (client/model status is never authority).
 * Provenance first; then field-specific semantic sufficiency for KNOWN.
 * Insufficient but grounded sources remain PARTIAL (not discarded).
 */
export function deriveFieldStatus(fieldKey, sources, turnsById) {
  const requiredAspects = GATE_POLICY.requiredAspects[fieldKey] || [];
  if (fieldKey === "audienceInput") {
    if (evaluateAudienceKnown(sources, turnsById).ok) return "known";
    return sources && sources.length ? "partial" : "unknown";
  }

  const grounded = validateGroundedSources(sources || [], turnsById, requiredAspects);
  if (!grounded.grounded.length) return "unknown";

  if (fieldKey === "customerJourney") {
    return isCustomerJourneySufficient(grounded.grounded) ? "known" : "partial";
  }
  if (fieldKey === "existingTools") {
    return isExistingToolsSufficient(grounded.grounded) ? "known" : "partial";
  }
  if (fieldKey === "desiredFlow") {
    return isDesiredFlowSufficient(grounded.grounded) ? "known" : "partial";
  }

  // business / goal / friction: provenance + required aspects
  if (grounded.ok) return "known";
  return "partial";
}

/**
 * Parse opaque briefState from client. Malformed/oversized → empty (ignore).
 */
export function parseBriefState(raw) {
  function emptyState() {
    const fields = {};
    for (let i = 0; i < CRITICAL_COVERAGE_KEYS.length; i += 1) {
      fields[CRITICAL_COVERAGE_KEYS[i]] = { sources: [] };
    }
    return { v: 1, fields: fields };
  }

  if (raw == null || raw === "") return emptyState();

  let obj = raw;
  if (typeof raw === "string") {
    if (raw.length > LIMITS.maxBriefStateChars) return emptyState();
    try {
      obj = JSON.parse(raw);
    } catch (_err) {
      return emptyState();
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return emptyState();

  try {
    const serialized = JSON.stringify(obj);
    if (serialized.length > LIMITS.maxBriefStateChars) return emptyState();
  } catch (_err) {
    return emptyState();
  }

  const fieldsIn = obj.fields && typeof obj.fields === "object" ? obj.fields : obj;
  const fields = {};
  for (let i = 0; i < CRITICAL_COVERAGE_KEYS.length; i += 1) {
    const key = CRITICAL_COVERAGE_KEYS[i];
    const item = fieldsIn[key];
    const sources = item && typeof item === "object" ? normalizeSources(item.sources) : [];
    fields[key] = { sources: sources.slice(0, LIMITS.maxSourcesPerField || 8) };
  }
  return { v: 1, fields: fields };
}

/** Encode server-validated sources into opaque briefState (no trusted status). */
export function encodeBriefState(coverage) {
  const fields = {};
  for (let i = 0; i < CRITICAL_COVERAGE_KEYS.length; i += 1) {
    const key = CRITICAL_COVERAGE_KEYS[i];
    const item = coverage && coverage[key] ? coverage[key] : {};
    const sources = normalizeSources(item.sources).slice(0, LIMITS.maxSourcesPerField || 8);
    fields[key] = { sources: sources };
  }
  return { v: 1, fields: fields };
}

/**
 * Merge prior briefState candidates + current model coverage; re-ground; supersede; derive status.
 * If still not known, recover grounded evidence directly from USER_TURNS (server-owned continuity).
 * Recovery never re-fills an aspect that the current model explicitly replaced.
 */
export function mergeBriefCoverage(priorBriefState, modelCoverage, userTurns) {
  const turnsById = turnMap(userTurns || []);
  const prior = parseBriefState(priorBriefState);
  const model = normalizeCoverage(modelCoverage);
  const coverage = {};

  for (let i = 0; i < CRITICAL_COVERAGE_KEYS.length; i += 1) {
    const key = CRITICAL_COVERAGE_KEYS[i];
    const priorGrounded = reGroundSourceList(
      prior.fields[key] ? prior.fields[key].sources : [],
      turnsById,
      key
    );
    const modelGrounded = reGroundSourceList(model[key].sources, turnsById, key);
    let mergedSources = applySupersedePolicy(
      priorGrounded.concat(modelGrounded),
      key,
      turnsById
    );
    let status = deriveFieldStatus(key, mergedSources, turnsById);

    if (status !== "known") {
      const replacedAspects = Object.create(null);
      for (let r = 0; r < modelGrounded.length; r += 1) {
        if (modelGrounded[r].operation === "replace" && modelGrounded[r].aspect) {
          replacedAspects[modelGrounded[r].aspect] = true;
        }
      }
      for (let r = 0; r < mergedSources.length; r += 1) {
        if (mergedSources[r].operation === "replace" && mergedSources[r].aspect) {
          replacedAspects[mergedSources[r].aspect] = true;
        }
      }

      const recovered = recoverSourcesFromTurns(key, userTurns || []).filter(function (s) {
        return !replacedAspects[s.aspect];
      });
      if (recovered.length) {
        mergedSources = applySupersedePolicy(
          mergedSources.concat(recovered),
          key,
          turnsById
        );
        status = deriveFieldStatus(key, mergedSources, turnsById);
      }
    }

    coverage[key] = { status: status, sources: mergedSources };
  }

  return {
    coverage: coverage,
    briefState: encodeBriefState(coverage)
  };
}

/**
 * Split user text into candidate exact spans for server-side evidence recovery.
 */
export function candidateSpans(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const parts = raw.split(/(?<=[.!?…])\s+|\n+/);
  const out = [];
  const seen = Object.create(null);
  function push(span) {
    const s = String(span || "").trim();
    if (s.length < GATE_POLICY.minQuoteChars) return;
    const key = normalizeSpan(s);
    if (!key || seen[key]) return;
    seen[key] = true;
    out.push(s);
  }
  push(raw);
  for (let i = 0; i < parts.length; i += 1) push(parts[i]);
  // Light clause splits for long sentences (keep contiguous substrings only).
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (!p || p.length < 80) continue;
    const clauses = p.split(/,\s+(?=[А-ЯA-Z«])/);
    for (let c = 0; c < clauses.length; c += 1) push(clauses[c]);
  }
  return out;
}

/**
 * Recover field sources from USER_TURNS using the same semantic validators as gates.
 * Does not invent paraphrases — only exact contiguous spans from user text.
 */
export function recoverSourcesFromTurns(fieldKey, userTurns) {
  const turns = userTurns || [];
  const out = [];

  for (let t = 0; t < turns.length; t += 1) {
    const turn = turns[t];
    if (!turn || !turn.id || !isNonEmptyString(turn.text)) continue;
    const spans = candidateSpans(turn.text);

    if (fieldKey === "audienceInput") {
      for (let i = 0; i < spans.length; i += 1) {
        const span = spans[i];
        if (isAudienceWhoEvidence(span)) {
          out.push({
            turnId: turn.id,
            quote: span,
            aspect: "who_or_segment",
            operation: "support"
          });
        }
        if (isAudienceWhatMattersEvidence(span)) {
          out.push({
            turnId: turn.id,
            quote: span,
            aspect: "what_matters",
            operation: "support"
          });
        }
      }
      continue;
    }

    if (fieldKey === "customerJourney") {
      for (let i = 0; i < spans.length; i += 1) {
        const trial = [
          {
            turnId: turn.id,
            quote: spans[i],
            aspect: "path_steps",
            operation: "support"
          }
        ];
        if (isCustomerJourneySufficient(trial)) {
          out.push(trial[0]);
          break;
        }
      }
      continue;
    }

    if (fieldKey === "existingTools") {
      for (let i = 0; i < spans.length; i += 1) {
        const trial = [
          { turnId: turn.id, quote: spans[i], aspect: "tools", operation: "support" }
        ];
        if (isExistingToolsSufficient(trial)) {
          out.push(trial[0]);
          break;
        }
      }
      continue;
    }

    if (fieldKey === "desiredFlow") {
      for (let i = 0; i < spans.length; i += 1) {
        const trial = [
          {
            turnId: turn.id,
            quote: spans[i],
            aspect: "ideal_flow",
            operation: "support"
          }
        ];
        if (isDesiredFlowSufficient(trial)) {
          out.push(trial[0]);
          break;
        }
      }
    }
  }

  return out;
}

/**
 * Which audience aspects are still missing for clarification (not full re-ask).
 * Returns [] when both sufficient (should not ask audience at all).
 */
export function audienceMissingAspects(sources, turnsById) {
  const list = sources || [];
  let whoOk = false;
  let mattersOk = false;
  for (let i = 0; i < list.length; i += 1) {
    const src = list[i];
    if (!src || !src.turnId || !turnsById[src.turnId]) continue;
    if (!quoteGroundedInTurn(src.quote, turnsById[src.turnId])) continue;
    if (isAudienceWhoEvidence(src.quote)) whoOk = true;
    if (isAudienceWhatMattersEvidence(src.quote)) mattersOk = true;
  }
  const missing = [];
  if (!whoOk) missing.push("who_or_segment");
  if (!mattersOk) missing.push("what_matters");
  return missing;
}

/**
 * Resolve clarify target with NO-REPEAT: skip fields already known after merge/recovery.
 * For audience partial → ask only the missing aspect.
 */
export function resolveClarifyTarget(missing, coverage, userTurns) {
  const turnsById = turnMap(userTurns || []);
  if (!missing || !missing.length) {
    return { focus: null, aspect: null };
  }

  for (let i = 0; i < missing.length; i += 1) {
    const key = missing[i] && missing[i].key;
    if (!key) continue;

    const sources =
      coverage && coverage[key] && Array.isArray(coverage[key].sources)
        ? coverage[key].sources
        : [];
    const status = deriveFieldStatus(key, sources, turnsById);
    if (status === "known") {
      // Stale missing entry — never re-ask a known field.
      continue;
    }

    if (key === "audienceInput") {
      const aspects = audienceMissingAspects(sources, turnsById);
      if (!aspects.length) continue;
      if (aspects.length === 1) {
        return { focus: key, aspect: aspects[0] };
      }
      return { focus: key, aspect: null };
    }

    return { focus: key, aspect: null };
  }

  return { focus: null, aspect: null };
}

/**
 * Gate 1: uses server-derived status from grounded sources only.
 */
export function evaluateBriefReady(briefCoverage, userTurns) {
  const coverage = normalizeCoverage(briefCoverage);
  const turnsById = turnMap(userTurns || []);
  const missing = [];

  // Re-derive status from sources so forged status cannot open the gate.
  for (let i = 0; i < CRITICAL_COVERAGE_KEYS.length; i += 1) {
    const key = CRITICAL_COVERAGE_KEYS[i];
    const sources = coverage[key].sources;
    const status = deriveFieldStatus(key, sources, turnsById);
    coverage[key].status = status;

    if (status !== "known") {
      missing.push({ key: key, reason: "status_" + status });
      continue;
    }

    // Double-check grounding still holds (history may have changed).
    if (key === "audienceInput") {
      const aud = evaluateAudienceKnown(sources, turnsById);
      if (!aud.ok) {
        coverage[key].status = "partial";
        missing.push({ key: key, reason: aud.reason, issues: aud.issues });
      }
      continue;
    }

    const requiredAspects = GATE_POLICY.requiredAspects[key] || [];
    const grounded = validateGroundedSources(sources, turnsById, requiredAspects);
    if (!grounded.ok) {
      coverage[key].status = grounded.grounded.length ? "partial" : "unknown";
      missing.push({
        key: key,
        reason: grounded.issues[0] || "ungrounded",
        issues: grounded.issues
      });
    }
  }

  return {
    ready: missing.length === 0,
    missing: missing,
    coverage: coverage
  };
}

function isNoneToken(value) {
  if (!isNonEmptyString(value)) return false;
  const v = value.trim().toLowerCase();
  return v === "none" || v.startsWith("none:");
}

/** Gate 2: structural checks only — not semantic quality by length. */
export function evaluateExpertPlan(turn, briefReadyCoverage) {
  const mode = turn.recommendationMode;
  const issues = [];

  if (mode !== "normal" && mode !== "preliminary") {
    return { ok: true, issues };
  }

  const plan = turn.expertPlan;
  if (!plan || typeof plan !== "object") {
    issues.push("expert_plan_missing");
    return { ok: false, issues };
  }

  const required = [
    "realProblem",
    "audienceHypothesis",
    "primarySolution",
    "alternative",
    "whyPrimary",
    "reuseNote",
    "startNow",
    "addLater",
    "doNotBuildYet",
    "insight"
  ];

  for (let i = 0; i < required.length; i += 1) {
    const key = required[i];
    if (!isNonEmptyString(plan[key])) {
      issues.push("empty_" + key);
    }
  }

  if (
    isNonEmptyString(plan.primarySolution) &&
    isNonEmptyString(plan.alternative) &&
    plan.primarySolution.trim().toLowerCase() === plan.alternative.trim().toLowerCase()
  ) {
    issues.push("primary_equals_alternative");
  }

  if (
    briefReadyCoverage &&
    briefReadyCoverage.existingTools &&
    briefReadyCoverage.existingTools.status === "known" &&
    !isNonEmptyString(plan.reuseNote)
  ) {
    issues.push("reuse_required_when_tools_known");
  }

  if (isNonEmptyString(plan.alternative)) {
    const alt = plan.alternative.trim();
    if (isNoneToken(alt)) {
      const reason = alt.includes(":") ? alt.slice(alt.indexOf(":") + 1).trim() : "";
      if (!reason) issues.push("alternative_none_without_reason");
    }
  }

  if (mode === "preliminary") {
    const msg = typeof turn.assistantMessage === "string" ? turn.assistantMessage.toLowerCase() : "";
    const hasMarker = GATE_POLICY.preliminaryMarkers.some(function (m) {
      return msg.includes(m);
    });
    if (!hasMarker) issues.push("preliminary_missing_disclaimer");
  }

  return { ok: issues.length === 0, issues };
}

function isLowSignalUserText(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return true;
  if (t.length <= GATE_POLICY.lowEngagementMaxChars) {
    for (let i = 0; i < GATE_POLICY.lowEngagementPhrases.length; i += 1) {
      if (t === GATE_POLICY.lowEngagementPhrases[i] || t.includes(GATE_POLICY.lowEngagementPhrases[i])) {
        return true;
      }
    }
    if (t.length <= 12) return true;
  }
  return GATE_POLICY.lowEngagementPhrases.some(function (p) {
    return t === p;
  });
}

export function countLowEngagementStreak(history, message) {
  let streak = 0;
  if (isLowSignalUserText(message)) streak += 1;
  else return 0;

  for (let i = (history || []).length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (!item || item.role !== "user") continue;
    if (isLowSignalUserText(item.content)) streak += 1;
    else break;
  }
  return streak;
}

export function isPreliminaryAllowed(turn, history, message) {
  if (!turn || turn.recommendationMode !== "preliminary") return false;
  if (!turn.lowEngagement) return false;
  const streak = countLowEngagementStreak(history, message);
  return streak >= GATE_POLICY.lowEngagementMinStreak;
}

export function buildClarifyFromNeed(nextInformationNeed, _clarifyFallbackMessage) {
  // Fallback text is NOT trusted here — use selectClarifyMessage for client routing.
  const focus =
    nextInformationNeed && typeof nextInformationNeed.focus === "string"
      ? nextInformationNeed.focus
      : "none";
  if (focus && focus !== "none" && FOCUS_PROMPTS[focus]) {
    return FOCUS_PROMPTS[focus];
  }
  return "Спасибо. Чтобы предложить действительно полезное направление, уточните ещё один важный момент о ваших клиентах или о том, как сейчас устроена работа с ними.";
}

/**
 * First missing critical block in stable MVB order (evaluateBriefReady order).
 * Optional coverage/userTurns enable NO-REPEAT skip of already-known fields.
 */
export function resolveServerFocus(missing, coverage, userTurns) {
  const target = resolveClarifyTarget(missing, coverage, userTurns);
  return target.focus;
}

function missingIncludesFocus(missing, focus) {
  if (!focus || focus === "none") return false;
  for (let i = 0; i < (missing || []).length; i += 1) {
    if (missing[i] && missing[i].key === focus) return true;
  }
  return false;
}

/**
 * Safe non-MVB text when coverage is ready but recommendation could not be published.
 * Never maps to a closed critical field prompt.
 */
export const READY_REPAIR_FALLBACK =
  "Спасибо — ключевых деталей для чернового направления уже достаточно. " +
  "Сейчас не удалось безопасно собрать рекомендацию. Напишите ещё раз, " +
  "и я продолжу с уже собранного брифа без повторных уточняющих вопросов.";

/**
 * Client clarify text with NO-REPEAT + partial-aspect rules.
 * coverage + userTurns optional but recommended for production routing.
 */
export function selectClarifyMessage(turn, missing, coverage, userTurns) {
  const target = resolveClarifyTarget(missing, coverage, userTurns);
  const serverFocus = target.focus;
  const aspect = target.aspect;
  const modelFocus =
    turn && turn.nextInformationNeed && typeof turn.nextInformationNeed.focus === "string"
      ? turn.nextInformationNeed.focus
      : "none";
  const fallback =
    turn && typeof turn.clarifyFallbackMessage === "string"
      ? turn.clarifyFallbackMessage.trim()
      : "";

  if (!serverFocus) {
    return READY_REPAIR_FALLBACK;
  }

  // Model may only supply fallback when focus matches AND (for audience) not a full re-ask
  // when only one aspect is missing — prefer aspect-specific server prompt.
  const focusAligned =
    modelFocus === serverFocus &&
    modelFocus !== "none" &&
    missingIncludesFocus(missing, modelFocus) &&
    Boolean(FOCUS_PROMPTS[modelFocus]) &&
    !(serverFocus === "audienceInput" && aspect);

  if (fallback && focusAligned && !isServerFocusPrompt(fallback)) {
    // Allow contextual model wording for the same field, but never a full FOCUS_PROMPT
    // duplicate when we need aspect-only clarification.
    return fallback;
  }

  if (fallback && focusAligned && !aspect) {
    return fallback;
  }

  const prompt = promptForFocus(serverFocus, aspect);
  if (prompt) return prompt;
  return buildClarifyFromNeed({ focus: serverFocus, reason: "server" }, "");
}

/** True when history has no prior user turns (current message is first). */
export function isFirstUserTurn(history) {
  const items = Array.isArray(history) ? history : [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item && item.role === "user" && isNonEmptyString(item.content)) return false;
  }
  return true;
}

function isExactFocusPrompt(text) {
  return isServerFocusPrompt(text);
}

/**
 * Structural welcome safety: identity present, not an MVB focus prompt dump,
 * and turn is not in recommend/preliminary mode.
 */
export function isSafeWelcomeText(text, turn) {
  const t = typeof text === "string" ? text.trim() : "";
  if (t.length < 60) return false;
  if (!/Марк/i.test(t) || !/Оксан/i.test(t)) return false;
  if (!/AI|ИИ/i.test(t)) return false;
  if (isExactFocusPrompt(t)) return false;
  if (turn && (turn.recommendationMode === "normal" || turn.recommendationMode === "preliminary")) {
    return false;
  }
  if (turn && (turn.phase === "recommend" || turn.phase === "handoff")) return false;
  if (turn && turn.expertPlan && typeof turn.expertPlan === "object") return false;
  return true;
}

/**
 * Light contextual ack from user words only — no niche invention.
 * If the first message is already substantive, do not ask to retell it.
 */
export function buildFirstTurnWelcome(message) {
  const msg = typeof message === "string" ? message.trim() : "";
  const substantive =
    msg.length >= 90 &&
    (/(гостев|магазин|студи|перевоз|репетитор|преподав|услуг|производ|упаков|бренд|клиник|салон|цветоч|букет|груз|интернет-?магазин)/i.test(
      msg
    ) ||
      /(?:нужен|нужна|нужно)\s+(?:сайт|страниц)|хочу\s+(?:больше|сайт)|сейчас\s+(?:основн|заказ|бронир)|оставит[ьи]\s+заявк/i.test(
        msg
      ));

  if (substantive) {
    return (
      "Здравствуйте. Я Марк, AI-помощник Оксаны Ежевской. Спасибо — я уже учёл то, что вы написали, " +
      "и не буду просить рассказывать это заново. Это не анкета. " +
      "Чтобы предложить полезное направление, уточню только недостающее: " +
      "кто чаще всего к вам обращается и что этим людям обычно важно при выборе — если вы ещё не успели это описать."
    );
  }

  let topic = "о вашей задаче";
  if (/гостев/i.test(msg)) topic = "про гостевой дом и задачу";
  else if (/отел|гостиниц/i.test(msg)) topic = "про ваш объект и задачу";
  else if (/магазин|товар/i.test(msg)) topic = "про ваш магазин и задачу";
  else if (/цветоч|букет/i.test(msg)) topic = "про цветочную студию и задачу";
  else if (/преподав|репетитор|ученик/i.test(msg)) topic = "про преподавание и задачу";
  else if (/перевоз|груз/i.test(msg)) topic = "про перевозки и задачу";
  else if (/услуг|сервис/i.test(msg)) topic = "про ваши услуги и задачу";
  else if (/бизнес/i.test(msg)) topic = "про ваш бизнес и задачу";

  return (
    "Здравствуйте. Я Марк, AI-помощник Оксаны Ежевской. Спасибо, что написали. " +
    "Расскажите своими словами " +
    topic +
    ": что сейчас не устраивает, зачем вы думаете о сайте или другом решении и какой результат был бы для вас хорошим. " +
    "Это не анкета — начните с того, что считаете важным."
  );
}

/**
 * First-turn client text: prefer model welcome when structurally safe; else server welcome.
 * Never publishes recommend prose; never uses MVB FOCUS_PROMPT.
 */
export function selectFirstTurnMessage(turn, message) {
  const fallback =
    turn && typeof turn.clarifyFallbackMessage === "string"
      ? turn.clarifyFallbackMessage.trim()
      : "";
  if (isSafeWelcomeText(fallback, turn)) return fallback;

  const assistant =
    turn && typeof turn.assistantMessage === "string" ? turn.assistantMessage.trim() : "";
  if (isSafeWelcomeText(assistant, turn)) return assistant;

  return buildFirstTurnWelcome(message);
}

/**
 * Enforce gates. Returns public-safe turn fields + diagnostics (not for client).
 * Recommend path may expose assistantMessage; clarify path must NOT (openai routes separately).
 */
export function enforceGates(turn, { history, message }) {
  const userTurns = buildUserTurns(history, message);
  const coverageEval = evaluateBriefReady(turn.briefCoverage, userTurns);
  const wantsRecommend =
    turn.phase === "recommend" ||
    turn.phase === "handoff" ||
    turn.recommendationMode === "normal" ||
    turn.recommendationMode === "preliminary";

  const mode = turn.recommendationMode || "none";
  const conflicts = [];

  if (mode === "none" && (turn.phase === "recommend" || turn.phase === "handoff")) {
    conflicts.push("phase_recommend_with_mode_none");
    return {
      action: "block_recommend",
      reason: "mode_conflict",
      conflicts,
      coverageEval,
      userTurns,
      publicTurn: null
    };
  }
  if (mode === "normal" && turn.phase === "clarify") {
    conflicts.push("mode_normal_with_phase_clarify");
  }

  if (mode === "preliminary" || (wantsRecommend && turn.lowEngagement && mode !== "normal")) {
    if (!isPreliminaryAllowed({ ...turn, recommendationMode: "preliminary" }, history, message)) {
      return {
        action: "block_recommend",
        reason: "preliminary_not_allowed",
        conflicts,
        coverageEval,
        userTurns,
        publicTurn: null
      };
    }
    const planEval = evaluateExpertPlan(
      { ...turn, recommendationMode: "preliminary" },
      coverageEval.coverage
    );
    if (!planEval.ok) {
      return {
        action: "block_recommend",
        reason: "gate2_fail",
        gate2Issues: planEval.issues,
        conflicts,
        coverageEval,
        userTurns,
        publicTurn: null
      };
    }
    return {
      action: "allow",
      reason: "preliminary_ok",
      conflicts,
      coverageEval,
      userTurns,
      publicTurn: {
        assistantMessage: turn.assistantMessage,
        phase: turn.phase === "handoff" ? "handoff" : "recommend",
        done: Boolean(turn.done)
      }
    };
  }

  if (mode === "normal" || (wantsRecommend && mode !== "preliminary" && mode !== "none")) {
    if (!coverageEval.ready) {
      return {
        action: "block_recommend",
        reason: "gate1_fail",
        missing: coverageEval.missing,
        conflicts,
        coverageEval,
        userTurns,
        publicTurn: null
      };
    }
    const planEval = evaluateExpertPlan(
      { ...turn, recommendationMode: "normal" },
      coverageEval.coverage
    );
    if (!planEval.ok) {
      return {
        action: "block_recommend",
        reason: "gate2_fail",
        gate2Issues: planEval.issues,
        conflicts,
        coverageEval,
        userTurns,
        publicTurn: null
      };
    }
    return {
      action: "allow",
      reason: "normal_ok",
      conflicts,
      coverageEval,
      userTurns,
      publicTurn: {
        assistantMessage: turn.assistantMessage,
        phase: turn.phase === "handoff" ? "handoff" : "recommend",
        done: Boolean(turn.done)
      }
    };
  }

  // Clarify path — publicTurn.assistantMessage is intentionally unused by openai routing.
  return {
    action: "allow",
    reason: "clarify_ok",
    conflicts,
    coverageEval,
    userTurns,
    publicTurn: {
      assistantMessage: selectClarifyMessage(
        turn,
        coverageEval.missing,
        coverageEval.coverage,
        userTurns
      ),
      phase: "clarify",
      done: false
    }
  };
}

/**
 * First real missing critical key, or null when missing is empty.
 * Never defaults to audienceInput (or any field) without an actual gap.
 */
export function pickMissingFocus(missing) {
  if (!missing || !missing.length) return null;
  const key = missing[0] && missing[0].key;
  if (!key || key === "none") return null;
  return key;
}
