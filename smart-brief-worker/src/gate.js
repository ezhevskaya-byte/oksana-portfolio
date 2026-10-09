import { GATE_POLICY, LIMITS } from "./config.js";
import { CRITICAL_COVERAGE_KEYS } from "./schema.js";
import {
  evaluateDialogueReady,
  planNextUsefulStep,
  shouldAskSolutionDiscriminator
} from "./dialogue.js";

/**
 * Letter/digit run for Russian morphology. JS \\w does NOT match Cyrillic,
 * so patterns like социальн\\w*\\s+сет silently fail on «социальных сетях».
 */
const R = "[а-яёa-z0-9]*";

const FOCUS_PROMPTS = {
  business: "Расскажите немного подробнее о вашем бизнесе: чем именно вы занимаетесь и что предлагаете клиентам?",
  goal: "Какого результата вы хотите добиться в первую очередь — что должно измениться в бизнесе?",
  audienceInput:
    "Кто чаще всего к вам обращается, и что этим людям обычно важно при выборе?",
  audienceInput_who_or_segment:
    "Кто чаще всего к вам обращается — какой это тип клиентов?",
  audienceInput_what_matters:
    "А что для этих людей обычно важнее всего при выборе?",
  customerJourney:
    "Как сейчас обычно проходит путь клиента: от первого знакомства до заявки или покупки?",
  customerJourney_after_source:
    "А что происходит дальше: как человек связывается с вами и как получает нужную информацию или оформляет заявку?",
  customerJourney_after_contact:
    "Как обычно проходит следующий шаг после первого контакта — уточнение деталей, оценка задачи, оформление — и что происходит дальше?",
  friction: "Что в работе вашего бизнеса вы хотели бы улучшить в первую очередь?",
  existingTools:
    "Какими инструментами вы уже пользуетесь: сайт, соцсети, CRM, таблицы, заявки, бот?",
  existingTools_beyond_channels:
    "Помимо переписки — чем ещё вы уже пользуетесь в работе: таблицы, календарь, CRM, заявки, бот — или почти всё вручную?",
  desiredFlow:
    "Как бы вы хотели, чтобы этот первый этап общения с клиентом выглядел в идеале?",
  desiredFlow_client_autonomy:
    "Как бы вы хотели, чтобы этот первый этап выглядел в идеале?"
};

function journeySourceHint(text) {
  const q = normalizeSpan(text);
  if (!q) return null;
  if (new RegExp("соцсет|социальн" + R + "\\s+сет|инстаграм|instagram").test(q)) {
    return "основной источник — соцсети";
  }
  if (/авито/.test(q)) return "люди часто находят вас через Авито";
  if (/реклам/.test(q)) return "основной канал — реклама";
  if (/объявлен/.test(q)) return "основной канал — объявления";
  if (/whatsapp|ватсап/.test(q) && /приход|наход|узнают|приходят/.test(q)) {
    return "основной канал — WhatsApp";
  }
  return null;
}

function combineAllUserText(userTurns) {
  const parts = [];
  for (let i = 0; i < (userTurns || []).length; i += 1) {
    if (userTurns[i] && isNonEmptyString(userTurns[i].text)) parts.push(userTurns[i].text);
  }
  return normalizeSpan(parts.join(" "));
}

function firstGroundedQuote(sources) {
  const list = sources || [];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && isNonEmptyString(list[i].quote)) return String(list[i].quote).trim();
  }
  return "";
}

/** True if fragment ends with a dangling preposition / incomplete cut. */
function hasDanglingPreposition(text) {
  return /\b(через|для|с|со|из|на|от|по|о|об|про|без|до|при|над|под|между|вместо|вроде|около)\s*[,:;.—–-]?\s*$/i.test(
    String(text || "").trim()
  );
}

function isSafeAckFragment(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t || t.length < 6 || t.length > 110) return false;
  if (hasDanglingPreposition(t)) return false;
  if (/[,;:]\s*$/.test(t)) return false;
  // Avoid JS \\b — it does not treat Cyrillic as word chars.
  if (/(?:^|[^а-яёa-z])у меня(?:[^а-яёa-z]|$)/i.test(t)) return false;
  if (/(?:^|[^а-яёa-z])у нас(?:[^а-яёa-z]|$)/i.test(t)) return false;
  if (/(?:^|[^а-яёa-z])мы (?:[^а-яёa-z]|$)/i.test(" " + t)) return false;
  if (/(?:^|[.!?]\s)я (?:[а-яё])/i.test(t)) return false;
  if (/(?:^|[^а-яёa-z])(?:наш|моя|мой|мое|моё)(?:[^а-яёa-z]|$)/i.test(t)) return false;
  return true;
}

/**
 * Shift user self-reference → assistant addressing the user.
 * Works on a short complete clause — not on surgically trimmed raw dumps.
 */
function shiftPerspectiveToAssistant(sentence) {
  let t = String(sentence || "").replace(/\s+/g, " ").trim().replace(/[.!?…]+$/g, "");
  if (!t) return "";

  const verbYa = {
    оказываю: "оказываете",
    делаю: "делаете",
    занимаюсь: "занимаетесь",
    запускаю: "запускаете",
    веду: "ведёте",
    продаю: "продаёте",
    преподаю: "преподаёте",
    работаю: "работаете",
    помогаю: "помогаете",
    консультирую: "консультируете",
    сопровождаю: "сопровождаете"
  };
  const verbMy = {
    сдаём: "сдаёте",
    сдаем: "сдаёте",
    делаем: "делаете",
    оказываем: "оказываете",
    занимаемся: "занимаетесь",
    продаём: "продаёте",
    продаем: "продаёте",
    ведём: "ведёте",
    ведем: "ведёте",
    работаем: "работаете",
    помогаем: "помогаете",
    запускаем: "запускаете"
  };

  t = t.replace(/^[Яя]\s+(\S+)/, function (_m, verb) {
    const key = String(verb || "").toLowerCase();
    if (verbYa[key]) return "вы " + verbYa[key];
    return "вы " + verb;
  });
  t = t.replace(/^[Мм]ы\s+(\S+)/, function (_m, verb) {
    const key = String(verb || "").toLowerCase();
    if (verbMy[key]) return "вы " + verbMy[key];
    return "вы " + verb;
  });

  // No \\b — Cyrillic is not a JS word character.
  t = t.replace(/(^|[^а-яёА-ЯЁa-zA-Z])[Уу]\s+меня(?=[^а-яёА-ЯЁa-zA-Z]|$)/g, "$1у вас");
  t = t.replace(/(^|[^а-яёА-ЯЁa-zA-Z])[Уу]\s+нас(?=[^а-яёА-ЯЁa-zA-Z]|$)/g, "$1у вас");
  t = t.replace(/(^|[^а-яёА-ЯЁa-zA-Z])мне(?=[^а-яёА-ЯЁa-zA-Z]|$)/gi, "$1вам");
  t = t.replace(/(^|[^а-яёА-ЯЁa-zA-Z])нас(?=[^а-яёА-ЯЁa-zA-Z]|$)/gi, "$1вас");
  t = t.replace(/(^|[^а-яёА-ЯЁa-zA-Z])наш(а|у|и|их|ей|его|ему|ими|им)?(?=[^а-яёА-ЯЁa-zA-Z]|$)/gi, function (
    _m,
    lead,
    end
  ) {
    return lead + "ваш" + (end || "");
  });
  t = t.replace(
    /(^|[^а-яёА-ЯЁa-zA-Z])мо(й|я|ю|ё|е|и|их|им|ими|его|ему|ей)(?=[^а-яёА-ЯЁa-zA-Z]|$)/gi,
    function (_m, lead, end) {
      const map = {
        й: "ваш",
        я: "ваша",
        ю: "вашу",
        ё: "ваше",
        е: "ваше",
        и: "ваши",
        их: "ваших",
        им: "вашим",
        ими: "вашими",
        его: "вашего",
        ему: "вашему",
        ей: "вашей"
      };
      return lead + (map[String(end || "").toLowerCase()] || "ваш");
    }
  );

  // Lowercase start — joins after «Понял:».
  if (t) t = t.charAt(0).toLowerCase() + t.slice(1);
  return t;
}

function splitAckClauses(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const bySentence = raw.split(/(?<=[.!?…])\s+/).map(function (s) {
    return s.trim();
  }).filter(Boolean);
  const out = [];
  for (let i = 0; i < bySentence.length; i += 1) {
    const s = bySentence[i];
    // Also allow a short identity clause before the first comma.
    if (/,/.test(s) && s.length > 60) {
      const head = s.slice(0, s.indexOf(",")).trim();
      if (head) out.push(head);
    }
    out.push(s.replace(/[.!?…]+$/g, "").trim());
  }
  return out.filter(Boolean);
}

function looksLikeBusinessIdentity(clause) {
  // Ack identity must stay aligned with coverage recovery.
  return looksLikeBusinessEvidence(clause);
}

/**
 * Compact business fact for acknowledgement — never a raw mid-sentence clip.
 */
function extractNormalizedBusinessFact(coverage, userTurns) {
  const candidates = [];
  const bizQuote = firstGroundedQuote(
    coverage && coverage.business && coverage.business.sources ? coverage.business.sources : []
  );
  if (bizQuote) {
    const parts = splitAckClauses(bizQuote);
    for (let i = 0; i < parts.length; i += 1) candidates.push(parts[i]);
  }
  const turnsText = combineAllUserText(userTurns);
  if (turnsText) {
    const parts = splitAckClauses(turnsText);
    for (let i = 0; i < parts.length; i += 1) candidates.push(parts[i]);
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const clause = compactBusinessIdentityClause(candidates[i]);
    if (!looksLikeBusinessIdentity(clause)) continue;
    const shifted = shiftPerspectiveToAssistant(clause);
    if (isSafeAckFragment(shifted)) return shifted;
  }
  return "";
}

function sourceHintOverlapsFact(hint, fact) {
  const h = normalizeSpan(hint);
  const f = normalizeSpan(fact);
  if (!h || !f) return false;
  if (/соцсет/.test(h) && /соцсет|инстаграм|instagram|вконтакте|telegram|телеграм/.test(f)) {
    return true;
  }
  if (/авито/.test(h) && /авито/.test(f)) return true;
  if (/реклам/.test(h) && /реклам/.test(f)) return true;
  if (/объявлен/.test(h) && /объявлен/.test(f)) return true;
  if (/whatsapp|ватсап/.test(h) && /whatsapp|ватсап/.test(f)) return true;
  if (/рекоменд/.test(h) && /рекоменд|сарафан/.test(f)) return true;
  return false;
}

function extractNormalizedSourceFact(coverage, userTurns) {
  const journeyText = combineSourceQuotes(
    coverage && coverage.customerJourney && coverage.customerJourney.sources
      ? coverage.customerJourney.sources
      : []
  );
  const blob = journeyText || combineAllUserText(userTurns);
  let hint = journeySourceHint(blob);
  if (!hint) {
    const t = normalizeSpan(blob);
    if (/рекомендац|сарафан/.test(t)) hint = "основные обращения приходят по рекомендациям";
    else if (/вконтакте|\bvk\b|telegram|телеграм/.test(t) && /заявк|приход|наход|иду|из\s/.test(t)) {
      hint = "заявки в основном из мессенджеров и соцсетей";
    }
  }
  return hint;
}

/**
 * Prefer business identity before an assortment colon-list:
 * «магазин текстиля: бельё, полотенца…» → «магазин текстиля».
 */
function compactBusinessIdentityClause(clause) {
  const t = String(clause || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  const colonIdx = t.indexOf(":");
  if (colonIdx > 15) {
    const head = t.slice(0, colonIdx).trim();
    if (looksLikeBusinessEvidence(head) && head.length >= 18 && head.length <= 110) {
      return head;
    }
  }
  return t;
}

function enrichBusinessFactWithOffline(businessFact, userTurns) {
  const fact = String(businessFact || "").trim();
  if (!fact) return "";
  const blob = combineAllUserText(userTurns);
  if (!/офф?лайн|offline/.test(blob)) return fact;
  if (/офф?лайн|offline/.test(fact)) return fact;
  if (/магазин/.test(fact)) {
    return fact.replace(/магазин/, "офлайн-магазин");
  }
  return fact;
}

function ackFactOverlaps(a, b) {
  const x = normalizeSpan(a);
  const y = normalizeSpan(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 12 && y.indexOf(x) !== -1) return true;
  if (y.length >= 12 && x.indexOf(y) !== -1) return true;
  return false;
}

function compactWhoAckPhrase(quote) {
  let t = String(quote || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?…]+$/g, "");
  if (!t) return "";
  // Keep ack short: drop age bands (WHO still stored in coverage).
  t = t.replace(/,?\s*\d{1,2}\s*[–\-—]\s*\d{1,2}(?:\s*(?:лет|года))?/gi, "");
  t = t.replace(/\s{2,}/g, " ").trim().replace(/[,\s]+$/g, "");
  return t;
}

function extractNormalizedWhoFact(coverage, userTurns) {
  const turnsById = turnMap(userTurns || []);
  const candidates = [];
  const sources =
    coverage && coverage.audienceInput && Array.isArray(coverage.audienceInput.sources)
      ? coverage.audienceInput.sources
      : [];
  for (let i = 0; i < sources.length; i += 1) {
    const src = sources[i];
    if (!src || src.aspect !== "who_or_segment") continue;
    if (!isNonEmptyString(src.quote) || !isAudienceWhoEvidence(src.quote)) continue;
    if (!turnsById[src.turnId] || !quoteGroundedInTurn(src.quote, turnsById[src.turnId])) continue;
    candidates.push(String(src.quote).trim());
  }
  for (let t = 0; t < (userTurns || []).length; t += 1) {
    const turn = userTurns[t];
    if (!turn || !isNonEmptyString(turn.text)) continue;
    const spans = candidateSpans(turn.text);
    for (let s = 0; s < spans.length; s += 1) {
      if (isAudienceWhoEvidence(spans[s])) candidates.push(spans[s]);
    }
  }

  let best = "";
  for (let i = 0; i < candidates.length; i += 1) {
    const compact = compactWhoAckPhrase(candidates[i]);
    if (!compact || compact.length > 90) continue;
    if (!isAudienceWhoEvidence(compact) && !isAudienceWhoEvidence(candidates[i])) continue;
    const shifted = shiftPerspectiveToAssistant(compact);
    if (!shifted || shifted.length > 100) continue;
    if (shifted.length < 6 || hasDanglingPreposition(shifted)) continue;
    if (/(?:^|[^а-яёa-z])у меня(?:[^а-яёa-z]|$)/i.test(shifted)) continue;
    if (!best || shifted.length < best.length) best = shifted;
  }
  return best;
}

function extractNormalizedGoalFact(coverage, userTurns) {
  const candidates = [];
  const sources =
    coverage && coverage.goal && Array.isArray(coverage.goal.sources) ? coverage.goal.sources : [];
  for (let i = 0; i < sources.length; i += 1) {
    if (sources[i] && isNonEmptyString(sources[i].quote) && looksLikeGoalEvidence(sources[i].quote)) {
      candidates.push(String(sources[i].quote).trim());
    }
  }
  for (let t = 0; t < (userTurns || []).length; t += 1) {
    const turn = userTurns[t];
    if (!turn || !isNonEmptyString(turn.text)) continue;
    const spans = candidateSpans(turn.text);
    for (let s = 0; s < spans.length; s += 1) {
      if (looksLikeGoalEvidence(spans[s])) candidates.push(spans[s]);
    }
  }

  let best = "";
  for (let i = 0; i < candidates.length; i += 1) {
    let g = String(candidates[i] || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.!?…]+$/g, "");
    if (!g || g.length > 140) continue;
    const soft = g.match(/(?:хотелось\s+бы|хочу|хочется|хотим)\s+(.+)$/i);
    if (soft && soft[1] && looksLikeGoalEvidence(g)) {
      g = soft[1].trim();
    } else {
      const sales = g.match(
        /((?:увеличить|вырастить)\s+продаж\w*(?:\s+и\s+привлечь\s+(?:нов\w*\s+)?(?:клиент|покупател)\w*)?|привлечь\s+(?:нов\w*\s+)?(?:клиент|покупател)\w*)/i
      );
      if (sales && sales[1]) g = sales[1].trim();
    }
    g = g.replace(/^(?:цель|задача)\s*[—\-–:]\s*/i, "").trim();
    if (!g || g.length < 8 || g.length > 90) continue;
    if (!best || g.length < best.length) best = g;
  }
  if (!best) return "";
  const lower = best.charAt(0).toLowerCase() + best.slice(1);
  return "цель — " + lower;
}

/**
 * Named channels already present in the user's words (no invented platforms).
 */
function extractNormalizedChannelFact(coverage, userTurns) {
  const blob = combineAllUserText(userTurns);
  if (!blob) return "";
  const named = [];
  if (/вконтакте|\bvk\b/.test(blob)) named.push("ВКонтакте");
  if (/телеграм|telegram/.test(blob)) named.push("Telegram");
  if (/инстаграм|instagram/.test(blob)) named.push("Instagram");
  if (/whatsapp|ватсап/.test(blob)) named.push("WhatsApp");
  if (!named.length) return "";
  if (named.length === 1) return "есть " + named[0];
  if (named.length === 2) return "есть " + named[0] + " и " + named[1];
  return "есть " + named.slice(0, -1).join(", ") + " и " + named[named.length - 1];
}

/**
 * Cyrillic-safe token boundary (JS \\b does not treat Cyrillic as word chars).
 */
function cyrToken(stem) {
  return "(?:^|[^а-яёa-z0-9])(?:" + stem + ")(?:[^а-яёa-z0-9]|$)";
}

/**
 * Score domains from grounded blob. Avoid substring traps (e.g. «отел» inside «хотелось»).
 */
export function scoreDialogueDomains(blobRaw) {
  const blob = normalizeSpan(blobRaw);
  const pad = " " + blob + " ";
  const scores = {
    lodging: 0,
    studio: 0,
    education: 0,
    b2b: 0,
    retail: 0,
    professional: 0,
    service: 0,
    generic: 0
  };

  if (
    new RegExp(
      cyrToken("гостев" + R + "|гостиниц" + R + "|апартамент" + R + "|посуточн" + R + "|отел[ьяеюи]"),
      "i"
    ).test(pad)
  ) {
    scores.lodging += 3;
  }
  if (new RegExp(cyrToken("сда[её]м\\s+номер"), "i").test(pad)) scores.lodging += 3;

  if (
    new RegExp(
      cyrToken(
        "йог" + R + "|фитнес|танц" + R + "|пилатес|салон|парикмах" + R + "|маникюр|мастер-?класс"
      ),
      "i"
    ).test(pad)
  ) {
    scores.studio += 3;
  }
  // «студия» alone is weak (кафе/студии); require class/schedule context.
  if (
    new RegExp(cyrToken("студи" + R), "i").test(pad) &&
    new RegExp(cyrToken("заняти" + R + "|расписан" + R + "|абонемент" + R + "|йог|пилатес|фитнес"), "i").test(
      pad
    )
  ) {
    scores.studio += 3;
  } else if (new RegExp(cyrToken("студия\\s+(?:йог|пилатес|танц|фитнес)"), "i").test(pad)) {
    scores.studio += 3;
  }
  if (new RegExp(cyrToken("заняти" + R), "i").test(pad) && scores.studio > 0) scores.studio += 1;

  if (
    new RegExp(
      cyrToken(
        "преподав" + R + "|репетитор|ученик" + R + "|курс" + R + "|обучен" + R + "|английск" + R + "|школ" + R
      ),
      "i"
    ).test(pad)
  ) {
    scores.education += 3;
  }

  if (
    new RegExp(cyrToken("бухгалтер" + R + "|юридическ" + R + "|консалт" + R + "|аудит" + R), "i").test(
      pad
    )
  ) {
    scores.professional += 3;
    scores.b2b += 2;
  }
  if (
    new RegExp(cyrToken("b2b|юрлиц" + R + "|оптов" + R + "|закупщик" + R + "|подрядчик" + R), "i").test(
      pad
    )
  ) {
    scores.b2b += 3;
  }
  if (/(?:^|[^а-яёa-z0-9])(?:ип|ооо)(?:[^а-яёa-z0-9]|$)/i.test(pad)) scores.b2b += 2;
  if (new RegExp(cyrToken("компани" + R + "|заказчик" + R + "|для\\s+бизнес"), "i").test(pad)) {
    scores.b2b += 2;
  }

  if (
    new RegExp(
      cyrToken(
        "магазин" +
          R +
          "|товар" +
          R +
          "|ассортимент|покупател" +
          R +
          "|интернет-?магазин" +
          R +
          "|продаж" +
          R
      ),
      "i"
    ).test(pad)
  ) {
    scores.retail += 3;
  }

  // Local service / repair — not CRM/queue by default; problem shape still leads.
  if (
    new RegExp(
      cyrToken(
        "ремонт" +
          R +
          "|автосервис|шиномонтаж|мастерск" +
          R +
          "|починк" +
          R +
          "|сервис\\s+по\\s+|бытов" +
          R +
          "\\s+услуг|химчист" +
          R +
          "|велосипед" +
          R
      ),
      "i"
    ).test(pad)
  ) {
    scores.service = (scores.service || 0) + 3;
  }

  return scores;
}

function pickDomainFromScores(scores) {
  let best = "generic";
  let bestScore = 0;
  const keys = Object.keys(scores);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (k === "generic") continue;
    if (scores[k] > bestScore) {
      bestScore = scores[k];
      best = k;
    }
  }
  // Accounting / legal / consulting: prefer professional lexicon even if B2B also scores high.
  if (scores.professional >= 3) return "professional";
  return bestScore > 0 ? best : "generic";
}

/**
 * Domain lexicon from accumulated evidence — persistent across the whole dialogue.
 */
export function inferDialogueContext(coverage, userTurns) {
  const fromTurns = combineAllUserText(userTurns);
  const fromBiz = combineSourceQuotes(
    coverage && coverage.business && coverage.business.sources ? coverage.business.sources : []
  );
  const blob = normalizeSpan(fromBiz + " " + fromBiz + " " + fromTurns);
  const scores = scoreDialogueDomains(blob);
  const bizScores = scoreDialogueDomains(fromBiz || "");
  let domain = pickDomainFromScores(bizScores);
  if (domain === "generic") domain = pickDomainFromScores(scores);
  const later = pickDomainFromScores(scores);
  if (
    (domain === "b2b" || domain === "professional") &&
    (later === "lodging" || later === "studio") &&
    scores[later] < scores[domain] + 4
  ) {
    // keep professional/b2b locked against weak false positives
  } else if (domain === "generic") {
    domain = later;
  } else if (later !== domain && scores[later] >= scores[domain] + 3) {
    domain = later;
  }

  let people = "клиенты";
  let peoplePrep = "клиентов";
  let whoAsk = "А кто чаще всего к вам обращается — кто ваши основные клиенты?";
  let mattersAsk = "А что для этих людей обычно важнее всего при выборе?";
  let toolsAsk =
    "Помимо переписки — чем ещё вы уже пользуетесь в работе: таблицы, календарь, CRM, заявки, бот — или почти всё вручную?";
  let flowAsk = "Как бы вы хотели, чтобы этот первый этап общения с клиентом выглядел в идеале?";
  let goalAsk = "Какого результата вы хотите добиться в первую очередь?";
  let solutionAsk =
    "На старте для вас важнее просто собрать обращение или сразу какой-то следующий шаг — например уточнение деталей или запись?";
  let journeyAfterContact =
    "Как обычно проходит следующий шаг после первого контакта — уточнение деталей, оценка задачи, оформление — и что происходит дальше?";
  let journeyAfterSource =
    "А что обычно происходит дальше — как человек связывается с вами и как доходит до заявки или следующего шага?";

  if (domain === "lodging") {
    people = "гости";
    peoplePrep = "гостей";
    whoAsk = "А кто чаще всего останавливается у вас — семьи, пары, компании?";
    mattersAsk = "А что для гостей обычно важнее всего при выборе места?";
    toolsAsk =
      "Помимо объявлений и переписки — чем ещё вы уже ведёте брони: таблицы, календарь, модуль бронирования, CRM — или почти всё вручную?";
    flowAsk = "Как бы вы хотели, чтобы гость проходил путь от интереса до брони в идеале?";
    goalAsk = "Какого результата вы хотите добиться в первую очередь для гостевого дома?";
    solutionAsk =
      "Нужна ли гостю оплата сразу при бронировании, или пока достаточно заявки без онлайн-оплаты?";
    journeyAfterContact =
      "Как обычно проходит следующий шаг: уточнение дат и деталей, бронь или оплата — и что происходит после этого?";
    journeyAfterSource =
      "А что обычно происходит дальше — как гость связывается с вами и как доходит до брони или заявки?";
  } else if (domain === "studio") {
    whoAsk = "А кто обычно приходит к вам на занятия — кто ваши основные клиенты?";
    mattersAsk = "А что для них обычно важнее всего при выборе занятий?";
    toolsAsk =
      "Помимо сообщений — чем ещё вы уже ведёте записи: таблица, календарь, CRM, сервис записи — или почти всё вручную?";
    flowAsk = "Как бы вы хотели, чтобы запись на занятия выглядела в идеале — для клиента и для вас?";
    solutionAsk =
      "Нужно ли клиенту оплачивать занятие сразу при записи, или пока достаточно забронировать место без онлайн-оплаты?";
    journeyAfterContact =
      "Как обычно проходит следующий шаг после первого сообщения: уточнение деталей, запись на занятие — и что происходит дальше?";
    journeyAfterSource =
      "А что обычно происходит дальше — как человек связывается с вами и как доходит до записи?";
  } else if (domain === "education") {
    people = "ученики";
    peoplePrep = "учеников";
    whoAsk = "А кто чаще всего к вам приходит учиться — кто ваши основные ученики?";
    mattersAsk = "А что для них обычно важнее всего при выборе занятий или преподавателя?";
    toolsAsk =
      "Помимо переписки — чем ещё вы уже ведёте работу: таблица, календарь, CRM, запись — или почти всё вручную?";
    flowAsk = "Как бы вы хотели, чтобы первый контакт и запись на занятия выглядели в идеале?";
    solutionAsk = "Нужна ли оплата сразу при заявке, или пока достаточно записи без онлайн-оплаты?";
    journeyAfterContact =
      "Как обычно проходит следующий шаг: уточнение цели и формата, пробное занятие или старт — и что дальше?";
  } else if (domain === "b2b" || domain === "professional") {
    people = domain === "professional" ? "клиенты" : "заказчики";
    peoplePrep = domain === "professional" ? "клиентов" : "заказчиков";
    whoAsk =
      domain === "professional"
        ? "А кто чаще всего к вам обращается — какой это тип клиентов или бизнесов?"
        : "А кто обычно принимает решение о сотрудничестве на стороне клиента?";
    mattersAsk =
      domain === "professional"
        ? "А что для этих людей обычно важнее всего при выборе специалиста или услуг?"
        : "А что для этих людей обычно важнее всего при выборе подрядчика или решения?";
    toolsAsk =
      "Помимо переписки — чем ещё вы уже ведёте обращения и клиентов: таблицы, CRM, заметки, заявки, бот — или почти всё вручную?";
    flowAsk =
      "Как бы вы хотели, чтобы выглядел идеальный первый этап — от интереса человека до вашего личного разговора?";
    solutionAsk =
      "Эти предварительные вопросы к клиенту у вас примерно одинаковые для большинства обращений, или сильно зависят от ситуации?";
    journeyAfterContact =
      "Как обычно проходит следующий шаг после первого сообщения: уточнение задачи, оценка объёма, обсуждение условий — и что происходит дальше?";
    journeyAfterSource =
      "А что обычно происходит дальше — как человек связывается с вами и как вы доходите до следующего шага по обращению?";
  } else if (domain === "retail") {
    people = "покупатели";
    peoplePrep = "покупателей";
    whoAsk = "А кто чаще всего у вас покупает — кто ваши основные покупатели?";
    toolsAsk =
      "Помимо переписки — чем ещё вы уже ведёте заказы: таблицы, CRM, витрина, бот — или почти всё вручную?";
    flowAsk = "Как бы вы хотели, чтобы путь от интереса к заказу выглядел в идеале?";
    solutionAsk = "Нужна ли онлайн-оплата сразу при заказе, или пока достаточно заявки?";
    journeyAfterContact =
      "Как обычно проходит следующий шаг: уточнение заказа, оплата или отправка — и что происходит дальше?";
  } else if (domain === "service") {
    people = "клиенты";
    peoplePrep = "клиентов";
    whoAsk = "А кто чаще всего к вам обращается — кто ваши основные клиенты?";
    mattersAsk = "А что для этих людей обычно важнее всего при выборе сервиса?";
    toolsAsk =
      "Помимо телефона и переписки — чем ещё вы уже пользуетесь: таблицы, календарь, CRM, заявки, бот — или почти всё вручную?";
    flowAsk =
      "Как бы вы хотели, чтобы путь клиента от интереса до записи или заявки выглядел в идеале?";
    solutionAsk =
      "На старте важнее заранее показать цены и условия или сразу дать возможность записаться/оставить заявку?";
    journeyAfterContact =
      "Как обычно проходит следующий шаг после первого звонка или сообщения — оценка, запись, согласование — и что дальше?";
  }

  return {
    domain: domain,
    people: people,
    peoplePrep: peoplePrep,
    whoAsk: whoAsk,
    mattersAsk: mattersAsk,
    toolsAsk: toolsAsk,
    flowAsk: flowAsk,
    goalAsk: goalAsk,
    solutionAsk: solutionAsk,
    journeyAfterContact: journeyAfterContact,
    journeyAfterSource: journeyAfterSource,
    scores: scores,
    blob: blob
  };
}

/**
 * Natural acknowledgement from known facts — no internal system wording.
 */
/**
 * Natural acknowledgement from normalized grounded facts — never raw quote surgery.
 * Assistant perspective («у вас»), no dangling cuts, no source duplication.
 */
export function buildContextAcknowledgement(coverage, userTurns) {
  const businessRaw = extractNormalizedBusinessFact(coverage, userTurns);
  const businessFact = enrichBusinessFactWithOffline(businessRaw, userTurns);
  const whoFact = extractNormalizedWhoFact(coverage, userTurns);
  const goalFact = extractNormalizedGoalFact(coverage, userTurns);
  const channelFact = extractNormalizedChannelFact(coverage, userTurns);
  const sourceFact = extractNormalizedSourceFact(coverage, userTurns);

  const bits = [];
  if (businessFact) bits.push(businessFact);
  if (whoFact && !ackFactOverlaps(whoFact, businessFact)) bits.push(whoFact);
  if (
    goalFact &&
    !ackFactOverlaps(goalFact, businessFact) &&
    !ackFactOverlaps(goalFact, whoFact)
  ) {
    bits.push(goalFact);
  }

  // When WHO/GOAL already enrich the ack, keep channels as a short trailing clause.
  // Otherwise preserve legacy source-hint pairing (соцсети / Авито / рекомендации).
  let trailing = "";
  if (channelFact) {
    const joined = bits.join(" ");
    if (!/вконтакте|телеграм|telegram|instagram|инстаграм|whatsapp|ватсап/i.test(joined)) {
      trailing = channelFact;
    }
  } else if (
    bits.length <= 1 &&
    sourceFact &&
    !sourceHintOverlapsFact(sourceFact, businessFact)
  ) {
    bits.push(sourceFact);
  }

  if (!bits.length) return "Спасибо, что написали.";

  const main = bits.slice(0, 3);
  let ack = "";
  if (main.length === 1) ack = "Понял: " + main[0] + ".";
  else if (main.length === 2) ack = "Понял: " + main[0] + ", а " + main[1] + ".";
  else ack = "Понял: " + main[0] + ", " + main[1] + ", а " + main[2] + ".";

  if (trailing) {
    const trail =
      trailing.charAt(0).toUpperCase() + trailing.slice(1).replace(/[.!?…]+$/g, "");
    ack = ack.replace(/[.!?…]*\s*$/, "") + ". " + trail + ".";
  }
  return ack;
}

export function hasInternalSystemWording(text) {
  const t = normalizeSpan(text);
  if (!t) return false;
  return (
    /не\s+анкета/.test(t) ||
    /не\s+буду\s+просить/.test(t) ||
    /я\s+уже\s+учёл/.test(t) ||
    /учёл\s+то,?\s+что\s+вы\s+написали/.test(t) ||
    /следующий\s+вопрос/.test(t) ||
    /mvb|briefcoverage|nextinformationneed|customer_journey|desired_flow/.test(t)
  );
}

/**
 * Conservative strong implication for desiredFlow from goal + manual journey (+ friction).
 * Does not invent new facts — only promotes when path+goal already make self-serve intent clear.
 */
export function hasStrongDesiredFlowImplication(coverage, userTurns) {
  const goalOk = coverage && coverage.goal && coverage.goal.status === "known";
  const journeyOk =
    coverage && coverage.customerJourney && coverage.customerJourney.status === "known";
  if (!goalOk || !journeyOk) return false;

  const text = combineAllUserText(userTurns);
  const simplifyBooking =
    /упростить\s+запись|упростить\s+брон|меньше\s+ручн|без\s+(?:долгой\s+)?переписк|сам[аи]?\s+(?:записа|заброн|оформ)|чтобы\s+(?:клиент|человек|гость|ученик).{0,40}сам/.test(
      text
    );
  const manualPath =
    new RegExp(
      "вручную\\s+записыва|записыва" + R + "\\s+вручную|оформл" + R + "\\s+запись|администратор.{0,48}вручную|вед[её]т\\s+вручную"
    ).test(text) ||
    (/отвеча\w*\s+на\s+вопрос/.test(text) && /записыва|запис/.test(text));
  if (!(simplifyBooking && manualPath)) return false;

  // Require at least friction OR explicit owner-relief cue — avoid pure assumption.
  const relief =
    (coverage.friction && coverage.friction.status === "known") ||
    /не\s+приходилось|одни\s+и\s+те\s+же|заново\s+рассказ|повторя|вручную/.test(text);
  return Boolean(relief);
}

function recoverImpliedDesiredFlowSources(userTurns, coverage) {
  if (!hasStrongDesiredFlowImplication(coverage, userTurns)) return [];
  const turns = userTurns || [];
  for (let t = 0; t < turns.length; t += 1) {
    const turn = turns[t];
    if (!turn || !turn.id || !isNonEmptyString(turn.text)) continue;
    const spans = candidateSpans(turn.text);
    for (let i = 0; i < spans.length; i += 1) {
      const q = normalizeSpan(spans[i]);
      if (
        /упростить\s+запись|упростить\s+брон|сам[аи]?\s+(?:записа|заброн|посмотр|узна)|чтобы\s+(?:клиент|человек|гость|ученик).{0,48}(?:сам|мог)|без\s+(?:долгой\s+)?переписк/.test(
          q
        )
      ) {
        return [
          {
            turnId: turn.id,
            quote: spans[i],
            aspect: "ideal_flow",
            operation: "support"
          }
        ];
      }
    }
  }
  // Fall back to grounded goal quote as the implication anchor.
  const goalSources =
    coverage && coverage.goal && Array.isArray(coverage.goal.sources) ? coverage.goal.sources : [];
  for (let i = 0; i < goalSources.length; i += 1) {
    if (goalSources[i] && goalSources[i].turnId && goalSources[i].quote) {
      return [
        {
          turnId: goalSources[i].turnId,
          quote: goalSources[i].quote,
          aspect: "ideal_flow",
          operation: "support"
        }
      ];
    }
  }
  return [];
}

/**
 * Operational / product evidence used to distinguish solution classes.
 * One user answer may set several flags — not payment-only tunnel vision.
 */
export function collectSolutionEvidence(coverage, userTurns) {
  const text = combineAllUserText(userTurns);
  const toolsText = combineSourceQuotes(
    coverage && coverage.existingTools && coverage.existingTools.sources
      ? coverage.existingTools.sources
      : []
  );
  const flowText = combineSourceQuotes(
    coverage && coverage.desiredFlow && coverage.desiredFlow.sources
      ? coverage.desiredFlow.sources
      : []
  );
  const frictionText = combineSourceQuotes(
    coverage && coverage.friction && coverage.friction.sources
      ? coverage.friction.sources
      : []
  );
  const blob = normalizeSpan(text + " " + toolsText + " " + flowText + " " + frictionText);
  const ctx = inferDialogueContext(coverage, userTurns);

  const explicitProduct = new RegExp(
    "нужен\\s+сайт|хочу(?:\\s+\\S+){0,3}\\s+сайт|хочется\\s+свой\\s+сайт|свой\\s+сайт|" +
      "сайт(?:а)?\\s+почти\\s+нет|нужна\\s+страниц|прост" +
      R +
      "\\s+страниц|страниц[ауи]\\s+(?:для|курс)|понятн" +
      R +
      "\\s+(?:сайт|страниц)|думаю\\s+о\\s+сайт|сделать\\s+сайт|готовы?й\\s+сервис|нужен\\s+бот|нужна\\s+crm|не\\s+нужен\\s+сайт",
    "i"
  ).test(text);

  const noOnlinePayment = new RegExp(
    "онлайн-?оплат" +
      R +
      "\\s+не\\s+нуж|онлайн.{0,16}не\\s+нуж|оплат" +
      R +
      "\\s+не\\s+нуж|без\\s+(?:онлайн-?)?оплат|оплачивает.{0,40}студи|достаточно\\s+(?:самой\\s+)?запис|достаточно\\s+заявк|оплата\\s+пока|оплат" +
      R +
      "\\s+уже\\s+в\\s+студи|оплат" +
      R +
      "\\s+(?:на\\s+месте|на\\s+занят|в\\s+студи|в\\s+сервис|после\\s+(?:услуг|занят|пробн)|по\\s+сч[её]т|по\\s+договор)",
    "i"
  ).test(text);

  const paymentRequired = /предоплат|нужна\s+онлайн-?оплат|оплат\w*\s+сразу|онлайн-?оплат\w*\s+нуж/i.test(
    text
  );

  // QUEUE/CHAOS must be USER-stated — bare «заявка» / «вручную» / «нет CRM» is NOT queue chaos.
  const queueChaos =
    /хаос\s+(?:в\s+)?заявк|хаос\s+обращени|очеред[ьи]|блокнот|кто\s+на\s+когда|учёт\s+заявк|путан\w*\s+в\s+заявк|теря\w*\s+заявк|заявк\w*\s+теря/i.test(
      blob
    );

  const priceTermFaq =
    /(?:одинаков|одни\s+и\s+те\s+же|повторя\w*|типов\w*)\w*.{0,40}(?:вопрос|вопрос\w*).{0,40}(?:стоим|цен|срок)|(?:стоим|цен|срок)\w*.{0,40}(?:одинаков|одни\s+и\s+те\s+же|повторя)|вопрос\w*.{0,24}(?:о\s+)?(?:стоим|цен|срок)|узнать\s+(?:стоим|цен|срок)|про\s+(?:стоим|цен|срок)/i.test(
      blob
    );

  const lostAfterContact =
    /после\s+(?:разговор|звон|переписк|контакт)\w*.{0,48}(?:пропад|не\s+возвращ|не\s+верну)|(?:пропад|не\s+возвращ|не\s+верну)\w*.{0,48}после|уход\w*\s+подумать|ушла\s+подумать|часть.{0,40}не\s+возвращ/i.test(
      blob
    );

  const repeatConsultPain =
    priceTermFaq ||
    lostAfterContact ||
    /консультац|помо\w*\s+с\s+выбор|спрашивают\s+про\s+(?:размер|состав|отличи)|повторя\w*\s+консультац|долго\s+выбира|не\s+возвраща|одинаков\w*\s+вопрос|одни\s+и\s+те\s+же\s+вопрос|времени?\s+уходит\s+на\s+(?:одинаков|вопрос|консультац)|трат\w*\s+время\s+на\s+(?:одинаков|вопрос)/i.test(
      blob
    );

  const catalogBrowseIntent =
    /заранее\s+(?:посмотреть|узнать|понять)\s+(?:товар|цен|стоим|срок|характерист|услов)|сам\w*.{0,24}(?:посмотреть|узнать|понять).{0,40}(?:цен|стоим|срок|товар|характерист|услов)|посмотреть\s+(?:товар|основн\w*\s+цен|цен|стоим|срок)|товар\w*.{0,24}цен\w*.{0,24}характерист|витрин|каталог|характеристик|основные\s+цены\s+и\s+сроки|цены\s+и\s+сроки/i.test(
      blob
    );

  const infoFirst =
    catalogBrowseIntent ||
    /заранее\s+(?:узнать|понять|посмотреть)|до\s+(?:переписк|звон|разговор)|сам\w*.{0,32}(?:посмотреть|узнать|понять).{0,48}(?:цен|стоим|срок|услов)|информац.{0,24}о\s+(?:вас|услуг|ремонт)|с\s+какими\s+классами/i.test(
      blob
    );

  const bookingNextStep =
    /записаться|запис\w*\s+на\s+ремонт|оставить\s+заявк|оформить\s+(?:заявк|заказ|брон)|форм[аыуе]\s+(?:заявк|заказ)|следующ\w*\s+шаг.{0,24}запис|возможн\w*\s+записаться|заявк\w*\s+на\s+ремонт/i.test(
      blob
    );

  const rejectedQueue =
    /нет\s+проблемы\s+с\s+(?:очеред|хаос)|не\s+(?:про\s+)?очеред|у\s+меня\s+нет\s+(?:проблемы\s+с\s+)?(?:очеред|хаос)|главная\s+проблема\s+в\s+другом|это\s+не\s+про\s+(?:очеред|хаос|заявк)/i.test(
      text
    );

  const selfBooking = new RegExp(
    "сам" +
      R +
      ".{0,40}(?:запис|заявк|заказ|выбер|оформи|смотр|посмотр|брон|узна)|выбрать\\s+занятие|записаться|оставить\\s+заявк|оформить\\s+(?:брон|заказ)|форм[аыуе]\\s+(?:заявк|заказ)|витрин" +
      R +
      "|календар\\w*\\s+занятост|заявк\\w*\\s+с\\s+дат",
    "i"
  ).test(blob);

  const toolsManual =
    /таблиц|календар|excel|эксел|вручную|заметк|блокнот|whatsapp|ватсап|telegram|телеграм|телефон|переписк|(?:crm|сервис\s+записи).{0,24}нет|сайт\w*\s+почти\s+нет|сайт\w*\s+нет/i.test(
      blob
    );

  const evidence = {
    explicitProduct: explicitProduct,
    paymentStance: noOnlinePayment || paymentRequired,
    noOnlinePayment: noOnlinePayment,
    paymentRequired: paymentRequired,
    scheduleDynamic: new RegExp(
      "расписан" +
        R +
        ".{0,36}(?:часто|меня)|(?:часто|меня)" +
        R +
        ".{0,36}расписан|часто\\s+меня|меня\\w*.{0,20}часто|кажд" +
        R +
        "\\s+недел|цен\\w*.{0,28}меня|занятость.{0,28}(?:скач|меня)|в\\s+сезон\\w*.{0,28}меня",
      "i"
    ).test(text),
    multiInstructor: /несколько\s+преподавател|много\s+преподавател|несколько\s+мастер|несколько\s+инструктор/i.test(
      text
    ),
    capacityLimited: new RegExp(
      "лимит\\s+мест|ограниченн" + R + ".{0,28}мест|мест" + R + ".{0,20}огранич",
      "i"
    ).test(text),
    reschedule: /перенос/i.test(text),
    selfBooking: selfBooking,
    toolsManual: toolsManual,
    existingModule:
      /модул\w*.{0,24}(?:брон|запис)|готов\w*\s+сервис\s+записи/i.test(blob) &&
      !/(?:нет\s+модул|модул\w*.{0,40}нет|без\s+модул|модул\w*\s+бронир\w*\s+нет)/i.test(blob),
    conditionsStable:
      /в\s+целом.{0,28}стабиль|условия.{0,28}стабиль|стабильн|не\s+часто\s+меня|относительно\s+стабиль|расписан.{0,28}стабиль|одинаков.{0,40}вопрос|вопрос.{0,40}одинаков|поток.{0,24}ровн/i.test(
        text
      ),
    queueChaos: queueChaos && !rejectedQueue,
    rejectedQueue: rejectedQueue,
    repeatConsultPain: repeatConsultPain,
    catalogBrowseIntent: catalogBrowseIntent,
    priceTermFaq: priceTermFaq,
    lostAfterContact: lostAfterContact,
    infoFirst: infoFirst,
    bookingNextStep: bookingNextStep,
    domain: ctx.domain
  };

  evidence.problemShape = resolveProblemShape(evidence, ctx, text);
  return evidence;
}

/**
 * Matched problem shape from USER_FACT + USER_DESIRED_STATE — never from «нет CRM» alone.
 */
export function resolveProblemShape(ev, ctx, text) {
  const t = normalizeSpan(text || "");
  if (ev.scheduleDynamic || ev.multiInstructor || ev.capacityLimited || ev.reschedule) {
    return "schedule_ops";
  }
  if (ev.existingModule) return "reuse_module";
  if (ev.queueChaos) return "queue_chaos";

  const retailLike =
    ctx.domain === "retail" || /магазин|текстил|товар/i.test(t);
  if (retailLike && (ev.repeatConsultPain || ev.catalogBrowseIntent) && !ev.queueChaos) {
    return "retail_catalog";
  }

  // info_first_to_booking: FAQ/price/terms OR lost-after-contact + desire to self-orient + booking/claim.
  if (
    (ev.infoFirst || ev.catalogBrowseIntent || ev.priceTermFaq) &&
    (ev.selfBooking || ev.bookingNextStep) &&
    (ev.repeatConsultPain || ev.priceTermFaq || ev.lostAfterContact || ev.infoFirst)
  ) {
    return "info_first_to_booking";
  }

  if (ctx.domain === "b2b" || ctx.domain === "professional") {
    return "b2b_intake";
  }
  if (ctx.domain === "lodging" && (ev.selfBooking || ev.bookingNextStep)) {
    return "lodging_booking";
  }
  if (ev.explicitProduct || /нужен\s+сайт|хочу\s+сайт|свой\s+сайт/i.test(t)) {
    return "explicit_channel";
  }
  return "unmatched";
}

/**
 * BRIEF_READY = MVB sufficient.
 * SOLUTION_READY = enough evidence to distinguish relevant solution classes
 * (not a single keyword trigger).
 */
export function evaluateSolutionReady(coverage, userTurns) {
  const ev = collectSolutionEvidence(coverage, userTurns);
  const ctx = inferDialogueContext(coverage, userTurns);
  const ops =
    ev.scheduleDynamic || ev.multiInstructor || ev.capacityLimited || ev.reschedule;
  const schedulingDomain =
    ctx.domain === "studio" || ctx.domain === "education" || ctx.domain === "lodging";

  if (ev.problemShape && ev.problemShape !== "unmatched") {
    // Auto-ready shapes grounded in confirmed pain/desired flow.
    // lodging_booking / b2b_intake still use legacy gates below (payment/ops/intake).
    const autoReady =
      ev.problemShape === "info_first_to_booking" ||
      ev.problemShape === "retail_catalog" ||
      ev.problemShape === "reuse_module" ||
      ev.problemShape === "schedule_ops" ||
      ev.problemShape === "queue_chaos" ||
      ev.problemShape === "explicit_channel";
    if (autoReady) {
      return {
        ready: true,
        reason: "problem_shape_" + ev.problemShape,
        evidence: ev,
        question: null
      };
    }
  }

  if (ev.explicitProduct) {
    return { ready: true, reason: "explicit_product", evidence: ev, question: null };
  }
  if (ev.paymentStance && ops) {
    return { ready: true, reason: "evidence_sufficient", evidence: ev, question: null };
  }
  if (ev.paymentStance && ev.existingModule) {
    return { ready: true, reason: "evidence_sufficient", evidence: ev, question: null };
  }
  // Lodging-style: deposit/payment in journey + clear self-serve booking path.
  if (ev.paymentRequired && (ev.selfBooking || ev.existingModule)) {
    return { ready: true, reason: "evidence_sufficient", evidence: ev, question: null };
  }
  // Non-scheduling: payment + tools + (self-serve intent OR stability answer).
  if (
    ev.paymentStance &&
    ev.toolsManual &&
    (ev.selfBooking || ev.conditionsStable) &&
    !schedulingDomain
  ) {
    return { ready: true, reason: "evidence_sufficient", evidence: ev, question: null };
  }
  // Non-scheduling with clear desiredFlow already known: payment + manual tools is enough.
  if (
    !schedulingDomain &&
    ev.paymentStance &&
    ev.toolsManual &&
    coverage &&
    coverage.desiredFlow &&
    coverage.desiredFlow.status === "known"
  ) {
    return { ready: true, reason: "evidence_sufficient", evidence: ev, question: null };
  }
  // Retail / consult-heavy: repeat consultations + browse intent + tools — enough for digital class.
  if (
    !schedulingDomain &&
    ev.repeatConsultPain &&
    (ev.catalogBrowseIntent || ev.infoFirst || ev.paymentStance) &&
    ev.toolsManual
  ) {
    return { ready: true, reason: "evidence_sufficient", evidence: ev, question: null };
  }
  // Scheduling: payment + either ops OR explicit stability, with tools/self path.
  if (
    schedulingDomain &&
    ev.paymentStance &&
    (ops || ev.conditionsStable) &&
    (ev.toolsManual || ev.selfBooking)
  ) {
    return { ready: true, reason: "evidence_sufficient", evidence: ev, question: null };
  }
  // B2B / professional intake: structured pre-qualification already described.
  if (
    (ctx.domain === "b2b" || ctx.domain === "professional") &&
    ev.toolsManual &&
    /вопрос|анкет|квалиф|отбор|посмотр\w*.{0,40}информац|исходн\w*\s+данн|подходит ли|личн\w*\s+разговор|созвон|звонок/i.test(
      combineAllUserText(userTurns)
    )
  ) {
    return { ready: true, reason: "evidence_sufficient", evidence: ev, question: null };
  }

  return {
    ready: false,
    reason: "need_discriminator",
    evidence: ev,
    question: pickSolutionDiscriminatorQuestion(coverage, userTurns, ev)
  };
}

/**
 * Ask a material operational fact — do NOT predeclare solution classes (X vs Y).
 * Choice depends on problem shape / domain, not a fixed payment→schedule ladder.
 */
export function pickSolutionDiscriminatorQuestion(coverage, userTurns, evIn) {
  const ctx = inferDialogueContext(coverage, userTurns);
  const ev = evIn || collectSolutionEvidence(coverage, userTurns);
  const text = combineAllUserText(userTurns);
  const schedulingDomain =
    ctx.domain === "studio" || ctx.domain === "education" || ctx.domain === "lodging";

  let raw = "";
  if (ctx.domain === "b2b" || ctx.domain === "professional") {
    const intakeDescribed =
      /вопрос|анкет|квалиф|отбор|посмотр\w*.{0,24}информац|исходн\w*\s+данн|подходит ли/i.test(
        text
      );
    if (!intakeDescribed) {
      raw = ctx.solutionAsk;
    } else if (!ev.paymentStance) {
      raw =
        "После такого предварительного сбора данных вам обычно нужен ещё личный разговор перед стартом, или иногда можно переходить к сотрудничеству без него?";
    } else if (!ev.conditionsStable) {
      raw = ctx.solutionAsk;
    } else {
      raw = "";
    }
  } else if (schedulingDomain) {
    if (!ev.paymentStance) raw = ctx.solutionAsk;
    else if (!ev.scheduleDynamic && !ev.reschedule && !ev.conditionsStable) {
      if (ctx.domain === "studio" || ctx.domain === "education") {
        raw =
          "Расписание у вас скорее стабильное или часто меняется — и бывает ли перенос занятий?";
      } else {
        raw = "Занятость и цены меняются часто, или в целом всё относительно стабильно?";
      }
    } else if (
      !ev.multiInstructor &&
      !ev.capacityLimited &&
      !ev.conditionsStable &&
      !ev.scheduleDynamic &&
      (ctx.domain === "studio" || ctx.domain === "education")
    ) {
      raw =
        "Запись идёт к одному преподавателю или к нескольким, и бывают ли ограничения по местам на занятии?";
    } else {
      // Enough operational signal — avoid re-asking the same disc stem.
      raw = "";
    }
  } else if (!ev.paymentStance) {
    raw = ctx.solutionAsk;
  } else if (!ev.conditionsStable && !ev.selfBooking && !ev.scheduleDynamic) {
    raw =
      "Насколько часто у вас меняются условия или состав типовых обращений — или в целом всё стабильно?";
  } else {
    raw = "";
  }

  if (!raw) return "";
  return ensureDomainSafeQuestion(groundDiscriminatorWording(raw, userTurns, ctx), ctx);
}

/** BRIEF/dialogue ready but solution class still underdetermined → clarify, never recommend-fail. */
export function needsSolutionDiscriminator(coverage, userTurns) {
  const turns = userTurns || [];
  const dialogue = evaluateDialogueReady(coverage, turns, evaluateBriefReady);
  if (!dialogue.ready) return false;
  const sol = evaluateSolutionReady(dialogue.coverage || coverage, turns);
  if (sol.ready) return false;
  return shouldAskSolutionDiscriminator(coverage, turns, sol);
}

/**
 * True when the latest user turn rejects / corrects a prior Mark recommendation or hypothesis.
 */
export function isUserRecommendationRejection(text) {
  const t = normalizeSpan(text);
  if (!t) return false;
  return (
    /у\s+меня\s+нет\s+проблемы/.test(t) ||
    /главная\s+проблема\s+в\s+другом/.test(t) ||
    /это\s+не\s+(?:так|про\s+меня|мой\s+случай)/.test(t) ||
    /я\s+уже\s+ответил/.test(t) ||
    /вы\s+неверно/.test(t) ||
    /неправильно\s+понял/.test(t) ||
    /нет\s+проблемы\s+с\s+(?:очеред|хаос)/.test(t) ||
    /не\s+про\s+(?:очеред|хаос|заявк)/.test(t)
  );
}

/**
 * Hypotheses Mark must not treat as USER_FACT after explicit rejection.
 * USER_TURN can invalidate MARK_HYPOTHESIS; recommendation must replan.
 */
export function collectInvalidatedHypotheses(userTurns, history) {
  const invalidated = Object.create(null);
  const turns = userTurns || [];
  for (let i = 0; i < turns.length; i += 1) {
    const t = normalizeSpan(turns[i] && turns[i].text);
    if (!t) continue;
    if (
      /нет\s+проблемы\s+с\s+(?:очеред|хаос)|не\s+про\s+(?:очеред|хаос)|у\s+меня\s+нет\s+(?:проблемы\s+с\s+)?(?:очеред|хаос)|главная\s+проблема\s+в\s+другом/.test(
        t
      )
    ) {
      invalidated.queueChaos = true;
      invalidated.intakeQueue = true;
    }
  }
  const hist = Array.isArray(history) ? history : [];
  for (let i = 0; i < hist.length; i += 1) {
    if (!hist[i] || hist[i].role !== "user") continue;
    if (!isUserRecommendationRejection(hist[i].content)) continue;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (!hist[j] || hist[j].role !== "assistant") continue;
      const a = normalizeSpan(hist[j].content);
      if (/хаос\s+заявк|очеред|блокнот|слот/.test(a)) {
        invalidated.queueChaos = true;
        invalidated.intakeQueue = true;
      }
      if (/я\s+бы\s+начал\s+с\s+направления|рекоменд/.test(a)) {
        invalidated.lastRecommendation = String(hist[j].content || "").trim();
      }
      break;
    }
  }
  return invalidated;
}

function recommendationsShareCoreClaim(a, b) {
  const x = normalizeSpan(a);
  const y = normalizeSpan(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const markers = [
    /хаос\s+заявк/,
    /контур\s+при[её]ма\s+заявк/,
    /единый\s+список\s+статусов/,
    /очеред/,
    /вместо\s+блокнота/
  ];
  let shared = 0;
  for (let i = 0; i < markers.length; i += 1) {
    if (markers[i].test(x) && markers[i].test(y)) shared += 1;
  }
  return shared >= 2;
}

/**
 * Prefer operational / atomic tool quotes — never multi-fact opening dumps.
 */
function isMultiFactDumpQuote(quote) {
  const q = String(quote || "").trim();
  if (q.length > 160) return true;
  const topics =
    (/у\s+меня|сервис|магазин|гостев|студи/i.test(q) ? 1 : 0) +
    (/клиент|покупател|гост|ученик/i.test(q) ? 1 : 0) +
    (/вручную|crm|таблиц|календар/i.test(q) ? 1 : 0) +
    (/хочу|заранее|заявк|запис/i.test(q) ? 1 : 0) +
    (/время|вопрос|консультац|пропал/i.test(q) ? 1 : 0);
  return topics >= 3;
}

function isOperationalToolsQuote(quote) {
  const q = normalizeSpan(quote);
  if (!q || isMultiFactDumpQuote(quote)) return false;
  if (hasOperationalToolSignal(q)) return true;
  if (hasBroadToolsAbsence(q) && q.length <= 160) return true;
  if (
    /(?:только\s+)?(?:телефон|переписк)|whatsapp|ватсап|telegram|телеграм/i.test(q) &&
    q.length <= 140
  ) {
    return true;
  }
  return false;
}

function pickOperationalToolsQuote(sources) {
  const list = sources || [];
  let best = "";
  let bestScore = -1;
  for (let i = 0; i < list.length; i += 1) {
    const q = list[i] && list[i].quote ? String(list[i].quote).trim() : "";
    if (!q || !isOperationalToolsQuote(q)) continue;
    let score = 1000 - Math.min(q.length, 400) + i * 20;
    if (hasOperationalToolSignal(normalizeSpan(q))) score += 80;
    if (score > bestScore) {
      bestScore = score;
      best = q;
    }
  }
  return best;
}

function pickAtomicFrictionQuote(sources) {
  const list = sources || [];
  let best = "";
  let bestScore = -1;
  for (let i = 0; i < list.length; i += 1) {
    const q = list[i] && list[i].quote ? String(list[i].quote).trim() : "";
    if (!q || isMultiFactDumpQuote(q)) continue;
    if (!looksLikeFrictionEvidence(q) && !/одинаков|стоим|срок|пропал|консультац|время/i.test(q)) {
      continue;
    }
    const score = 800 - Math.min(q.length, 300) + i * 15;
    if (score > bestScore) {
      bestScore = score;
      best = q;
    }
  }
  if (best) return best;
  // Fallback: shortest non-dump source.
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const q = list[i] && list[i].quote ? String(list[i].quote).trim() : "";
    if (q && !isMultiFactDumpQuote(q) && q.length <= 140) return q;
  }
  return "";
}

function buildReuseNoteFromTools(toolsQuote, text) {
  const q = normalizeSpan(toolsQuote);
  const t = normalizeSpan(text);
  const blob = q + " " + t;
  const onlyChannelsManual =
    /телефон|переписк|whatsapp|ватсап|telegram|телеграм|вручную/i.test(blob) &&
    (/crm\s+нет|нет\s+crm|отдельн\w*\s+crm.{0,40}нет|календар\w*.{0,24}нет|систем\w*\s+заявк\w*.{0,16}нет|почти\s+вс[её]\s+вручную/i.test(
      blob
    ) ||
      !hasOperationalToolSignal(q));
  if (onlyChannelsManual) {
    if (/телефон|переписк|whatsapp|ватсап|telegram|телеграм/i.test(blob)) {
      return "Сохранить привычный способ согласования деталей по телефону или в переписке";
    }
    return "Не усложнять стартовый контур CRM и учётом — сначала снять повторяющиеся вопросы";
  }
  if (toolsQuote && hasOperationalToolSignal(q)) {
    return "Переиспользовать уже названные инструменты: " + clipAckFactSafe(toolsQuote, 90);
  }
  return "Опереться на подтверждённую задачу клиента, не плодить лишние системы сразу";
}

function buildRealProblemFromEvidence(ev, frictionQuote, goalQuote) {
  if (ev.priceTermFaq && ev.lostAfterContact) {
    return "Повторяющиеся вопросы о стоимости и сроках, а часть заинтересованных клиентов пропадает после разговора";
  }
  if (ev.priceTermFaq) {
    return "Много одинаковых вопросов о стоимости и сроках";
  }
  if (ev.lostAfterContact) {
    return "Часть заинтересованных клиентов не возвращается после разговора";
  }
  if (ev.repeatConsultPain && ev.catalogBrowseIntent) {
    return "Повторяющиеся консультации и потерянные после «подумать» покупатели";
  }
  if (frictionQuote && !isMultiFactDumpQuote(frictionQuote)) {
    return clipAckFactSafe(frictionQuote, 110);
  }
  if (goalQuote && !isMultiFactDumpQuote(goalQuote)) {
    return clipAckFactSafe(goalQuote, 110);
  }
  if (ev.repeatConsultPain) {
    return "Повторяющиеся ручные объяснения до заявки или записи";
  }
  return "Нужен понятный цифровой путь от интереса до следующего шага";
}

function unmatchedRecommendationClarify(ctx) {
  const msg =
    "Чтобы предложить точное решение, уточните один момент: что сейчас больнее — заранее объяснить цены и условия, ускорить запись/заявку, или снять повторяющиеся вопросы в переписке?";
  return {
    assistantMessage: msg,
    phase: "clarify",
    done: false,
    recommendationMode: "none",
    nextInformationNeed: { focus: "none", reason: "unmatched_problem_shape" },
    clarifyFallbackMessage: msg,
    lowEngagement: false,
    expertPlan: null,
    replanned: true,
    unmatched: true,
    problemShape: "unmatched"
  };
}

/**
 * Deterministic recommendation from matched problem shape only.
 * No silent DEFAULT boilerplate («Упорядочить запись и заявки…»).
 * Never promotes MARK_HYPOTHESIS to USER_FACT.
 */
export function buildEvidenceBackedRecommendation(coverage, userTurns, history) {
  const ev = collectSolutionEvidence(coverage, userTurns);
  const ctx = inferDialogueContext(coverage, userTurns);
  const text = combineAllUserText(userTurns);
  const invalidated = collectInvalidatedHypotheses(userTurns, history);
  const shape = ev.problemShape || resolveProblemShape(ev, ctx, text);

  const toolsQuote = pickOperationalToolsQuote(
    coverage && coverage.existingTools && coverage.existingTools.sources
      ? coverage.existingTools.sources
      : []
  );
  const goalQuote = firstGroundedQuote(
    coverage && coverage.goal && coverage.goal.sources ? coverage.goal.sources : []
  );
  const frictionQuote = pickAtomicFrictionQuote(
    coverage && coverage.friction && coverage.friction.sources
      ? coverage.friction.sources
      : []
  );

  const channelTelegram = /telegram|телеграм/i.test(text);
  const channelWhatsapp = /whatsapp|ватсап/i.test(text);
  const wantsQueue = Boolean(ev.queueChaos) && !invalidated.queueChaos;

  if (!shape || shape === "unmatched") {
    return unmatchedRecommendationClarify(ctx);
  }

  let primarySolution = "";
  let alternative = "";
  let whyPrimary = "";
  let insight = "";
  let startNow = "";
  let addLater = "none: без дополнительных слоёв, пока нет явного запроса";
  let doNotBuildYet = "Не строить CRM/очередь и сложную платформу без явной потребности";

  if (shape === "schedule_ops") {
    primarySolution = "Готовый сервис онлайн-записи и актуального расписания";
    alternative =
      "Компактная страница-витрина с формой заявки без полноценного booking engine";
    whyPrimary =
      "Нужен self-booking при живом расписании" +
      (ev.multiInstructor ? ", нескольких преподавателях" : "") +
      (ev.capacityLimited ? " и лимите мест" : "") +
      (ev.noOnlinePayment ? "; онлайн-оплата сейчас не обязательна" : "");
    insight = "Ядро решения — запись и расписание, а не «сайт ради сайта»";
    startNow =
      "Подключить сервис записи к текущим таблице/календарю" +
      (ev.noOnlinePayment ? " без обязательной онлайн-оплаты" : "");
  } else if (shape === "reuse_module") {
    primarySolution = "Витрина/страница с подключением уже имеющегося модуля бронирования";
    alternative = "none: отдельный booking engine не нужен — модуль уже есть";
    whyPrimary =
      "У вас уже есть рабочий модуль — его нужно показать и подключить, а не строить заново";
    insight = "REUSE BEFORE BUILD";
    startNow = "Подключить существующий модуль к понятной витрине";
    doNotBuildYet = "Не строить бронирование с нуля";
  } else if (shape === "info_first_to_booking") {
    primarySolution =
      "Страница или мини-сервис с понятной информацией о видах работ, ориентировочной стоимости и сроках + заявка/запись";
    alternative = channelTelegram || channelWhatsapp
      ? "Сценарий типовых ответов о цене и сроках в текущем мессенджере + быстрая заявка"
      : "Короткий прайс/условия и форма заявки без полноценной CRM";
    whyPrimary = ev.lostAfterContact
      ? "Сейчас много одинаковых вопросов о стоимости и сроках, а часть заинтересованных клиентов пропадает после разговора — нужна возможность заранее сориентироваться и сразу перейти к записи/заявке"
      : "Нужно заранее показать цены и сроки, чтобы человек понял, что подходит, и быстрее оставил заявку или записался";
    insight =
      "Ядро — info-first к записи/заявке, а не CRM и не очередь заявок";
    startNow =
      "Собрать понятный блок «услуги / ориентировочные цены и сроки» + кнопку заявки или записи; детали продавец согласует после обращения";
    doNotBuildYet = "Не строить CRM, очередь заявок и онлайн-оплату без явной потребности";
  } else if (shape === "retail_catalog") {
    primarySolution =
      "Каталог/витрина с товарами, ценами и характеристиками + понятный путь к заявке или консультации";
    alternative =
      channelTelegram || channelWhatsapp
        ? "AI-помощник или сценарий ответов в ВКонтакте/Telegram для типовых вопросов о товаре"
        : "Короткая страница подборки + форма заявки без полноценного магазина";
    whyPrimary = ev.repeatConsultPain
      ? "Продавцы тратят время на повторяющиеся консультации, а часть покупателей уходит подумать — нужна возможность заранее разобраться в товаре"
      : "Покупателю важно заранее понять товар и спокойно выбрать, а затем связаться или прийти подготовленным";
    insight =
      "Ядро — снятие повторяющихся консультаций и потерянных «подумать», а не очередь заявок";
    startNow =
      "Собрать витрину ключевых товаров с характеристиками и кнопкой «заявка / написать / прийти»" +
      (ev.noOnlinePayment ? "; онлайн-оплату пока не подключать" : "");
    addLater = "none: AI-помощник по типовым вопросам — только если понадобится позже";
    doNotBuildYet = "Не строить CRM/очередь заявок и полноценный checkout без явной потребности";
  } else if (shape === "explicit_channel") {
    primarySolution = "Компактный сайт или страница под вашу задачу";
    alternative =
      channelTelegram || channelWhatsapp
        ? "Форма или бот в текущем мессенджере — быстрее, если витрина пока вторична"
        : "Короткая страница услуг с заявкой на текущем стеке";
    whyPrimary = "Вы явно обозначили потребность в своём канале/странице";
    insight = "Сайт — гипотеза под задачу, не единственный класс решения";
    startNow = "Собрать компактную страницу под подтверждённую задачу";
  } else if (shape === "queue_chaos" && wantsQueue) {
    primarySolution =
      "Простой контур приёма заявок и очереди (форма/чат → единый список статусов)";
    alternative = "Компактная страница с формой заявки, если нужен отдельный вход с улицы/поиска";
    whyPrimary =
      "Вы описали путаницу или потерю заявок/очереди — сначала упорядочиваем этот контур";
    insight = "Сначала workflow заявки/очереди, сайт — только если нужен отдельный канал";
    startNow =
      "Собрать заявку с описанием задачи и удобным слотом + одну очередь вместо блокнота";
  } else if (shape === "b2b_intake") {
    if (channelTelegram) {
      primarySolution =
        "Структурированный приём обращений в Telegram (бот или стабильная форма вопросов) до личного разговора";
      alternative =
        "Короткая страница услуг/условий с формой — если нужен вход вне мессенджера";
      whyPrimary =
        "Клиенты уже пишут в Telegram: сначала снимаем повторяющиеся объяснения и собираем вводные в текущем канале";
      insight = "Канал клиента material — не начинать с сайта по умолчанию";
      startNow =
        "Короткий сценарий вопросов о задаче клиента в Telegram + понятный блок «что беру / на каких условиях»";
    } else {
      primarySolution =
        "Короткий информационный контур и структурированный приём обращений до личного разговора";
      alternative = channelWhatsapp
        ? "Бот или форма вопросов прямо в WhatsApp — быстрее, если отдельная страница пока не нужна"
        : "Только шаблоны ответов в переписке — быстрее внедрить, но слабее отбор";
      whyPrimary =
        "У вас повторяется однотипное первичное общение — сначала нужно снять объяснение услуг/условий и собрать исходные данные";
      insight = "Для professional/B2B ядро — квалификация обращения, а не «сайт ради сайта»";
      startNow =
        "Стабильный блок с услугами/условиями + короткая форма вопросов о задаче клиента";
    }
    addLater = "none: лёгкий учёт статусов — только если поток вырастет";
  } else if (shape === "lodging_booking") {
    primarySolution = "Онлайн-бронирование с календарём занятости и понятными условиями";
    alternative = "Усилить текущие объявления + шаблоны ответов, если поток пока небольшой";
    whyPrimary = "Гостям нужны свободные даты и бронь без долгой переписки";
    insight = "Ядро — доступность и бронь, не сайт ради сайта";
    startNow = "Подключить календарь занятости и понятный путь к брони";
  } else {
    return unmatchedRecommendationClarify(ctx);
  }

  const realProblem = buildRealProblemFromEvidence(ev, frictionQuote, goalQuote);
  const audienceHypothesis =
    ctx.domain === "studio"
      ? "Клиенты студии, для которых важны удобство записи и понятная информация"
      : ctx.domain === "lodging"
        ? "Гости, которым важно заранее понять условия и доступность"
        : ctx.domain === "retail"
          ? "Покупатели, которым важны качество, цена и возможность спокойно выбрать"
          : ctx.domain === "service"
            ? "Клиенты сервиса, которым важны понятная стоимость, сроки и удобная запись"
            : "Типичные клиенты уже описаны в диалоге";

  const reuseNote = buildReuseNoteFromTools(toolsQuote, text);

  let assistantMessage =
    "По тому, что вы описали, я бы начал с направления: " +
    primarySolution +
    ". " +
    whyPrimary +
    ". Альтернатива — " +
    alternative.replace(/^none:\s*/i, "") +
    ". " +
    reuseNote +
    ". Сейчас: " +
    startNow +
    (addLater.indexOf("none:") === 0
      ? "."
      : ". Позже можно добавить только то, что реально понадобится — " + addLater + ".");

  // Never re-publish a rejected recommendation claim.
  if (
    invalidated.lastRecommendation &&
    recommendationsShareCoreClaim(assistantMessage, invalidated.lastRecommendation)
  ) {
    const priorWasQueue = /хаос\s+заявк|контур\s+при[её]ма\s+заявк|единый\s+список\s+статусов|вместо\s+блокнота/.test(
      normalizeSpan(invalidated.lastRecommendation)
    );
    if ((shape === "retail_catalog" || shape === "info_first_to_booking") && priorWasQueue) {
      assistantMessage =
        shape === "retail_catalog"
          ? "Спасибо, что уточнили. Тогда я бы начал не с очереди заявок, а с каталога/витрины: товары, цены и характеристики + понятный путь к заявке или консультации."
          : "Спасибо, что уточнили. Тогда я бы начал не с очереди заявок, а со страницы с ценами и сроками + заявка/запись, а детали сервис согласует после обращения.";
      insight = "Коррекция пользователя важнее прежней гипотезы";
    } else if (priorWasQueue) {
      return unmatchedRecommendationClarify(ctx);
    }
  }

  // Hard ban: silent old DEFAULT boilerplate must never ship.
  if (
    /упорядочить\s+запись\s+и\s+заявки|минимальный\s+контур\s+заявки\/записи|автоответы\s+и\s+напоминания\s+по\s+мере\s+необходимости/i.test(
      assistantMessage
    )
  ) {
    return unmatchedRecommendationClarify(ctx);
  }

  return {
    assistantMessage: assistantMessage,
    phase: "recommend",
    done: true,
    recommendationMode: "normal",
    nextInformationNeed: { focus: "none", reason: "" },
    clarifyFallbackMessage: "",
    lowEngagement: false,
    problemShape: shape,
    expertPlan: {
      realProblem: realProblem,
      audienceHypothesis: audienceHypothesis,
      primarySolution: primarySolution,
      alternative: alternative,
      whyPrimary: whyPrimary,
      reuseNote: reuseNote,
      startNow: startNow,
      addLater: addLater,
      doNotBuildYet: doNotBuildYet,
      insight: insight
    },
    invalidated: invalidated
  };
}

function clipAckFactSafe(text, maxLen) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const limit = maxLen || 90;
  if (raw.length <= limit) return raw.replace(/[.!?…]+$/g, "");
  const cut = raw.slice(0, limit);
  const sp = cut.lastIndexOf(" ");
  const out = (sp > 40 ? cut.slice(0, sp) : cut).replace(/[.!?…,;:]+$/g, "");
  if (hasDanglingPreposition(out)) return out.replace(/\s+\S+$/, "").trim();
  return out;
}

function promptForFocus(focus, aspect, sources, coverage, userTurns) {
  const ctx = inferDialogueContext(coverage || null, userTurns || []);

  if (focus === "audienceInput" && aspect === "who_or_segment") {
    return ensureDomainSafeQuestion(ctx.whoAsk, ctx);
  }
  if (focus === "audienceInput" && aspect === "what_matters") {
    return ensureDomainSafeQuestion(ctx.mattersAsk, ctx);
  }
  if (focus === "customerJourney" && aspect === "after_source") {
    const hint = journeySourceHint(combineSourceQuotes(sources));
    if (hint) {
      return ensureDomainSafeQuestion(
        "Понял, " + hint + ". " + (ctx.journeyAfterSource || "").replace(/^А\s+/i, "А "),
        ctx
      );
    }
    return ensureDomainSafeQuestion(ctx.journeyAfterSource || FOCUS_PROMPTS.customerJourney_after_source, ctx);
  }
  if (focus === "customerJourney" && aspect === "after_contact") {
    return ensureDomainSafeQuestion(
      ctx.journeyAfterContact || FOCUS_PROMPTS.customerJourney_after_contact,
      ctx
    );
  }
  if (focus === "existingTools" && aspect === "beyond_channels") {
    return ensureDomainSafeQuestion(ctx.toolsAsk, ctx);
  }
  if (focus === "desiredFlow" && aspect === "client_autonomy") {
    return ensureDomainSafeQuestion(ctx.flowAsk, ctx);
  }
  if (focus === "desiredFlow") {
    return ensureDomainSafeQuestion(ctx.flowAsk, ctx);
  }
  if (focus === "goal") {
    return ensureDomainSafeQuestion(ctx.goalAsk, ctx);
  }
  if (focus === "audienceInput") {
    return ensureDomainSafeQuestion(ctx.whoAsk, ctx);
  }
  if (focus === "existingTools") {
    return ensureDomainSafeQuestion(ctx.toolsAsk, ctx);
  }
  if (focus && FOCUS_PROMPTS[focus]) {
    return ensureDomainSafeQuestion(FOCUS_PROMPTS[focus], ctx);
  }
  return null;
}

/**
 * Cross-domain noun leakage: lodging nouns outside lodging, studio nouns outside studio, etc.
 */
export function hasCrossDomainLeakage(text, domain) {
  const t = normalizeSpan(text);
  if (!t) return false;
  const d = domain || "generic";
  if (d !== "lodging") {
    if (/(?:^|[^а-яё])гост(?:ь|я|ю|ем|и|ей|ями)(?:[^а-яё]|$)/.test(" " + t + " ")) return true;
    if (/брон(?:ь|и|ю|ей|ирован)/.test(t) && d !== "studio") return true;
  }
  if (d !== "studio" && d !== "education" && d !== "lodging") {
    if (/брон(?:ь|и|ю|ей|ирован)/.test(t)) return true;
  }
  if (d !== "studio" && d !== "education") {
    if (/заняти|расписан|преподавател/.test(t) && /\?/.test(String(text || ""))) {
      if (d === "b2b" || d === "professional" || d === "retail" || d === "generic") return true;
    }
  }
  return false;
}

export function ensureDomainSafeQuestion(question, ctx) {
  const q = String(question || "").trim();
  if (!q) return ctx && ctx.goalAsk ? ctx.goalAsk : FOCUS_PROMPTS.goal;
  if (hasCrossDomainLeakage(q, ctx && ctx.domain)) {
    if (ctx && (ctx.domain === "b2b" || ctx.domain === "professional")) {
      return ctx.solutionAsk || ctx.flowAsk || FOCUS_PROMPTS.goal;
    }
    if (ctx && ctx.flowAsk) return ctx.flowAsk;
    return FOCUS_PROMPTS.goal;
  }
  if (
    isLeadingDesiredFlowQuestion(q) &&
    ctx &&
    ctx.flowAsk &&
    !isLeadingDesiredFlowQuestion(ctx.flowAsk)
  ) {
    return ctx.flowAsk;
  }
  return q;
}

function isLeadingDesiredFlowQuestion(text) {
  const t = normalizeSpan(text);
  if (!t) return false;
  if (/получить нужную информацию и оставить заявку/.test(t)) return true;
  if (
    /в идеале что (?:заказчик|клиент|гость|ученик|покупатель|человек) мог/.test(t) &&
    /сам/.test(t)
  ) {
    return true;
  }
  if (/что клиент должен иметь возможность сделать сам/.test(t)) return true;
  return false;
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

/**
 * Detect which MVB field a clarify question is asking about.
 * Used for semantic NO-REPEAT after merge/recovery recomputed coverage.
 */
export function inferQuestionTargetField(question) {
  const t = normalizeSpan(question);
  if (!t) return null;
  if (
    /расскажите.{0,48}о\s+вашем\s+бизнесе/.test(t) ||
    /чем\s+именно\s+вы\s+занимаетесь/.test(t) ||
    /что\s+предлагаете\s+клиентам/.test(t) ||
    /какой\s+у\s+вас\s+бизнес/.test(t) ||
    /чем\s+вы\s+занимаетесь/.test(t)
  ) {
    return "business";
  }
  if (/какого\s+результата\s+вы\s+хотите/.test(t)) return "goal";
  if (
    /кто\s+(?:чаще|обычно).{0,40}(?:обращается|приходит|останавливается|покупает|учиться)/.test(t) ||
    /кто\s+ваши\s+основные/.test(t) ||
    /кто\s+обычно\s+принимает\s+решение/.test(t) ||
    /что\s+для\s+(?:этих\s+людей|них|гостей|клиентов|покупателей|учеников).{0,40}важн/.test(t) ||
    /что\s+(?:гостям|клиентам|этим\s+людям).{0,24}важн/.test(t) ||
    /что\s+важно\s+(?:вашим\s+)?(?:гостям|клиентам|ученикам|покупателям)/.test(t) ||
    /важн[а-я]*\s+(?:ли\s+)?(?:вашим\s+)?(?:гостям|клиентам|ученикам)/.test(t) ||
    /на\s+что\s+(?:гости|клиенты|люди|ученики|покупатели).{0,24}обращают/.test(t) ||
    /на\s+что\s+(?:обычно\s+)?(?:обращают\s+внимание\s+)?(?:ваши\s+)?(?:гости|клиенты)/.test(t)
  ) {
    return "audienceInput";
  }
  if (
    /как\s+(?:сейчас\s+)?обычно\s+проходит\s+следующий\s+шаг/.test(t) ||
    /как\s+сейчас\s+обычно\s+проходит\s+путь/.test(t) ||
    /путь\s+клиента\s*:/.test(t) ||
    /что\s+обычно\s+происходит\s+дальше/.test(t)
  ) {
    return "customerJourney";
  }
  if (/где\s+сейчас\s+больше\s+всего\s+теряется/.test(t)) return "friction";
  if (
    /какими\s+инструментами/.test(t) ||
    /помимо\s+(?:переписки|сообщений|объявлений)/.test(t)
  ) {
    return "existingTools";
  }
  if (/как\s+бы\s+вы\s+хотели|в\s+идеале\s+что/.test(t)) return "desiredFlow";
  if (
    /оплат|предоплат|расписан.{0,24}стабиль|условия.{0,24}стабиль|одинаков.{0,24}вопрос|собрать\s+обращение|онлайн-?оплат|занятость.{0,40}стабиль|относительно\s+стабиль|личный\s+разговор\s+перед|менять(?:ся)?\s+часто|цены\s+меня/.test(
      t
    )
  ) {
    return "solution_discriminator";
  }
  return null;
}

/**
 * Aspect within a multi-aspect field (WHO vs what_matters, journey stages, …).
 */
export function inferQuestionTargetAspect(question) {
  const t = normalizeSpan(question);
  if (!t) return null;
  const field = inferQuestionTargetField(question);
  if (field === "audienceInput") {
    if (
      /кто\s+(?:чаще|обычно)|кто\s+ваши\s+основные|кто\s+обычно\s+принимает\s+решение|останавливается\s+у\s+вас/.test(
        t
      )
    ) {
      return "who_or_segment";
    }
    if (
      /важн|при\s+выборе|обращают\s+внимание|что\s+для\s+(?:этих|них|гостей|клиентов)|что\s+важно\s+вашим/.test(
        t
      )
    ) {
      return "what_matters";
    }
    return "who_or_segment";
  }
  if (field === "customerJourney") {
    if (/после\s+первого\s+контакт|следующий\s+шаг\s+после/.test(t)) return "after_contact";
    if (/что\s+обычно\s+происходит\s+дальше|как\s+доходит/.test(t)) return "after_source";
    return "path";
  }
  if (field === "existingTools") {
    if (/помимо/.test(t)) return "beyond_channels";
    return "tools";
  }
  if (field === "desiredFlow") {
    if (/идеале|как\s+бы\s+вы\s+хотели/.test(t)) return "client_autonomy";
    return "ideal_flow";
  }
  if (field === "business") return "what_business";
  if (field === "goal") return "desired_outcome";
  if (field === "friction") return "pain";
  if (field === "solution_discriminator") return "discriminator";
  return null;
}

/** Coverage fingerprint for no-progress detection (statuses + aspect presence). */
export function coverageProgressFingerprint(coverage, userTurns) {
  const turnsById = turnMap(userTurns || []);
  const parts = [];
  for (let i = 0; i < CRITICAL_COVERAGE_KEYS.length; i += 1) {
    const key = CRITICAL_COVERAGE_KEYS[i];
    const item = coverage && coverage[key] ? coverage[key] : null;
    const status = item && item.status ? item.status : "unknown";
    const src = item && Array.isArray(item.sources) ? item.sources : [];
    let aspects = "";
    if (key === "audienceInput") {
      aspects = audienceMissingAspects(src, turnsById).join(",") || "ok";
    } else {
      aspects = String(src.length);
    }
    parts.push(key + ":" + status + ":" + aspects);
  }
  const sol = evaluateSolutionReady(coverage, userTurns || []);
  parts.push("sol:" + (sol.ready ? "1" : "0"));
  return parts.join("|");
}

/**
 * Prior MARK clarify questions from chat history (assistant role).
 */
export function extractMarkQuestionsFromHistory(history) {
  const out = [];
  const items = Array.isArray(history) ? history : [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || item.role !== "assistant") continue;
    const text = String(item.content || "").trim();
    if (!text) continue;
    // Skip recommend dumps (long, no "?"-only clarify).
    if (text.length > 420 && !/\?/.test(text.slice(-80))) continue;
    out.push(text);
  }
  return out;
}

/**
 * True when coverage already answers this field/aspect (authoritative state).
 */
export function isTargetAlreadyKnown(coverage, userTurns, field, aspect) {
  if (!field || field === "solution_discriminator") return false;
  const turnsById = turnMap(userTurns || []);
  const item = coverage && coverage[field] ? coverage[field] : null;
  const status = item && item.status ? item.status : "unknown";
  const sources = item && Array.isArray(item.sources) ? item.sources : [];

  if (field === "audienceInput") {
    const missing = audienceMissingAspects(sources, turnsById);
    if (!aspect) return missing.length === 0 || status === "known";
    return missing.indexOf(aspect) === -1;
  }
  if (status === "known") return true;
  if (field === "customerJourney" && aspect) {
    const stages = detectJourneyStages(combineSourceQuotes(sources));
    if (aspect === "after_contact" && stages.indexOf("contact") !== -1 && stages.length >= 2) {
      return true;
    }
  }
  if (field === "existingTools" && aspect === "beyond_channels") {
    return toolsClarifyAspect(sources) == null && status !== "unknown";
  }
  if (field === "desiredFlow" && aspect) {
    return flowClarifyAspect(sources) == null && (status === "known" || status === "partial");
  }
  // Volunteered BUSINESS/GOAL even if status lagging: scan USER_TURNS.
  if (field === "business") {
    for (let i = 0; i < (userTurns || []).length; i += 1) {
      if (looksLikeBusinessEvidence((userTurns[i] && userTurns[i].text) || "")) return true;
    }
  }
  if (field === "goal") {
    for (let i = 0; i < (userTurns || []).length; i += 1) {
      if (looksLikeGoalEvidence((userTurns[i] && userTurns[i].text) || "")) return true;
    }
  }
  return false;
}

/**
 * History-aware: MARK already asked this aspect and USER gave evidence for it.
 * For multi-aspect fields, a long but off-aspect reply does NOT count.
 */
export function wasAspectAskedAndAnswered(history, field, aspect) {
  if (!field || !aspect) return false;
  const items = Array.isArray(history) ? history : [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || item.role !== "assistant") continue;
    const qField = inferQuestionTargetField(item.content);
    const qAspect = inferQuestionTargetAspect(item.content);
    if (qField !== field && !(field === "audienceInput" && isAudienceWhoQuestion(item.content))) continue;
    if (aspect && qAspect && qAspect !== aspect) continue;
    for (let j = i + 1; j < items.length; j += 1) {
      if (items[j] && items[j].role === "user" && isNonEmptyString(items[j].content)) {
        const reply = String(items[j].content).trim();
        if (field === "audienceInput") {
          if (aspect === "who_or_segment") {
            return isAudienceWhoEvidence(reply) || isAudienceWhoEvidenceAfterQuestion(reply, item.content);
          }
          if (aspect === "what_matters") return isAudienceWhatMattersEvidence(reply);
        }
        if (reply.length < GATE_POLICY.minQuoteChars) break;
        if (field === "business") return looksLikeBusinessEvidence(reply);
        if (field === "goal") return looksLikeGoalEvidence(reply);
        if (field === "friction") return looksLikeFrictionEvidence(reply);
        return true;
      }
    }
  }
  return false;
}

function questionsShareSemanticTarget(a, b) {
  const fa = inferQuestionTargetField(a);
  const fb = inferQuestionTargetField(b);
  if (fa && fb && fa === fb) {
    const aa = inferQuestionTargetAspect(a);
    const ab = inferQuestionTargetAspect(b);
    if (aa && ab) return aa === ab;
    return true;
  }
  // Fallback: both look like the same audience aspect even if one phrasing is novel.
  const na = normalizeSpan(a);
  const nb = normalizeSpan(b);
  if (normalizeSpan(a) === normalizeSpan(b)) return true;
  const mattersA = /важн|при\s+выборе|обращают\s+внимание/.test(na);
  const mattersB = /важн|при\s+выборе|обращают\s+внимание/.test(nb);
  const whoA = /кто\s+(?:чаще|обычно)|основные\s+(?:клиент|гост|ученик)/.test(na);
  const whoB = /кто\s+(?:чаще|обычно)|основные\s+(?:клиент|гост|ученик)/.test(nb);
  if (mattersA && mattersB && !whoA && !whoB) return true;
  if (whoA && whoB && !mattersA && !mattersB) return true;
  return false;
}

/**
 * Strip ungrounded legal/B2B process nouns from discriminator examples.
 */
export function groundDiscriminatorWording(question, userTurns, ctx) {
  let q = String(question || "").trim();
  if (!q) return q;
  const blob = combineAllUserText(userTurns || []);
  const domain = ctx && ctx.domain ? ctx.domain : "generic";
  const allowLegal =
    domain === "b2b" ||
    domain === "professional" ||
    /договор|контракт|сч[её]т|юрид/.test(blob);
  if (!allowLegal) {
    q = q
      .replace(/\s*—\s*например\s+уточнение\s+условий\s+или\s+договор\??/gi, "")
      .replace(/\s+или\s+договор\??/gi, "")
      .replace(/договор/gi, "следующий шаг");
    if (/уточнение\s+условий\s+или\s+следующий\s+шаг/i.test(q)) {
      q = q.replace(
        /например\s+уточнение\s+условий\s+или\s+следующий\s+шаг/gi,
        "например уточнение деталей или запись"
      );
    }
  }
  return q.replace(/\s{2,}/g, " ").trim();
}

/**
 * True when MARK already asked this exact/near-exact question and USER replied.
 * Same string is never re-published after ≥1 material reply (stops exact loops).
 * Semantic-only match still requires aspect evidence when detectable.
 */
export function wasExactQuestionAskedAndAnswered(history, question) {
  const qn = normalizeSpan(question);
  if (!qn) return false;
  const field = inferQuestionTargetField(question);
  const aspect = inferQuestionTargetAspect(question);
  const exactAnswered = countExactQuestionAnswered(history, qn);
  // Any material reply to this exact wording blocks re-publish.
  if (exactAnswered >= 1) return true;

  const items = Array.isArray(history) ? history : [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || item.role !== "assistant") continue;
    const qText = assistantQuestionText(item.content);
    if (!qText) continue;
    const prior = normalizeSpan(qText);
    if (!prior || isNearExactQuestionText(prior, qn)) continue;
    const semantic = questionsShareSemanticTarget(qText, question);
    if (!semantic) continue;
    for (let j = i + 1; j < items.length; j += 1) {
      if (items[j] && items[j].role === "user" && isNonEmptyString(items[j].content)) {
        const reply = String(items[j].content).trim();
        if (reply.length < GATE_POLICY.minQuoteChars) break;
        if (field && aspect) return wasAspectAskedAndAnswered(history, field, aspect);
        return true;
      }
    }
  }
  return false;
}

/** Prefer the trailing question from welcome; otherwise the full assistant text. */
function assistantQuestionText(content) {
  const raw = String(content || "").trim();
  if (!raw) return "";
  if (/я\s+марк/i.test(raw) && /оксан/i.test(raw)) {
    const parts = raw.split("?");
    if (parts.length >= 2) {
      const last = String(parts[parts.length - 2] || "").trim();
      // Take from last sentence start.
      const sentences = last.split(/(?<=[.!])\s+/);
      const tail = sentences.length ? sentences[sentences.length - 1] : last;
      const q = (tail || last).trim();
      return q ? q + "?" : "";
    }
    return "";
  }
  return raw;
}

/** How many times this near-exact question was asked and then received a user reply. */
function countExactQuestionAnswered(history, qn) {
  let n = 0;
  const items = Array.isArray(history) ? history : [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || item.role !== "assistant") continue;
    const qText = assistantQuestionText(item.content);
    if (!qText) continue;
    if (!isNearExactQuestionText(normalizeSpan(qText), qn)) continue;
    for (let j = i + 1; j < items.length; j += 1) {
      if (
        items[j] &&
        items[j].role === "user" &&
        isNonEmptyString(items[j].content) &&
        String(items[j].content).trim().length >= GATE_POLICY.minQuoteChars
      ) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

/** Equality / filler-prefix / goal-stem match — never substring-into-long-utterance. */
function isNearExactQuestionText(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const strip = function (s) {
    return String(s || "")
      .replace(/^(а|и|ну|хорошо|понял[ао]?|понятно|ясно|ок)[,.\s!—–-]+/i, "")
      .trim();
  };
  const stem = function (s) {
    return strip(s)
      .replace(/\s+для\s+[^?]+/g, "")
      .replace(/[?!.]+$/g, "")
      .trim();
  };
  const sa = strip(a);
  const sb = strip(b);
  if (sa && sb && sa === sb) return true;
  const sta = stem(a);
  const stb = stem(b);
  if (sta && stb && sta === stb) return true;
  if (sta && stb && sta.length >= 36 && stb.length >= 36) {
    if (sta.indexOf(stb) === 0 || stb.indexOf(sta) === 0) return true;
  }
  return false;
}

/**
 * Different wording for the same open aspect after an exact wording was blocked.
 * Returns candidates in preference order (caller filters by history).
 */
function alternateClarifyPrompts(field, aspect, blockedQuestion, coverage, userTurns) {
  const ctx = inferDialogueContext(coverage || null, userTurns || []);
  const blocked = normalizeSpan(blockedQuestion);
  const raw = [];
  if (field === "audienceInput" && (aspect === "who_or_segment" || !aspect)) {
    raw.push(FOCUS_PROMPTS.audienceInput_who_or_segment);
    if (ctx.whoAsk) raw.push(ctx.whoAsk);
    raw.push("Кто ваши основные клиенты — какой это тип людей?");
    raw.push("Кто чаще всего к вам обращается?");
  } else if (field === "audienceInput" && aspect === "what_matters") {
    raw.push(FOCUS_PROMPTS.audienceInput_what_matters);
    if (ctx.mattersAsk) raw.push(ctx.mattersAsk);
  } else if (field === "goal") {
    raw.push(FOCUS_PROMPTS.goal);
    if (ctx.goalAsk) raw.push(ctx.goalAsk);
  } else if (field === "friction") {
    raw.push("Что сейчас отнимает больше всего времени в работе с обращениями?");
    raw.push(FOCUS_PROMPTS.friction);
  } else if (field === "desiredFlow") {
    raw.push(FOCUS_PROMPTS.desiredFlow);
    if (ctx.flowAsk) raw.push(ctx.flowAsk);
  } else if (field === "existingTools") {
    raw.push(FOCUS_PROMPTS.existingTools);
    if (ctx.toolsAsk) raw.push(ctx.toolsAsk);
  }
  const out = [];
  const seen = Object.create(null);
  for (let i = 0; i < raw.length; i += 1) {
    const c = String(raw[i] || "").trim();
    if (!c) continue;
    const cn = normalizeSpan(c);
    if (!cn || isNearExactQuestionText(cn, blocked) || seen[cn]) continue;
    seen[cn] = true;
    out.push(c);
  }
  return out;
}

/**
 * Count ask+reply cycles for a field/aspect (answer quality ignored).
 * Welcome/identity turns do not consume the budget — only real clarify asks.
 */
export function countAspectAsks(history, field, aspect) {
  let n = 0;
  const items = Array.isArray(history) ? history : [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || item.role !== "assistant") continue;
    const raw = String(item.content || "").trim();
    if (!raw) continue;
    // Welcome embeds a first gap ask — do not burn aspect budget on it.
    if (/я\s+марк/i.test(raw) && /оксан/i.test(raw)) continue;
    if (inferQuestionTargetField(raw) !== field) continue;
    const a = inferQuestionTargetAspect(raw);
    if (aspect && a && a !== aspect) continue;
    let replied = false;
    for (let j = i + 1; j < items.length; j += 1) {
      if (
        items[j] &&
        items[j].role === "user" &&
        isNonEmptyString(items[j].content) &&
        String(items[j].content).trim().length >= GATE_POLICY.minQuoteChars
      ) {
        replied = true;
        break;
      }
    }
    if (!replied) continue;
    n += 1;
  }
  return n;
}

/**
 * Final publish gate before any clarify text reaches the user.
 * STATE/GATE is authoritative; provider wording cannot reopen known aspects.
 */
export function publishClarifyQuestion(question, coverage, userTurns, missing, history, depth) {
  const q0 = String(question || "").trim();
  if (!q0) return q0;
  const guard = typeof depth === "number" ? depth : 0;
  if (guard > 8) {
    const ctx = inferDialogueContext(coverage, userTurns || []);
    return ensureDomainSafeQuestion(ctx.goalAsk || FOCUS_PROMPTS.goal, ctx);
  }

  const ctx = inferDialogueContext(coverage, userTurns || []);
  let q = groundDiscriminatorWording(q0, userTurns, ctx);
  // Domain-safe rewrite only when domain is known. Generic/unknown must not
  // strip legitimate «бронирование/календарь» from matched tools fallbacks.
  if (ctx.domain && ctx.domain !== "generic") {
    q = ensureDomainSafeQuestion(q, ctx);
  } else if (!q) {
    q = q0;
  }

  if (isCompoundDiscoveryQuestion(q) || hasInternalSystemWording(q)) {
    return publishClarifyQuestion(
      promptForMissingTarget(missing, coverage, userTurns),
      coverage,
      userTurns,
      missing,
      history,
      guard + 1
    );
  }

  // Purchase occasion/scenario must never publish as a WHO question
  // («для себя / в подарок / для семьи/дома»).
  if (looksLikePurchaseOccasionWhoQuestion(q)) {
    const turnsById = turnMap(userTurns || []);
    const audSources =
      coverage && coverage.audienceInput && Array.isArray(coverage.audienceInput.sources)
        ? coverage.audienceInput.sources
        : [];
    const audMissing = audienceMissingAspects(audSources, turnsById);
    let replacement = "";
    if (audMissing.indexOf("who_or_segment") === -1 && audMissing.indexOf("what_matters") !== -1) {
      replacement = FOCUS_PROMPTS.audienceInput_what_matters;
    } else if (audMissing.indexOf("who_or_segment") !== -1) {
      replacement = FOCUS_PROMPTS.audienceInput_who_or_segment;
    } else {
      replacement = promptForMissingTarget(missing, coverage, userTurns);
    }
    if (
      replacement &&
      normalizeSpan(replacement) !== normalizeSpan(q) &&
      !looksLikePurchaseOccasionWhoQuestion(replacement)
    ) {
      return publishClarifyQuestion(replacement, coverage, userTurns, missing, history, guard + 1);
    }
    // Hard fallback: never emit occasion-WHO wording.
    replacement = FOCUS_PROMPTS.audienceInput_what_matters;
    if (normalizeSpan(replacement) !== normalizeSpan(q)) {
      return publishClarifyQuestion(replacement, coverage, userTurns, missing, history, guard + 1);
    }
    return "";
  }

  // Exact/near-exact history loop — never re-publish the same wording after a reply.
  if (wasExactQuestionAskedAndAnswered(history, q)) {
    const field0 = inferQuestionTargetField(q);
    const aspect0 = inferQuestionTargetAspect(q);
    if (field0 === "solution_discriminator") {
      const sol = evaluateSolutionReady(coverage, userTurns || []);
      if (sol.ready) return "";
      const alt = pickSolutionDiscriminatorQuestion(coverage, userTurns || []);
      if (alt && !questionsShareSemanticTarget(alt, q) && !wasExactQuestionAskedAndAnswered(history, alt)) {
        return publishClarifyQuestion(alt, coverage, userTurns, missing, history, guard + 1);
      }
      return "";
    }
    // Aspect still open → try different wording before leaving the gap.
    const aspectOpen =
      Boolean(field0) &&
      !isTargetAlreadyKnown(coverage, userTurns, field0, aspect0) &&
      !wasAspectAskedAndAnswered(history, field0, aspect0 || null);
    if (aspectOpen) {
      const alts = alternateClarifyPrompts(field0, aspect0, q, coverage, userTurns);
      for (let ai = 0; ai < alts.length; ai += 1) {
        if (wasExactQuestionAskedAndAnswered(history, alts[ai])) continue;
        return publishClarifyQuestion(alts[ai], coverage, userTurns, missing, history, guard + 1);
      }
    }
    // Single-aspect fields: leave the whole field after exact answer.
    // Multi-aspect audience/journey/tools: only skip the answered aspect.
    const skipWholeField =
      field0 === "desiredFlow" ||
      field0 === "friction" ||
      field0 === "goal" ||
      field0 === "business" ||
      !aspect0;
    const nextQ = promptForMissingTarget(
      missing,
      coverage,
      userTurns,
      field0,
      skipWholeField ? null : aspect0
    );
    if (
      !nextQ ||
      normalizeSpan(nextQ) === normalizeSpan(q) ||
      questionsShareSemanticTarget(nextQ, q) ||
      wasExactQuestionAskedAndAnswered(history, nextQ)
    ) {
      return "";
    }
    return publishClarifyQuestion(nextQ, coverage, userTurns, missing, history, guard + 1);
  }

  const field = inferQuestionTargetField(q);
  const aspect = inferQuestionTargetAspect(q);

  // Same aspect asked too many times without semantic progress → force next focus.
  if (field && field !== "solution_discriminator" && countAspectAsks(history, field, aspect || null) >= 2) {
    const nextQ = promptForMissingTarget(missing, coverage, userTurns, field, null);
    if (!nextQ || questionsShareSemanticTarget(nextQ, q) || wasExactQuestionAskedAndAnswered(history, nextQ)) {
      return "";
    }
    return publishClarifyQuestion(nextQ, coverage, userTurns, missing, history, guard + 1);
  }

  if (field && field !== "solution_discriminator") {
    const knownByState = isTargetAlreadyKnown(coverage, userTurns, field, aspect);
    const knownByHistory = wasAspectAskedAndAnswered(history, field, aspect || null);
    if (knownByState || knownByHistory) {
      const nextQ = promptForMissingTarget(missing, coverage, userTurns, field, null);
      if (!nextQ || questionsShareSemanticTarget(nextQ, q) || wasExactQuestionAskedAndAnswered(history, nextQ)) {
        return "";
      }
      return publishClarifyQuestion(nextQ, coverage, userTurns, missing, history, guard + 1);
    }
  } else if (field === "solution_discriminator") {
    if (wasAspectAskedAndAnswered(history, field, aspect || "discriminator")) {
      const sol = evaluateSolutionReady(coverage, userTurns || []);
      if (sol.ready) return "";
      const alt = pickSolutionDiscriminatorQuestion(coverage, userTurns || []);
      if (alt && !questionsShareSemanticTarget(alt, q) && !wasExactQuestionAskedAndAnswered(history, alt)) {
        return publishClarifyQuestion(alt, coverage, userTurns, missing, history, guard + 1);
      }
      return "";
    }
  } else if (!field) {
    const priorLoose = extractMarkQuestionsFromHistory(history);
    for (let i = 0; i < priorLoose.length; i += 1) {
      if (!questionsShareSemanticTarget(priorLoose[i], q) && normalizeSpan(priorLoose[i]) !== normalizeSpan(q)) {
        continue;
      }
      const pf = inferQuestionTargetField(priorLoose[i]);
      const pa = inferQuestionTargetAspect(priorLoose[i]);
      if (
        wasExactQuestionAskedAndAnswered(history, q) ||
        (pf && isTargetAlreadyKnown(coverage, userTurns, pf, pa)) ||
        (pf && wasAspectAskedAndAnswered(history, pf, pa))
      ) {
        const nextQ = promptForMissingTarget(missing, coverage, userTurns, pf, pa);
        if (!nextQ || questionsShareSemanticTarget(nextQ, q)) return "";
        return publishClarifyQuestion(nextQ, coverage, userTurns, missing, history, guard + 1);
      }
    }
  }

  // History semantic dedup: equivalent MARK question already asked + answered.
  const prior = extractMarkQuestionsFromHistory(history);
  for (let i = 0; i < prior.length; i += 1) {
    if (!questionsShareSemanticTarget(prior[i], q)) continue;
    const pf = field || inferQuestionTargetField(prior[i]);
    const pa = aspect || inferQuestionTargetAspect(prior[i]);
    if (
      wasExactQuestionAskedAndAnswered(history, q) ||
      (pf && isTargetAlreadyKnown(coverage, userTurns, pf, pa)) ||
      wasAspectAskedAndAnswered(history, pf, pa)
    ) {
      const nextQ = promptForMissingTarget(missing, coverage, userTurns, pf, pa);
      if (!nextQ || questionsShareSemanticTarget(nextQ, q)) return "";
      return publishClarifyQuestion(nextQ, coverage, userTurns, missing, history, guard + 1);
    }
  }

  return q;
}

function promptForMissingTarget(missing, coverage, userTurns, skipField, skipAspect) {
  const briefMissing =
    missing && missing.length
      ? missing
      : evaluateBriefReady(coverage, userTurns || []).missing;
  const filtered = (briefMissing || []).filter(function (m) {
    if (!m || !m.key) return false;
    if (skipField && m.key === skipField && skipAspect) {
      // Keep field if other aspects may remain — resolveClarifyTarget handles aspects.
      return true;
    }
    if (skipField && m.key === skipField && !skipAspect) return false;
    return true;
  });
  // Prefer next target whose aspect is still missing.
  const turnsById = turnMap(userTurns || []);
  for (let i = 0; i < filtered.length; i += 1) {
    const key = filtered[i].key;
    if (key === "solution_discriminator") continue;
    const sources =
      coverage && coverage[key] && Array.isArray(coverage[key].sources)
        ? coverage[key].sources
        : [];
    if (key === "audienceInput") {
      const aspects = audienceMissingAspects(sources, turnsById).filter(function (a) {
        return !(skipField === "audienceInput" && skipAspect === a);
      });
      if (!aspects.length) continue;
      return promptForFocus(key, aspects[0], sources, coverage, userTurns);
    }
    if (isTargetAlreadyKnown(coverage, userTurns, key, null)) continue;
    if (skipField === key && !skipAspect) continue;
    const target = resolveClarifyTarget([filtered[i]], coverage, userTurns);
    if (!target.focus) continue;
    if (skipField === target.focus && skipAspect && target.aspect === skipAspect) continue;
    return promptForFocus(target.focus, target.aspect, sources, coverage, userTurns);
  }
  const sol = evaluateSolutionReady(coverage, userTurns || []);
  if (!sol.ready && sol.question) {
    return groundDiscriminatorWording(sol.question, userTurns, inferDialogueContext(coverage, userTurns));
  }
  return "";
}

/**
 * If a candidate question asks about an already-known field/aspect, replace with the
 * next real missing focus (recomputed after the latest USER turn merge).
 * @deprecated prefer publishClarifyQuestion — kept as thin wrapper for callers/tests.
 */
export function enforceSemanticNoRepeatQuestion(question, coverage, userTurns, missing, depth) {
  return publishClarifyQuestion(question, coverage, userTurns, missing, [], depth);
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
    /(?:цен[а-я]*|стоимост[а-я]*|смет[а-я]*|качеств[а-я]*|аккуратн[а-я]*|ассортимент[а-я]*|выбор[а-я]*|материал[а-я]*|размер[а-я]*|доставк[а-я]*|ткан[а-я]*|срок[а-я]*|чисот[а-я]*|фото|свободн[а-я]*\s+дат|расстоян[а-я]*|до\s+моря|удобн[а-я]*\s+врем|абонемент[а-я]*|готовност[а-я]*|очеред[а-я]*|темп|атмосфер[а-я]*|парковк[а-я]*)/g;
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

  // «Клиенты чаще приходят из соцсетей» = source/channel, not audience segment.
  const channelOnlyWho =
    /(?:клиенты|гости|покупатели|люди).{0,32}(?:чаще|обычно|в основном).{0,48}(?:приход|наход|приходят|узнают)/.test(
      q
    ) &&
    /(?:из|через)\s+(?:соц|социальн|авито|инстаграм|реклам|whatsapp|ватсап|телеграм)/.test(q) &&
    !/(?:пар[ыа]|семь|женщин|мужчин|взросл|ученик|\d{1,2}\s*[–\-—]\s*\d{1,2})/.test(q);
  if (channelOnlyWho) return false;

  const frequency = /(?:чаще(?:\s+всего)?|в основном|обычно|типичн)/.test(q);
  // Bare «люди/человек» alone is NOT a meaningful segment.
  const segmentCore =
    /(?:отдых|приезж|останавл|бронир|клиент|гост|пар|семь|женщин|мужчин|покупател|взросл|ученик|владельц|магазин|частник|бренд|закупщик|собственник|предпринимател|управляющ|таксист|офис|hr\b|эйчар|школьник|родител|частник)/.test(
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
  // Demographic + age band: «чаще женщины 30–60 лет» / «взрослые 25–45 лет» / «Женщины 20–40»
  const demoWithAge =
    /(?:женщин|мужчин|сем[ьия]|пар[ыа]|покупател|клиент|гост|взросл|ученик|девушк|родител)/.test(q) &&
    /(?:\d{1,2}\s*[–\-—]\s*\d{1,2}|\d{1,2}\s*(?:лет|года))/.test(q);
  // Service-for-segment: «консультации предпринимателям», «для взрослых»
  const serviceForSegment =
    /(?:для|с)\s+(?:предпринимател|компани|взросл|дет|школьник|ип|ооо|бизнес)/.test(q) ||
    /предпринимател(?:ям|ей|и)/.test(q);
  // «Клиенты — …» / «Покупатели — …» as explicit segment lead
  const labeledSegment =
    /(?:клиенты|покупатели|гости|ученики)\s*[—\-–:]/.test(q) && segmentCore;
  // «ко мне/к нам обращаются …» with a non-generic segment
  const approachSegment =
    /(?:ко\s+мне|к\s+нам)\s+обраща|обраща(?:ются|ется)/.test(q) &&
    (segmentCore || /(?:взросл|владельц|компани|бренд)/.test(q));
  const decisionMakers =
    (/решение\s+принимают|принимают\s+решение|принимает\s+решение/.test(q) &&
      /(?:владел|закупщик|директор|менеджер|лпр|\d{1,2}\s*[–\-—]\s*\d{1,2})/.test(q)) ||
    /(?:собственник|закупщик|владельц).{0,24}(?:и\s+)?(?:hr|эйчар|закупщик|владельц)/.test(q) ||
    /(?:собственник|владельц|закупщик).{0,24}(?:ооо|ип|компани)/.test(q) ||
    /(?:частник|таксист|офис)(?:ы|ов|ам|ами)?(?:\s+и\s+(?:частник|таксист|офис))?/.test(q) ||
    /(?:директор|собственник|главбух|бухгалтер|велосипедист|райдер|родител|мам\w*|пар\w*\s+к\s+годовщин)/.test(
      q
    );

  return (
    describesSegment ||
    verbThenSegment ||
    namedClients ||
    pairsFamilies ||
    demoWithAge ||
    serviceForSegment ||
    labeledSegment ||
    approachSegment ||
    decisionMakers
  );
}

function isAudienceWhoQuestion(question) {
  const q = normalizeSpan(question);
  if (!q || q.indexOf("кто") === -1 || /(?:важн|при\s+выборе|обращают\s+внимание)/.test(q)) {
    return false;
  }
  const audienceNoun = /(?:покупател|клиент|гост|посетител|аудитор|целев)/.test(q);
  const buyingBehavior =
    /(?:чаще|обычно|в\s+основном|типичн)/.test(q) &&
    /(?:покупа|обраща|приход|останавлива|заказыва|выбира)/.test(q);
  return audienceNoun || buyingBehavior;
}

function isConciseAudienceSegment(quote) {
  const q = normalizeSpan(quote).replace(/^(?:я\s+же\s+сказал[ао]?|я\s+говорил[ао]?|именно|это)\s*[:,—-]?\s*/i, "").trim();
  if (!q || q.length > 48) return false;
  if (/^(?:люди|человек|клиенты|покупатели|народ)$/i.test(q)) return false;
  return /^(?:мужчин[а-яё]*|женщин[а-яё]*|семь[а-яё]*|молод[её]ж[а-яё]*|пенсионер[а-яё]*|пары|семей\s+с\s+детьми|родител[а-яё]*|подростк[а-яё]*|студент[а-яё]*)$/i.test(q);
}

function isAudienceWhoEvidenceAfterQuestion(quote, question) {
  return isAudienceWhoQuestion(question) && isConciseAudienceSegment(quote);
}

function isAudienceWhoEvidenceInHistory(quote, history) {
  const items = Array.isArray(history) ? history : [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i] && items[i].role === "assistant") return isAudienceWhoEvidenceAfterQuestion(quote, items[i].content);
  }
  return false;
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
  // Framing stem: важно/важны/важнее/важна/важное — not only «важно».
  const importanceFraming = /важн[а-я]*|главн[а-я]*|при\s+выборе|сомнева|критер/.test(q);

  // Bare property facts without choice framing and without multi-criteria list.
  if (
    (/до моря/.test(q) || /бассейн/.test(q) || /лазаревск/.test(q) || /гостевой дом/.test(q)) &&
    !importanceFraming &&
    criteriaN < 2
  ) {
    if (!/при выборе/.test(q)) {
      if (/спрашивают/.test(q) && criteriaN < 2) return false;
      if (!/спрашивают|важн|при выборе/.test(q)) return false;
    }
  }

  // Unframed FAQ recount without a criteria list — not WHAT_MATTERS.
  if (
    /спрашивают/.test(q) &&
    !importanceFraming &&
    criteriaN < 2
  ) {
    return false;
  }

  if (/при выборе/.test(q)) return true;
  if (/(?:им|для них|гостям|клиентам|покупателям|ученикам)\s+важн[а-я]*/.test(q)) return true;
  if (/важн[а-я]*\s+при\s+(?:выборе|покупке|бронировании)/.test(q)) return true;
  if (/(?:они|гости|клиенты).{0,48}(?:смотрят на|выбирают|обращают внимание|интересует)/.test(q)) {
    return true;
  }
  if (/в первую очередь/.test(q) && /спрашивают|важно|смотр/.test(q)) return true;

  // Importance framing at sentence start: «Важны срок…», «Важно удобный заезд…»
  if (/^важн[а-я]*/.test(q) && criteriaN >= 1) return true;
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
    new RegExp(
      "наход|приход|авито|объявлен|соцсет|социальн" +
        R +
        "\\s+сет|инстаграм|реклам|видят\\s+работ|узнают\\s+(?:о\\s+нас|через)"
    ).test(q)
  ) {
    stages.push("discover");
  }
  if (/смотр|фото|описан|сравнива|изуча/.test(q)) stages.push("inspect");
  if (
    new RegExp(
      "пиш|звон|whatsapp|ватсап|мессенджер|связыв|контакт|личн" +
        R +
        "\\s+сообщ|телеграм|direct|директ"
    ).test(q)
  ) {
    stages.push("contact");
  }
  if (
    new RegExp(
      "уточня|количеств" +
        R +
        "\\s+гост|спрашива|выясня" +
        R +
        ".{0,24}(?:цель|уровень)|цель\\s+и\\s+уровень|отвеча" +
        R +
        "\\s+на\\s+вопрос|рассказ" +
        R +
        "\\s+о\\s+(?:занят|расписан|свобод|стоим|цен)"
    ).test(q)
  ) {
    stages.push("qualify");
  }
  if (
    /провер.{0,28}(?:свобод|номер|дат)/.test(q) ||
    /называ.{0,16}(?:стоим|цен)/.test(q) ||
    new RegExp("сообща" + R + ".{0,40}(?:свобод|стоим|цен)").test(q) ||
    new RegExp("свободн" + R + "\\s+мест").test(q) ||
    (/(?:свободн|стоим|цен[аыуе])/.test(q) && /провер|называ|смотр|сообща/.test(q))
  ) {
    stages.push("availability");
  }
  if (
    new RegExp(
      "предоплат|подтвержд|оформ.{0,16}брон|заброн|переводи|оплачива|оплату|оплата|расписание\\s+и\\s+оплат|записыва" +
        R +
        "|запись\\s+вручную|вручную\\s+записыва|оформл" +
        R +
        "\\s+запись"
    ).test(q)
  ) {
    stages.push("book");
  }
  // Service / education process (tutoring, consulting, studios).
  if (new RegExp("пробн" + R + "\\s+(?:занят|урок)|пробный\\s+(?:урок|занят)").test(q)) {
    stages.push("trial");
  }
  if (
    new RegExp(
      "предлага" + R + ".{0,20}формат|обсужда" + R + ".{0,20}формат|формат\\s+занят"
    ).test(q)
  ) {
    stages.push("offer");
  }
  if (
    new RegExp(
      "начина" + R + "\\s+(?:занят|работ)|ведём\\s+занят|провожу\\s+занят|начинаем\\s+занят"
    ).test(q)
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
  const mentionsCrm =
    /\bcrm\b/.test(q) &&
    !/(?:нет\s+crm|crm\s+нет|ни\s+crm|отдельн\w*\s+crm.{0,48}нет|crm.{0,48}нет)/.test(q);
  const mentionsCms = /\bcms\b/.test(q) && !/(?:нет\s+cms|cms\s+нет|ни\s+cms)/.test(q);
  const mentionsBot =
    /(?:есть|веду|использу|работа)\w*.{0,16}(?:бот|чат-?бот)/.test(q) ||
    /(?:бот|чат-?бот)\s+(?:есть|вед|использу)/.test(q);
  return (
    /систем[аыуе]\s+бронир|бронир\w*\s+систем|модул\w*\s+(?:онлайн|бронир)|онлайн-?бронир/.test(q) ||
    (/календар/.test(q) && !/календар\w*.{0,24}нет|нет\s+календар/.test(q)) ||
    mentionsCrm ||
    mentionsCms ||
    (/таблиц/.test(q) && !/(?:нет\s+таблиц|ни\s+таблиц|таблиц\w*\s+нет)/.test(q)) ||
    /заметк|блокнот|журнал(?:е|а|у)?(?:\s|$|,|\.)/.test(q) ||
    mentionsBot ||
    /баз[аыуе]\s+данн/.test(q) ||
    /интеграц|автоматиз/.test(q) ||
    /форм[аыуе]\s+заяв|заявк\w*\s+форм/.test(q) ||
    /сайт[аеу]?\s+(?:есть|работа|вед|на\s+)/.test(q)
  );
}

function isChannelOnlyToolsText(text) {
  if (hasOperationalToolSignal(text)) return false;
  const hasChannel = new RegExp(
    "whatsapp|ватсап|телефон|звон|авито|соцсет|социальн" +
      R +
      "\\s+сет|инстаграм|телеграм|личн" +
      R +
      "\\s+сообщ|direct|директ"
  ).test(text);
  const siteOrCrmGone = /сайта?\s+нет|нет\s+сайта|crm\s+нет|нет\s+crm|бота?\s+нет/.test(text);
  return hasChannel || siteOrCrmGone;
}

function hasBroadToolsAbsence(text) {
  const manual =
    /вручную|ничего не использу|кроме .{0,80}ничего|всё\s+в\s+(?:телефон|заметк|блокнот|тетрад|excel|таблиц)/.test(
      text
    );
  const absenceHits =
    (/ни\s+crm|crm\s+нет|нет\s+crm/.test(text) ? 1 : 0) +
    (new RegExp("ни\\s+систем|систем" + R + "\\s+бронир" + R + "\\s+нет|нет\\s+систем" + R + "\\s+бронир").test(
      text
    )
      ? 1
      : 0) +
    (new RegExp("ни\\s+таблиц|таблиц" + R + "\\s+нет").test(text) ? 1 : 0) +
    (/ни\s+бот|бота?\s+нет|нет\s+бота/.test(text) ? 1 : 0) +
    (/ни\s+друг|других\s+програм/.test(text) ? 1 : 0) +
    (/(?:только\s+)?(?:в\s+)?(?:телефон|заметк|блокнот)|без\s+(?:crm|систем|сайт)/.test(text) ? 1 : 0);
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
    /хотим,?\s+чтобы/.test(text) ||
    /хочу\s+(?:календар|заявк|форм|сайт|страниц|витрин|онлайн|дать|иметь)/.test(text) ||
    /хотим\s+(?:календар|заявк|форм|сайт|страниц|витрин|онлайн|дать|иметь)/.test(text) ||
    new RegExp("коротк" + R + "\\s+форм" + R + "\\s+заказ").test(text) ||
    new RegExp("форм" + R + "\\s+заказ" + R + "\\s+с\\s+дат").test(text) ||
    /хотелось\s+бы(?:,?\s+чтобы)?/.test(text) ||
    /хотелось\s+бы\s+дать\s+возможность/.test(text) ||
    /в\s+идеале/.test(text) ||
    /пусть\s+(?:сам[аиу]?|клиент|гость|человек|родитель|заказчик)/.test(text) ||
    /нужн[ао]\s+(?:витрин|страниц|сайт|форм|онлайн-?заявк|запис|календар)/.test(text) ||
    /человек\s+сначала\s+читает/.test(text) ||
    new RegExp(
      "чтобы\\s+(?:до\\s+" + R + "\\s+)*(?:гость|клиент|человек|ученик|заказчик|родитель|он|они)"
    ).test(text);

  const clientSelfServe =
    /сам[аиу]?\s+(?:посмотр|смотр|увид|получ|оформ|заброн|брон|выбр|узна|остав|поня|чита)/.test(text) ||
    new RegExp(
      "мог[лаи]?(?:\\s+" +
        R +
        "){0,4}\\s+(?:посмотр|смотр|увид|получ|оформ|заброн|брон|выбр|узна|поня|остав)"
    ).test(text) ||
    new RegExp(
      "чтобы\\s+(?:до\\s+" +
        R +
        "\\s+)*(?:гость|клиент|человек|ученик|заказчик|родитель|он|они)(?:\\s+" +
        R +
        "){0,5}\\s+(?:сам|мог|посмотр|смотр|оформ|заброн|брон|поня)"
    ).test(text) ||
    /самостоятельн/.test(text) ||
    /пусть\s+(?:сам[аиу]?|клиент|гость|человек|родитель|заказчик)/.test(text) ||
    /остав(?:ить|ил|ила|или|лял|ляла|ляли)(?:\s+бы)?\s+заявк|выбрать\s+время|оформить\s+(?:заявк|брон)|записаться\s+на|форм\w*\s+заявк|онлайн-?заявк|витрин|анкет|форм\w*.{0,80}заявк/.test(
      text
    ) ||
    /заявк/.test(text) ||
    new RegExp("форм" + R + "\\s+заказ").test(text) ||
    new RegExp("календар" + R + "\\s+занят").test(text) ||
    /без\s+долгой\s+переписк/.test(text) ||
    /сначала\s+читает|отвечает\s+на\s+вопросы/.test(text) ||
    new RegExp("коротк" + R + "\\s+форм").test(text) ||
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

function hasDeepJourneyProcess(stages) {
  const deep = ["qualify", "availability", "book", "trial", "offer", "deliver"];
  for (let i = 0; i < deep.length; i += 1) {
    if (stages.indexOf(deep[i]) !== -1) return true;
  }
  return false;
}

/**
 * Span is usable as partial journey evidence for recovery.
 * Rejects audience/FAQ-only text that only trips qualify via «спрашивают».
 */
function isJourneyPartialEvidence(text) {
  const q = normalizeSpan(text);
  if (!q) return false;
  const stages = detectJourneyStages(q);
  if (!stages.length) return false;
  const unique = [];
  for (let i = 0; i < stages.length; i += 1) {
    if (unique.indexOf(stages[i]) === -1) unique.push(stages[i]);
  }
  if (unique.length === 1 && unique[0] === "qualify") {
    if (/спрашива/.test(q) && !new RegExp("уточня|выясня|количеств" + R + "\\s+гост|цель\\s+и\\s+уровень").test(q)) {
      return false;
    }
  }
  return true;
}

/**
 * Clarify aspect for partial customerJourney (prompt selection only — not Gate aspects).
 * null → full FOCUS prompt; after_source / after_contact → missing-stage follow-up.
 */
export function journeyClarifyAspect(sources) {
  if (isCustomerJourneySufficient(sources)) return null;
  const text = combineSourceQuotes(sources);
  if (!text) return "after_source";
  const stages = detectJourneyStages(text);
  const unique = [];
  for (let i = 0; i < stages.length; i += 1) {
    if (unique.indexOf(stages[i]) === -1) unique.push(stages[i]);
  }
  // Never fall back to the full JOURNEY prompt while evidence exists but stages
  // are not yet classified — ask the next missing stage, not the whole path.
  if (!unique.length) return "after_source";

  const hasDiscover = unique.indexOf("discover") !== -1;
  const hasContact = unique.indexOf("contact") !== -1;
  const hasInspect = unique.indexOf("inspect") !== -1;
  const hasDeep = hasDeepJourneyProcess(unique);

  if (hasDeep) return "after_contact";
  if (hasDiscover && !hasContact && !hasInspect) return "after_source";
  if (hasDiscover || hasContact || hasInspect) return "after_contact";
  return "after_source";
}

/**
 * Clarify aspect for partial existingTools.
 * beyond_channels → do not re-list WhatsApp/соцсети as if unknown.
 */
export function toolsClarifyAspect(sources) {
  if (isExistingToolsSufficient(sources)) return null;
  const text = combineSourceQuotes(sources);
  if (!text) return null;
  if (isChannelOnlyToolsText(text)) return "beyond_channels";
  if (/сайта?\s+нет|нет\s+сайта|crm\s+нет|нет\s+crm/.test(text) && !hasOperationalToolSignal(text)) {
    return "beyond_channels";
  }
  return null;
}

function hasDesiredFlowSelfServeSignal(text) {
  return (
    /сам[аиу]?\s+(?:посмотр|увид|получ|оформ|заброн|выбр|узна|остав)/.test(text) ||
    /оставить\s+заявк|выбрать\s+время|оформить\s+(?:заявк|брон)|записаться\s+на/.test(text) ||
    /заранее\s+понять|понять\s+(?:мой\s+)?формат|дать\s+возможность|самостоятельн/.test(text)
  );
}

/**
 * Clarify aspect for partial desiredFlow.
 * client_autonomy → pain/goal known, ask only self-serve / ideal client action.
 */
export function flowClarifyAspect(sources) {
  if (isDesiredFlowSufficient(sources)) return null;
  const text = combineSourceQuotes(sources);
  if (!text) return null;
  if (hasDesiredFlowSelfServeSignal(text)) return null;
  const hasPainOrGoal =
    /не\s+хочу|не\s+приходилось|одинаков|повторя|меньше\s+(?:тратить|зависеть)|нужен\s+сайт|больше\s+прямых|заново\s+рассказ|одни\s+и\s+те\s+же/.test(
      text
    );
  if (hasPainOrGoal) return "client_autonomy";
  return null;
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
  // Semantic filter for critical identity fields — but allow short grounded
  // replace corrections and quotes from a turn that itself carries the signal.
  if (src.operation !== "replace") {
    const turnText = turnsById[src.turnId] || "";
    if (fieldKey === "business") {
      if (!looksLikeBusinessEvidence(src.quote) && !looksLikeBusinessEvidence(turnText)) return null;
    }
    if (fieldKey === "goal") {
      if (!looksLikeGoalEvidence(src.quote) && !looksLikeGoalEvidence(turnText)) return null;
    }
    if (fieldKey === "friction") {
      if (!looksLikeFrictionEvidence(src.quote) && !looksLikeFrictionEvidence(turnText)) return null;
    }
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
export function mergeBriefCoverage(priorBriefState, modelCoverage, userTurns, history) {
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

      const recovered = recoverSourcesFromTurns(key, userTurns || [], history).filter(function (s) {
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

  // Conservative cross-field implication: goal + manual journey (+ friction)
  // can close desiredFlow without re-asking the same meaning.
  if (coverage.desiredFlow.status !== "known") {
    const implied = recoverImpliedDesiredFlowSources(userTurns || [], coverage);
    if (implied.length) {
      const mergedDesired = applySupersedePolicy(
        (coverage.desiredFlow.sources || []).concat(implied),
        "desiredFlow",
        turnsById
      );
      coverage.desiredFlow.sources = mergedDesired;
      coverage.desiredFlow.status = deriveFieldStatus("desiredFlow", mergedDesired, turnsById);
      if (
        coverage.desiredFlow.status !== "known" &&
        hasStrongDesiredFlowImplication(coverage, userTurns || [])
      ) {
        // Implication is strong and grounded via recovered span — treat as known.
        coverage.desiredFlow.status = "known";
      }
    }
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
 * Pure channel / acquisition sentences are not business identity.
 */
function isChannelOnlyBusinessSpan(q) {
  const channel =
    /(?:приход|наход|узнают|пишут|заявки\s+идут|через\s+(?:соц|авито|реклам)|рекомендац|сарафан|мессенджер|whatsapp|ватсап|telegram|телеграм)/.test(
      q
    );
  if (!channel) return false;
  const activity =
    /(?:веду|ведём|оказыва|занима|консультир|сопровожд|сда[её]|шью|шьём|помога|провожу|проводим|прода[её]|бер[уё]|делаю|делаем|сопровожд|студи|магазин|гостев|квартир|салон|преподав|репетитор|услуг|производ|текстил|оборудован|налог|отчётн|отчетн|компани)/.test(
      q
    );
  return !activity;
}

/**
 * Recover field sources from USER_TURNS using the same semantic validators as gates.
 * Does not invent paraphrases — only exact contiguous spans from user text.
 *
 * BUSINESS = semantic activity / offering detection — not a niche keyword list
 * and not limited to «я занимаюсь X» / «мы предлагаем Y».
 */
export function looksLikeBusinessEvidence(quote) {
  const q = normalizeSpan(quote);
  if (!q || q.length < Math.max(GATE_POLICY.minQuoteChars, 20)) return false;
  if (isChannelOnlyBusinessSpan(q)) return false;

  // «У меня / у нас …» + concrete activity or venue.
  if (
    /(?:^|[^а-яё])(?:у\s+меня|у\s+нас)\s+/.test(q) &&
    /(?:студи|магазин|гостев|салон|квартир|бизнес|школ|мастерск|ателье|кафе|клиник|производ|небольш)/.test(
      q
    )
  ) {
    return true;
  }

  // First-person / we activity verbs (веду, оказываю, консультирую, сдаю, шью, помогаю, готовлю…).
  if (
    new RegExp(
      "(?:^|[^а-яё])(?:я|мы)\\s+(?:веду|ведём|оказыва" +
        R +
        "|занима" +
        R +
        "|консультир" +
        R +
        "|сопровожд" +
        R +
        "|сда[её]" +
        R +
        "|шью|шьём|помога" +
        R +
        "|провожу|проводим|прода[её]" +
        R +
        "|бер[уё]" +
        R +
        "|делаю|делаем|работаю|работаем|снимаю|снимаем|готовлю|готовим)",
      "i"
    ).test(q)
  ) {
    if (
      /(?:сопровожд|консульт|налог|отчётн|отчетн|услуг|учёт|учет|бизнес|занят|квартир|текстил|кадров|английск|оборудован|товар|заказ|ип|ооо|компани|малого|клиент|на\s+заказ|посуточн|для\s+(?:дом|дет|кафе|компани)|маникюр|фото|съём|съем|ремонт|школьник|математик)/.test(
        q
      )
    ) {
      return true;
    }
    // Substantial first-person activity sentence without requiring a niche noun.
    if (q.length >= 36) return true;
  }

  // Bare activity verbs at sentence start («Оказываю…», «Веду…», «Консультирую…», «Готовлю…», «Делаю…»).
  if (
    new RegExp(
      "(?:^|[^а-яё])(?:оказыва" +
        R +
        "|веду|ведём|занима" +
        R +
        "|консультир" +
        R +
        "|сопровожд" +
        R +
        "|помога" +
        R +
        "|провожу|проводим|снимаю|снимаем|прода[её]" +
        R +
        "|готовлю|готовим|делаю|делаем|держу|держим)\\s+\\S+",
      "i"
    ).test(q)
  ) {
    return true;
  }

  // Occupation / venue openings without requiring «я» («Мастер маникюра…», «Веду английский…»).
  if (
    new RegExp(
      "(?:^|[^а-яё])(?:мастер|парикмахер|фотограф|репетитор|преподаватель|автосервис|салон)(?:[^а-яё]|$)|" +
        "(?:^|[^а-яё])веду\\s+\\S+|" +
        "(?:^|[^а-яё])снимаю\\s+\\S+|" +
        "небольш" +
        R +
        "\\s+(?:автосервис|сервис|салон|студи|бизнес)",
      "i"
    ).test(q)
  ) {
    return true;
  }

  // «Я мастер …» short identity.
  if (/(?:^|[^а-яё])я\s+мастер\s+\S+/i.test(q)) return true;

  // Imperative / plural offering without explicit «я» («Продаём…», «Сдаю…»).
  if (
    new RegExp(
      "(?:^|[^а-яё])(?:сда[её]" +
        R +
        "|шью|шьём|прода[её]" +
        R +
        "|провожу|проводим|помогаю|помогаем|веду|ведём)\\s+\\S+",
      "i"
    ).test(q)
  ) {
    return true;
  }

  // Legacy / niche anchors (kept for existing grounded quotes).
  return /(?:гостев|магазин|студи|перевоз|репетитор|преподав|услуг|производ|упаков|бренд|клиник|салон|цветоч|букет|груз|интернет-?магазин|занимаюсь|занимаемся|делаем\s+(?:небольш|букет|парти)|посуточн|на\s+заказ|маникюр|автосервис|продаж[аиеу]\s+\S+|прода[еёю]\s+\S+|торгу|постельн|бель|кондитер|торт|курс|ремонт\s+квартир)/i.test(
    q
  );
}

export function looksLikeGoalEvidence(quote) {
  const q = normalizeSpan(quote);
  if (!q || q.length < Math.max(GATE_POLICY.minQuoteChars, 20)) return false;
  // Soft desire: «хотелось бы …» (not only хочу/хочется).
  // Sales growth outcomes: увеличить продажи / привлечь (новых) клиентов|покупателей.
  return new RegExp(
    "(?:хочу|хочется|хотим|хотелось\\s+бы|(?:увеличить|вырастить)\\s+продаж|привлечь\\s+(?:нов" +
      R +
      "\\s+)?(?:клиент|покупател)|нужен\\s+(?:сайт|спокойн)|нужна\\s+страниц|нужно,?\\s+чтобы|нужно\\s+(?:сократить|упростить|меньше)|меньше\\s+(?:зависеть|перепис)|снизить\\s+переписк|чтобы\\s+(?:человек|клиент|гост|ученик|о\\s+нас)|оставить\\s+заявк|основн" +
      R +
      "\\s+задач|задач[аиеу]\\s*[—\\-–:]|цель\\s*[—\\-–:]|упростить\\s+(?:запись|брон|вход)|хочу,?\\s+чтобы|улучшить\\s+(?:именно\\s+)?работ|сократить\\s+(?:время|ручн)|меньше\\s+(?:однотипн|ручн|хаос|отвечать|переписк)|сами\\s+выбирал|больше\\s+людей\\s+узнал|реклам|думаю\\s+о\\s+сайт|до\\s+переписк|заявка\\s+уже\\s+с\\s+вводн|одно\\s+и\\s+то\\s+же)",
    "i"
  ).test(q);
}

/**
 * Model WHO ask that actually probes purchase occasion/scenario
 * («для себя / в подарок / для семьи / для дома») — not demographic WHO.
 */
export function looksLikePurchaseOccasionWhoQuestion(text) {
  const t = normalizeSpan(text);
  if (!t) return false;
  const whoFrame =
    /кто\s+(?:чаще|обычно).{0,48}(?:покупает|обращается|приходит)/.test(t) ||
    /чтобы\s+точнее\s+понять\s+аудиторию/.test(t) ||
    /понять\s+аудиторию/.test(t);
  const occasionBundle =
    (/для\s+себя/.test(t) && /(?:в\s+подарок|для\s+(?:семь|дома))/.test(t)) ||
    (/в\s+подарок/.test(t) && /для\s+(?:семь|дома)/.test(t)) ||
    /для\s+себя.{0,48}в\s+подарок.{0,48}для\s+(?:семь|дома)/.test(t);
  return whoFrame && occasionBundle;
}

export function looksLikeFrictionEvidence(quote) {
  const q = normalizeSpan(quote);
  if (!q || q.length < Math.max(GATE_POLICY.minQuoteChars, 12)) return false;
  return /(?:приходится|приходилось|не\s+приходилось|заново\s+рассказ|одни\s+и\s+те\s+же|одно\s+и\s+то\s+же|вручную|повторя|переписк|одинаков|уходит\s+(?:слишком\s+)?много\s+времени|времени?\s+уходит\s+на|уходит\s+на\s+консультац|трат\w*\s+(?:слишком\s+)?много\s+времени|трат\w*\s+время\s+на\s+(?:консультац|одинаков|вопрос)|повторя\w*\s+консультац|занимает\s+(?:слишком\s+)?много|много\s+времени\s+на|меньше\s+(?:переписк|тратить|времени|зависеть|отвечать)|всё\s+руками|хаос\s+в\s+заявк|каждому\s+заново|в\s+личк|зависеть\s+от\s+площад|пута\w*|в\s+чатах|какой\s+номер\s+кому|теря\w*\s+(?:заявк|клиент|время)|забыва\w*|путан\w*|уход\w*\s+подумать|не\s+возвраща|пропал|пропадает|ну\s+что\s+там|с\s+моим|постоянн\w*\s+[«\"])/i.test(
    q
  );
}

export function recoverSourcesFromTurns(fieldKey, userTurns, history) {
  const turns = userTurns || [];
  const out = [];

  for (let t = 0; t < turns.length; t += 1) {
    const turn = turns[t];
    if (!turn || !turn.id || !isNonEmptyString(turn.text)) continue;
    const spans = candidateSpans(turn.text);
    if (
      fieldKey === "audienceInput" &&
      isAudienceWhoEvidenceInHistory(turn.text, history) &&
      spans.indexOf(turn.text) === -1
    ) {
      spans.push(turn.text);
    }

    if (fieldKey === "business") {
      for (let i = 0; i < spans.length; i += 1) {
        if (looksLikeBusinessEvidence(spans[i])) {
          out.push({
            turnId: turn.id,
            quote: spans[i],
            aspect: "what_business",
            operation: "support"
          });
          break;
        }
      }
      continue;
    }

    if (fieldKey === "goal") {
      for (let i = 0; i < spans.length; i += 1) {
        if (looksLikeGoalEvidence(spans[i])) {
          out.push({
            turnId: turn.id,
            quote: spans[i],
            aspect: "desired_outcome",
            operation: "support"
          });
          break;
        }
      }
      continue;
    }

    if (fieldKey === "friction") {
      let best = null;
      let bestScore = -1;
      for (let i = 0; i < spans.length; i += 1) {
        if (!looksLikeFrictionEvidence(spans[i])) continue;
        // Prefer atomic pain clauses over multi-fact opening dumps.
        let score = 500 - Math.min(String(spans[i]).length, 400);
        if (isMultiFactDumpQuote(spans[i])) score -= 300;
        if (
          /одинаков|стоим|срок|пропал|консультац|времени?\s+уходит/i.test(spans[i])
        ) {
          score += 80;
        }
        if (score > bestScore) {
          bestScore = score;
          best = spans[i];
        }
      }
      if (best) {
        out.push({
          turnId: turn.id,
          quote: best,
          aspect: "pain",
          operation: "support"
        });
      }
      continue;
    }

    if (fieldKey === "audienceInput") {
      for (let i = 0; i < spans.length; i += 1) {
        const span = spans[i];
        if (isAudienceWhoEvidence(span) || isAudienceWhoEvidenceInHistory(span, history)) {
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
      let sufficient = null;
      let partial = null;
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
          sufficient = trial[0];
          break;
        }
        if (!partial && isJourneyPartialEvidence(spans[i])) {
          partial = trial[0];
        }
      }
      if (sufficient) out.push(sufficient);
      else if (partial) out.push(partial);
      continue;
    }

    if (fieldKey === "existingTools") {
      let best = null;
      let bestScore = -1;
      for (let i = 0; i < spans.length; i += 1) {
        const trial = [
          { turnId: turn.id, quote: spans[i], aspect: "tools", operation: "support" }
        ];
        const spanNorm = normalizeSpan(spans[i]);
        const sufficient = isExistingToolsSufficient(trial);
        const ops = hasOperationalToolSignal(spanNorm);
        const partial =
          isChannelOnlyToolsText(spanNorm) ||
          ops ||
          /сайта?\s+нет|нет\s+сайта/.test(spanNorm);
        if (!sufficient && !partial) continue;
        let score = (sufficient ? 400 : 100) - Math.min(String(spans[i]).length, 400);
        // Dump penalty is mild when operational tools are present — keep table/calendar spans.
        if (isMultiFactDumpQuote(spans[i])) score -= ops || sufficient ? 80 : 350;
        if (ops) score += 60;
        if (hasBroadToolsAbsence(spanNorm) && String(spans[i]).length <= 160) score += 40;
        if (score > bestScore) {
          bestScore = score;
          best = spans[i];
        }
      }
      if (best) {
        out.push({
          turnId: turn.id,
          quote: best,
          aspect: "tools",
          operation: "support"
        });
      }
      continue;
    }

    if (fieldKey === "desiredFlow") {
      let sufficient = null;
      let partial = null;
      for (let i = 0; i < spans.length; i += 1) {
        const trial = [
          {
            turnId: turn.id,
            quote: spans[i],
            aspect: "ideal_flow",
            operation: "support"
          }
        ];
        const spanNorm = normalizeSpan(spans[i]);
        if (isDesiredFlowSufficient(trial)) {
          sufficient = trial[0];
          break;
        }
        if (
          !partial &&
          (/не\s+хочу|не\s+приходилось|одинаков|повторя|меньше\s+(?:тратить|зависеть)|нужен\s+сайт|заново\s+рассказ|одни\s+и\s+те\s+же/.test(
            spanNorm
          ) ||
            hasDesiredFlowSelfServeSignal(spanNorm))
        ) {
          partial = trial[0];
        }
      }
      if (sufficient) out.push(sufficient);
      else if (partial) out.push(partial);
      continue;
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
 * For partial compound fields → ask only the missing aspect/stage (audience / journey / tools / flow).
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
      // ONE TURN = ONE MAIN QUESTION: ask who before what_matters, never both.
      return { focus: key, aspect: "who_or_segment" };
    }

    if (key === "customerJourney") {
      return { focus: key, aspect: journeyClarifyAspect(sources) };
    }

    if (key === "existingTools") {
      return { focus: key, aspect: toolsClarifyAspect(sources) };
    }

    if (key === "desiredFlow") {
      return { focus: key, aspect: flowClarifyAspect(sources) };
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
      // Conservative desiredFlow promotion from goal+manual journey implication.
      if (key === "desiredFlow" && hasStrongDesiredFlowImplication(coverage, userTurns || [])) {
        const implied = recoverImpliedDesiredFlowSources(userTurns || [], coverage);
        if (implied.length) {
          const mergedDesired = applySupersedePolicy(
            (sources || []).concat(implied),
            "desiredFlow",
            turnsById
          );
          coverage[key].sources = mergedDesired;
          coverage[key].status = "known";
          continue;
        }
      }
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
export function evaluateExpertPlan(turn, briefReadyCoverage, userTurns) {
  const mode = turn.recommendationMode;
  const issues = [];
  const userTurnsForBias = Array.isArray(userTurns) ? userTurns : [];

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

  // Grounding / bias guards for recommendation quality (structural, not soft style).
  const primary = isNonEmptyString(plan.primarySolution)
    ? normalizeSpan(plan.primarySolution)
    : "";
  const alternative = isNonEmptyString(plan.alternative) ? normalizeSpan(plan.alternative) : "";
  const addLater = isNonEmptyString(plan.addLater) ? normalizeSpan(plan.addLater) : "";
  const assistant = typeof turn.assistantMessage === "string" ? normalizeSpan(turn.assistantMessage) : "";

  const sitePrimary =
    /сайт|лендинг|веб-?сайт|web.?site/.test(primary) &&
    !/(?:сервис|saas|модул|интеграц|бот|crm|готовы|очеред|заявк|контур|telegram|мессендж)/.test(
      primary
    );
  const altHasNonSite =
    /сервис|saas|модул|интеграц|бот|crm|готовы|мессендж|whatsapp|telegram|direct|faq|таблиц|календар|очеред|заявк|none:/.test(
      alternative
    ) || isNoneToken(plan.alternative || "");
  if (sitePrimary && !altHasNonSite) {
    issues.push("website_bias_missing_alternative");
  }

  // Evidence ranking: if deterministic ranking prefers non-site class, bare site primary fails.
  if (sitePrimary && userTurnsForBias.length) {
    const ranked = buildEvidenceBackedRecommendation(
      briefReadyCoverage || {},
      userTurnsForBias
    );
    const rankedPrimary = normalizeSpan(
      (ranked.expertPlan && ranked.expertPlan.primarySolution) || ""
    );
    const rankedPageLike = /каталог|витрин|страниц|сайт|лендинг/.test(rankedPrimary);
    const rankedNonSite =
      rankedPrimary &&
      !rankedPageLike &&
      !/(?:^|\s)(?:компактн\w*\s+)?сайт/.test(rankedPrimary) &&
      /telegram|бот|мессендж|whatsapp|контур\s+при[её]ма|сервис\s+онлайн|готов\w*\s+сервис|информационн\w*\s+контур|структурированн\w*\s+при[её]м/.test(
        rankedPrimary
      );
    if (rankedNonSite) {
      issues.push("website_bias_against_evidence");
    }
  }

  const unsupportedDump =
    new RegExp("личн" + R + "\\s+кабинет|программ" + R + "\\s+лояльн|блог\\b|система\\s+лояльн").test(
      addLater
    ) ||
    new RegExp("личн" + R + "\\s+кабинет|программ" + R + "\\s+лояльн|блог\\b").test(assistant);
  if (unsupportedDump) {
    issues.push("unsupported_feature_dump");
  }

  // Never publish MARK_HYPOTHESIS as established USER_FACT (queue/chaos/notebook/slots).
  if (userTurnsForBias.length) {
    const evGuard = collectSolutionEvidence(briefReadyCoverage || {}, userTurnsForBias);
    const why = isNonEmptyString(plan.whyPrimary) ? normalizeSpan(plan.whyPrimary) : "";
    const inventsQueueChaos =
      /хаос\s+заявк|главная\s+боль.{0,48}(?:хаос|очеред)|вместо\s+блокнота|единый\s+список\s+статусов/.test(
        assistant + " " + why + " " + primary
      );
    if (inventsQueueChaos && !evGuard.queueChaos) {
      issues.push("ungrounded_queue_chaos_claim");
    }
    if (evGuard.rejectedQueue && inventsQueueChaos) {
      issues.push("rejected_hypothesis_reused");
    }
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
 * history (optional) enables MARK-question dedup / no-progress protection.
 */
export function selectClarifyMessage(turn, missing, coverage, userTurns, history) {
  const hist = Array.isArray(history) ? history : [];
  const turns = userTurns || [];
  const dialogue = evaluateDialogueReady(coverage, turns, evaluateBriefReady);
  const briefProbe =
    coverage && typeof coverage === "object"
      ? { ready: dialogue.ready, missing: dialogue.missing.length ? dialogue.missing : missing || [], coverage: dialogue.coverage }
      : { ready: false, missing: missing || [] };
  const solution = evaluateSolutionReady(coverage, turns);

  // Dialogue controller: prefer useful next step over MVB missing[0] quiz order.
  // If caller scoped `missing` to specific fields, stay inside that scope.
  if (!dialogue.ready && coverage && typeof coverage === "object") {
    const forceShift =
      hist.length >= 4 &&
      extractMarkQuestionsFromHistory(hist).length >= 2 &&
      questionsShareSemanticTarget(
        extractMarkQuestionsFromHistory(hist).slice(-1)[0],
        extractMarkQuestionsFromHistory(hist).slice(-2)[0]
      );
    const step = planNextUsefulStep(coverage, turns, { forceStrategyShift: forceShift });
    const missingKeys = (missing || [])
      .map(function (m) {
        return m && m.key;
      })
      .filter(Boolean);
    const stepAllowed =
      Boolean(step && step.focus) &&
      (missingKeys.length === 0 || missingKeys.indexOf(step.focus) !== -1);
    if (step && step.kind === "clarify" && stepAllowed) {
      const target = resolveClarifyTarget(
        [{ key: step.focus, reason: step.reason || "dialogue_gap" }],
        coverage,
        turns
      );
      const focus = target.focus || step.focus;
      const aspect = target.aspect || step.aspect || null;
      const sources =
        focus && coverage[focus] && Array.isArray(coverage[focus].sources)
          ? coverage[focus].sources
          : [];
      const question =
        promptForFocus(focus, aspect, sources, coverage, turns) || step.question;
      if (question) {
        const published = publishClarifyQuestion(
          question,
          coverage,
          turns,
          dialogue.missing.length ? dialogue.missing : missing || [],
          hist
        );
        if (published) return published;
      }
    } else if (
      step &&
      step.kind === "clarify" &&
      step.question &&
      missingKeys.length === 0
    ) {
      const published = publishClarifyQuestion(
        step.question,
        coverage,
        turns,
        dialogue.missing.length ? dialogue.missing : missing || [],
        hist
      );
      if (published) return published;
    }
  }

  // No-progress: recent MARK questions share a target and coverage did not advance.
  const priorMarks = extractMarkQuestionsFromHistory(hist);
  if (priorMarks.length >= 2) {
    const a = priorMarks[priorMarks.length - 1];
    const b = priorMarks[priorMarks.length - 2];
    if (questionsShareSemanticTarget(a, b)) {
      const fa = inferQuestionTargetField(a);
      const aa = inferQuestionTargetAspect(a);
      if (fa && (isTargetAlreadyKnown(coverage, userTurns, fa, aa) || wasAspectAskedAndAnswered(hist, fa, aa))) {
        if (briefProbe.ready && solution.ready) {
          return ""; // caller should recommend
        }
        if (briefProbe.ready && !solution.ready) {
          return publishClarifyQuestion(
            solution.question || pickSolutionDiscriminatorQuestion(coverage, userTurns || []),
            coverage,
            userTurns || [],
            [{ key: "solution_discriminator", reason: "no_progress" }],
            hist
          );
        }
        const stepAlt = planNextUsefulStep(coverage, turns, { forceStrategyShift: true });
        if (stepAlt && stepAlt.question) {
          return publishClarifyQuestion(
            stepAlt.question,
            coverage,
            turns,
            dialogue.missing,
            hist
          );
        }
        const forced = promptForMissingTarget(briefProbe.missing, coverage, userTurns, fa, aa);
        if (forced) {
          return publishClarifyQuestion(forced, coverage, userTurns || [], briefProbe.missing, hist);
        }
        if (briefProbe.ready) return "";
      }
    }
  }

  // Fail-safe: never emit READY_REPAIR / recommend-failure while solution class is open.
  if (briefProbe.ready && !solution.ready) {
    return publishClarifyQuestion(
      solution.question || pickSolutionDiscriminatorQuestion(coverage, userTurns || []),
      coverage,
      userTurns || [],
      [{ key: "solution_discriminator", reason: solution.reason || "need_discriminator" }],
      hist
    );
  }

  for (let i = 0; i < (missing || []).length; i += 1) {
    if (missing[i] && missing[i].key === "solution_discriminator") {
      return publishClarifyQuestion(
        solution.question || pickSolutionDiscriminatorQuestion(coverage, userTurns || []),
        coverage,
        userTurns || [],
        missing,
        hist
      );
    }
  }

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
    if (briefProbe.ready && !solution.ready && solution.question) {
      return publishClarifyQuestion(solution.question, coverage, userTurns || [], missing, hist);
    }
    if (briefProbe.ready && solution.ready) return "";
    if (briefProbe.ready) {
      return (
        solution.question ||
        pickSolutionDiscriminatorQuestion(coverage, userTurns || []) ||
        ""
      );
    }
    return READY_REPAIR_FALLBACK;
  }

  // Model may only supply fallback when focus matches AND we are not in an
  // aspect-only partial clarify (prefer server missing-aspect prompt).
  const focusAligned =
    modelFocus === serverFocus &&
    modelFocus !== "none" &&
    missingIncludesFocus(missing, modelFocus) &&
    Boolean(FOCUS_PROMPTS[modelFocus]) &&
    !aspect;

  let candidate = "";
  if (
    fallback &&
    focusAligned &&
    !isServerFocusPrompt(fallback) &&
    !isCompoundDiscoveryQuestion(fallback) &&
    !hasInternalSystemWording(fallback)
  ) {
    candidate = fallback;
  } else if (fallback && focusAligned && !aspect && !isCompoundDiscoveryQuestion(fallback)) {
    if (isServerFocusPrompt(fallback)) {
      if (normalizeSpan(fallback) === normalizeSpan(FOCUS_PROMPTS[serverFocus] || "")) {
        candidate = fallback;
      }
    } else if (!hasInternalSystemWording(fallback)) {
      candidate = fallback;
    }
  }

  if (!candidate) {
    const sources =
      coverage && serverFocus && coverage[serverFocus] && Array.isArray(coverage[serverFocus].sources)
        ? coverage[serverFocus].sources
        : [];
    const prompt = promptForFocus(serverFocus, aspect, sources, coverage, userTurns);
    candidate = prompt || buildClarifyFromNeed({ focus: serverFocus, reason: "server" }, "");
  }

  const published = publishClarifyQuestion(
    candidate,
    coverage,
    userTurns || [],
    briefProbe.missing || missing,
    hist
  );
  if (!published) {
    if (briefProbe.ready && !solution.ready) {
      return publishClarifyQuestion(
        solution.question || pickSolutionDiscriminatorQuestion(coverage, userTurns || []),
        coverage,
        userTurns || [],
        [{ key: "solution_discriminator", reason: "after_publish_empty" }],
        hist
      );
    }
    if (briefProbe.ready) return "";
    // Brief NOT ready — never publish blank. Force next missing material ask.
    const forced =
      promptForMissingTarget(briefProbe.missing || missing, coverage, userTurns) ||
      pickSolutionDiscriminatorQuestion(coverage, userTurns || []) ||
      inferDialogueContext(coverage, userTurns || []).goalAsk;
    return publishClarifyQuestion(
      forced,
      coverage,
      userTurns || [],
      briefProbe.missing || missing,
      hist,
      1
    );
  }
  return published;
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
 * Detect multi-gap discovery dumps (several independent asks in one turn).
 * Used to reject unsafe model welcomes / clarify fallbacks.
 */
export function isCompoundDiscoveryQuestion(text) {
  const t = normalizeSpan(text);
  if (!t) return false;

  // Exact server prompts (including aspect prompts) are never "compound dumps"
  // except the legacy dual audience prompt.
  if (isServerFocusPrompt(text)) {
    return t === normalizeSpan(FOCUS_PROMPTS.audienceInput);
  }

  const marks = (t.match(/\?/g) || []).length;
  if (marks >= 2) return true;

  // Semantic compound: two independent asks joined by «и что/и как».
  if (
    /что\s+(?:клиент|человек|гость|ученик).{0,40}сам/.test(t) &&
    /(?:и|,)\s*что\s+(?:должно|тогда)\s+стать\s+проще/.test(t)
  ) {
    return true;
  }
  if (
    /кто\s+(?:чаще|обычно)/.test(t) &&
    /что\s+(?:этим\s+людям\s+|им\s+)?важно/.test(t) &&
    /и\s+что/.test(t)
  ) {
    return true;
  }

  const directions = [
    /расскажите.{0,48}подробнее/,
    /задач[аиеу].{0,40}решить/,
    /что\s+(?:сейчас\s+)?важно/,
    /какие?\s+(?:у\s+\w+\s+)?(?:возникают|трудности|вопросы)/,
    /какие?\s+цели/,
    /кто\s+(?:чаще|обычно)/,
    /что\s+(?:этим\s+людям\s+)?важно\s+при\s+выборе/,
    /как\s+(?:сейчас\s+)?(?:обычно\s+)?проходит\s+путь/,
    /какого\s+результата/,
    /какими\s+инструментами/,
    /в\s+идеале\s+что\s+(?:клиент|человек)/,
    /что\s+должно\s+стать\s+проще/
  ];
  let hits = 0;
  for (let i = 0; i < directions.length; i += 1) {
    if (directions[i].test(t)) hits += 1;
  }
  if (hits >= 3) return true;
  if (/например/.test(t) && hits >= 2) return true;

  return false;
}

/**
 * Structural welcome safety: identity present, not an MVB focus prompt dump,
 * not a compound multi-gap discovery, and turn is not in recommend/preliminary mode.
 */
export function isSafeWelcomeText(text, turn) {
  const t = typeof text === "string" ? text.trim() : "";
  if (t.length < 60) return false;
  if (!/Марк/i.test(t) || !/Оксан/i.test(t)) return false;
  if (!/AI|ИИ/i.test(t)) return false;
  if (isExactFocusPrompt(t)) return false;
  if (isCompoundDiscoveryQuestion(t)) return false;
  if (turn && (turn.recommendationMode === "normal" || turn.recommendationMode === "preliminary")) {
    return false;
  }
  if (turn && (turn.phase === "recommend" || turn.phase === "handoff")) return false;
  if (turn && turn.expertPlan && typeof turn.expertPlan === "object") return false;
  if (hasInternalSystemWording(t)) return false;
  return true;
}

/**
 * First-turn welcome: recover what the user already said, then ask ONE real gap.
 * Natural acknowledgement — no internal system wording.
 */
export function buildFirstTurnWelcome(message) {
  const msg = typeof message === "string" ? message.trim() : "";
  const userTurns = buildUserTurns([], msg);
  const merged = mergeBriefCoverage(null, {}, userTurns);
  const coverage = merged.coverage;
  const dialogue = evaluateDialogueReady(coverage, userTurns, evaluateBriefReady);
  const ready = {
    ready: dialogue.ready,
    missing: dialogue.missing.length ? dialogue.missing : dialogue.mvbMissing,
    coverage: dialogue.coverage
  };

  let hasEvidence = false;
  for (let i = 0; i < CRITICAL_COVERAGE_KEYS.length; i += 1) {
    const key = CRITICAL_COVERAGE_KEYS[i];
    if (coverage[key] && coverage[key].sources && coverage[key].sources.length) {
      hasEvidence = true;
      break;
    }
  }

  const identity = "Здравствуйте. Я Марк, AI-помощник Оксаны Ежевской. ";

  if (hasEvidence) {
    const step = planNextUsefulStep(coverage, userTurns);
    let question = null;
    if (step && step.kind === "clarify" && step.focus) {
      const target = resolveClarifyTarget(
        [{ key: step.focus, reason: step.reason || "dialogue_gap" }],
        coverage,
        userTurns
      );
      const focus = target.focus || step.focus;
      const aspect = target.aspect || step.aspect || null;
      const sources =
        focus && coverage[focus] && Array.isArray(coverage[focus].sources)
          ? coverage[focus].sources
          : [];
      question = promptForFocus(focus, aspect, sources, coverage, userTurns) || step.question;
    } else if (step && step.kind === "clarify") {
      question = step.question;
    }
    if (!question) {
      const target = resolveClarifyTarget(ready.missing, coverage, userTurns);
      const sources =
        target.focus && coverage[target.focus] && Array.isArray(coverage[target.focus].sources)
          ? coverage[target.focus].sources
          : [];
      question = promptForFocus(target.focus, target.aspect, sources, coverage, userTurns);
    }
    if (!question || isCompoundDiscoveryQuestion(question)) {
      question = inferDialogueContext(coverage, userTurns).goalAsk;
    }
    question = publishClarifyQuestion(question, coverage, userTurns, ready.missing, []);
    if (!question) {
      question = inferDialogueContext(coverage, userTurns).goalAsk;
      question = publishClarifyQuestion(question, coverage, userTurns, ready.missing, []);
    }
    const ack = buildContextAcknowledgement(coverage, userTurns);
    return identity + ack + " " + (question || inferDialogueContext(coverage, userTurns).goalAsk);
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
    identity +
    "Спасибо, что написали. Расскажите своими словами " +
    topic +
    " — что сейчас не устраивает и какой результат был бы для вас хорошим."
  );
}

/**
 * First-turn client text: prefer server gap-aware welcome; reject compound / internal wording.
 */
export function selectFirstTurnMessage(turn, message) {
  const serverWelcome = buildFirstTurnWelcome(message);
  const hasEvidenceAck = /Понял:|Спасибо, что написали/i.test(serverWelcome);
  if (hasEvidenceAck && !isCompoundDiscoveryQuestion(serverWelcome)) return serverWelcome;

  const fallback =
    turn && typeof turn.clarifyFallbackMessage === "string"
      ? turn.clarifyFallbackMessage.trim()
      : "";
  if (
    isSafeWelcomeText(fallback, turn) &&
    !hasInternalSystemWording(fallback) &&
    !isCompoundDiscoveryQuestion(fallback)
  ) {
    return fallback;
  }

  const assistant =
    turn && typeof turn.assistantMessage === "string" ? turn.assistantMessage.trim() : "";
  if (
    isSafeWelcomeText(assistant, turn) &&
    !hasInternalSystemWording(assistant) &&
    !isCompoundDiscoveryQuestion(assistant)
  ) {
    return assistant;
  }

  return serverWelcome;
}

/**
 * Enforce gates. Returns public-safe turn fields + diagnostics (not for client).
 * Recommend path may expose assistantMessage; clarify path must NOT (openai routes separately).
 */
export function enforceGates(turn, { history, message }) {
  const userTurns = buildUserTurns(history, message);
  const coverageEval = evaluateDialogueReady(turn.briefCoverage, userTurns, evaluateBriefReady);
  // Preserve MVB diagnostics while Gate1 follows dialogue sufficiency.
  coverageEval.mvb = {
    ready: coverageEval.mvbReady,
    missing: coverageEval.mvbMissing
  };
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
    const solutionPrelim = evaluateSolutionReady(coverageEval.coverage, userTurns);
    if (coverageEval.ready && !solutionPrelim.ready) {
      return {
        action: "block_recommend",
        reason: "solution_not_ready",
        missing: [{ key: "solution_discriminator", reason: solutionPrelim.reason || "need_discriminator" }],
        conflicts,
        coverageEval,
        userTurns,
        publicTurn: null
      };
    }
    const planEval = evaluateExpertPlan(
      { ...turn, recommendationMode: "preliminary" },
      coverageEval.coverage,
      userTurns
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
    const solution = evaluateSolutionReady(coverageEval.coverage, userTurns);
    if (!solution.ready) {
      return {
        action: "block_recommend",
        reason: "solution_not_ready",
        missing: [{ key: "solution_discriminator", reason: solution.reason || "need_discriminator" }],
        conflicts,
        coverageEval,
        userTurns,
        publicTurn: null
      };
    }
    const planEval = evaluateExpertPlan(
      { ...turn, recommendationMode: "normal" },
      coverageEval.coverage,
      userTurns
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
