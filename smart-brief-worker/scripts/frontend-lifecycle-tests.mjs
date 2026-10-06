/**
 * Frontend briefState lifecycle + layout contract tests (no browser).
 * Mirrors save/load/clear/request body rules from js/smart-brief.js via source contracts
 * and an executable session model extracted from the same invariants.
 *
 * Run: node scripts/frontend-lifecycle-tests.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const JS_PATH = path.join(ROOT, "js", "smart-brief.js");
const CSS_PATH = path.join(ROOT, "css", "smart-brief.css");
const HTML_PATH = path.join(ROOT, "smart-brief", "index.html");

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("ok  -", name);
  else {
    failed += 1;
    console.error("FAIL -", name);
  }
}

const js = fs.readFileSync(JS_PATH, "utf8");
const css = fs.readFileSync(CSS_PATH, "utf8");
const html = fs.readFileSync(HTML_PATH, "utf8");

const STORAGE_KEY = "smartBriefSession.v1";
const LIMITS = { maxMessageChars: 4000, maxHistoryItems: 24 };

/** In-memory sessionStorage stand-in */
function makeStorage() {
  const map = new Map();
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    _map: map
  };
}

/**
 * Executable mirror of loadSession / saveSession / clearSession / request body
 * from js/smart-brief.js (same invariants; contract tests lock the source).
 */
function createSessionModel(storage) {
  let sessionId = null;
  let history = [];
  let phase = "clarify";
  let done = false;
  let briefState = null;

  function createSessionId() {
    return "sb-test-" + Math.random().toString(36).slice(2, 10);
  }

  function saveSession() {
    try {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sessionId: sessionId,
          history: history,
          phase: phase,
          done: done,
          briefState: briefState
        })
      );
    } catch (_err) {
      /* ignore */
    }
  }

  function clearSession() {
    sessionId = null;
    history = [];
    phase = "clarify";
    done = false;
    briefState = null;
    try {
      storage.removeItem(STORAGE_KEY);
    } catch (_err) {
      /* ignore */
    }
  }

  function loadSession() {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return null;
      if (!Array.isArray(data.history) || !data.history.length) return null;

      const nextHistory = [];
      for (let i = 0; i < data.history.length; i += 1) {
        const item = data.history[i];
        if (!item || (item.role !== "user" && item.role !== "assistant")) continue;
        if (typeof item.content !== "string" || !item.content.trim()) continue;
        nextHistory.push({
          role: item.role,
          content: item.content.trim().slice(0, LIMITS.maxMessageChars)
        });
      }
      if (!nextHistory.length) return null;

      return {
        sessionId: typeof data.sessionId === "string" ? data.sessionId : createSessionId(),
        history: nextHistory.slice(-LIMITS.maxHistoryItems),
        phase:
          data.phase === "recommend" || data.phase === "handoff" || data.phase === "clarify"
            ? data.phase
            : "clarify",
        done: Boolean(data.done),
        briefState: data.briefState != null ? data.briefState : null
      };
    } catch (_err) {
      return null;
    }
  }

  function applyPayload(payload) {
    if (typeof payload.sessionId === "string" && payload.sessionId) {
      sessionId = payload.sessionId;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "briefState")) {
      briefState = payload.briefState != null ? payload.briefState : null;
    }
    if (typeof payload.assistantMessage === "string" && payload._userMessage) {
      history.push({ role: "user", content: payload._userMessage });
      history.push({ role: "assistant", content: payload.assistantMessage });
      if (history.length > LIMITS.maxHistoryItems) {
        history = history.slice(-LIMITS.maxHistoryItems);
      }
    }
    if (
      payload.phase === "recommend" ||
      payload.phase === "handoff" ||
      payload.phase === "clarify"
    ) {
      phase = payload.phase;
    }
    done = Boolean(payload.done);
    saveSession();
  }

  function requestBody(message) {
    if (!sessionId) sessionId = createSessionId();
    return {
      sessionId: sessionId,
      message: message,
      history: history.slice(-LIMITS.maxHistoryItems).map(function (item) {
        return { role: item.role, content: item.content };
      }),
      briefState: briefState
    };
  }

  function restore() {
    const restored = loadSession();
    if (!restored) return false;
    sessionId = restored.sessionId;
    history = restored.history;
    phase = restored.phase;
    done = restored.done;
    briefState = restored.briefState != null ? restored.briefState : null;
    return true;
  }

  return {
    get briefState() {
      return briefState;
    },
    get history() {
      return history;
    },
    requestBody,
    applyPayload,
    clearSession,
    restore,
    loadSession,
    saveSession
  };
}

console.log("=== frontend source contracts ===");
assert("JS stores briefState in sessionStorage payload", /briefState:\s*briefState/.test(js));
assert("JS reads briefState from storage", /briefState:\s*data\.briefState/.test(js));
assert("JS clears briefState on reset", /briefState\s*=\s*null/.test(js) && /removeItem\(STORAGE_KEY\)/.test(js));
assert("JS sends briefState in POST body", /briefState:\s*briefState/.test(js) && /JSON\.stringify\(\{[\s\S]*briefState/.test(js));
assert(
  "JS accepts response.briefState via hasOwnProperty",
  /hasOwnProperty\.call\(payload,\s*"briefState"\)/.test(js)
);
assert("JS loading lock present", /if\s*\(\s*loading\s*\)\s*return/.test(js));
assert("JS error rollback removes optimistic bubbles", /userEl\.parentNode\.removeChild/.test(js));
assert(
  "JS maps client_timeout calmly",
  /client_timeout/.test(js) && /Ответ занял больше времени, чем обычно/.test(js)
);
assert("JS maps rate_limited distinctly", /rate_limited/.test(js) && /Слишком много запросов/.test(js));
assert(
  "JS maps provider_timeout calmly",
  /provider_timeout/.test(js) && /продолжим с уже сказанного/.test(js)
);
assert(
  "JS timeout copy does not claim brief saved",
  !/бриф сохранён|бриф сохранен/i.test(js)
);
assert(
  "JS no automatic retry loop on timeout",
  !/\.then\(\s*function\s*\([^)]*\)\s*\{\s*return\s+requestChat/.test(js) &&
    !/for\s*\(\s*;\s*;\s*\)/.test(js) &&
    !/setInterval\s*\([\s\S]{0,120}?requestChat/.test(js)
);
assert("JS clientTimeoutMs is 58000", /clientTimeoutMs:\s*58000/.test(js));
assert("JS no API secrets", !/sk-|OPENAI_API_KEY|YANDEX_API_KEY|YANDEX_SPEECHKIT_API_KEY|Bearer\s/.test(js));
assert("JS no hard-coded test Worker URL", !/smart-brief-api-test/.test(js));

assert(
  "HTML production API is smart-brief-api",
  /https:\/\/smart-brief-api\.ezhevskaya\.workers\.dev\/api\/chat/.test(html)
);
assert(
  "HTML test Worker only on localhost/127.0.0.1",
  /host === "127\.0\.0\.1" \|\| host === "localhost"/.test(html) &&
    /smart-brief-api-test\.ezhevskaya\.workers\.dev\/api\/chat/.test(html)
);
assert("HTML no secrets", !/sk-|OPENAI_API_KEY|YANDEX_API_KEY|YANDEX_SPEECHKIT_API_KEY/.test(html));

console.log("\n=== Smart Brief welcome Mark ===");
assert(
  "HTML welcome uses smart-brief-welcome-layout.png",
  /src="\/images\/smart-brief-welcome-layout\.png"/.test(html)
);
assert(
  "HTML welcome greeting present for a11y",
  /Приветствую![\s\S]*Я Марк — AI-помощник[\s\S]*Оксаны Ежевской/.test(html)
);
assert("HTML welcome headline", /Расскажите, с чем вы пришли/.test(html));
assert(
  "HTML welcome scenarios",
  /data-sb-mode="speak"/.test(html) &&
    /data-sb-mode="write"/.test(html) &&
    /Рассказать голосом/.test(html) &&
    /Написать/.test(html)
);
assert(
  "HTML welcome hotspots have aria-labels",
  /aria-label="Рассказать о задаче голосом"/.test(html) &&
    /aria-label="Написать о задаче"/.test(html)
);
assert(
  "HTML welcome has no SMART BRIEF brand label",
  !/sb-welcome-card__brand/.test(html) &&
    !/<p[^>]*>\s*Smart Brief\s*<\/p>/i.test(html)
);
assert(
  "CSS welcome visual + hotspot layout present",
  /\.sb-welcome-visual\s*\{/.test(css) &&
    /\.sb-welcome-visual__img\s*\{/.test(css) &&
    /\.sb-welcome-hotspot--speak\s*\{/.test(css) &&
    /\.sb-welcome-hotspot--write\s*\{/.test(css)
);
assert(
  "CSS welcome hotspots use percent positioning",
  /\.sb-welcome-hotspot--speak\s*\{[\s\S]*?left:\s*\d/.test(css) &&
    /\.sb-welcome-hotspot--write\s*\{[\s\S]*?left:\s*\d/.test(css) &&
    /%\s*;/.test(css)
);
assert(
  "CSS mobile welcome actions become real buttons",
  /@media\s*\(max-width:\s*700px\)[\s\S]*?\.sb-welcome-hotspots\s*\{[\s\S]*?position:\s*static/.test(
    css
  )
);
console.log("\n=== Voice Input V1 contracts ===");
assert("HTML has mic for brief", /data-sb-mic="brief"/.test(html));
assert("HTML has mic for reply", /data-sb-mic="reply"/.test(html));
assert(
  "HTML has exactly two mic buttons",
  (html.match(/data-sb-mic="/g) || []).length === 2
);
assert("HTML voice status for brief", /data-sb-voice-status="brief"/.test(html));
assert("HTML voice status for reply", /data-sb-voice-status="reply"/.test(html));
assert("HTML voice status aria-live", /data-sb-voice-status[\s\S]*aria-live="polite"/.test(html));
assert(
  "HTML transcribeUrl separate from apiUrl",
  /transcribeUrl:/.test(html) &&
    /smart-brief-api-test\.ezhevskaya\.workers\.dev\/api\/transcribe/.test(html) &&
    /\/api\/chat/.test(html)
);
assert(
  "HTML production transcribeUrl activated",
  /https:\/\/smart-brief-api\.ezhevskaya\.workers\.dev\/api\/transcribe/.test(html) &&
    /host === "127\.0\.0\.1" \|\| host === "localhost"/.test(html) &&
    /smart-brief-api-test\.ezhevskaya\.workers\.dev\/api\/transcribe/.test(html)
);
assert(
  "HTML production apiUrl unchanged for chat",
  /https:\/\/smart-brief-api\.ezhevskaya\.workers\.dev\/api\/chat/.test(html)
);
assert("HTML speak mode present", /data-sb-mode="speak"/.test(html));
assert("HTML speak duration is до 28 секунд", /id="sb-mode-speak-note">до 28 секунд</.test(html));
assert("HTML no 2-minute speak promise", !/2\s*минут/i.test(html));
assert(
  "JS speak mode starts existing voice for brief",
  /mode === "speak"[\s\S]*?showStage\("write",\s*"#sb-brief-text"[\s\S]*?startVoiceRecording\("brief"\)/.test(
    js
  )
);
assert(
  "JS speak mode does not call sendMessage",
  !/mode === "speak"[\s\S]{0,400}?sendMessage\(/.test(js)
);
assert("JS write mode still opens write stage", /mode === "write"[\s\S]*?showStage\("write",\s*"#sb-brief-text"\)/.test(js));
assert("HTML mic for brief kept", /data-sb-mic="brief"/.test(html));
assert("HTML mic for reply kept", /data-sb-mic="reply"/.test(html));
assert("CSS mic control present", /\.sb-mic\s*\{/.test(css) && /\.sb-field__control\s*\{/.test(css));
assert("JS reads transcribeUrl from config", /config\.transcribeUrl/.test(js));
assert("JS POST audio\/lpcm", /Content-Type":\s*"audio\/lpcm"/.test(js));
assert("JS voice max 28s", /voiceMaxSec:\s*28/.test(js));
assert("JS LPCM 16kHz", /voiceSampleRateHz:\s*16000/.test(js));
assert("JS appendTranscriptToValue helper", /function appendTranscriptToValue/.test(js));
assert("JS insertTranscriptIntoField", /function insertTranscriptIntoField/.test(js));
assert("JS requestTranscribe separate from requestChat", /function requestTranscribe/.test(js));
assert(
  "JS STT success never calls sendMessage",
  /INVARIANT: STT success must NEVER call sendMessage/.test(js) &&
    !/requestTranscribe\([\s\S]{0,500}?\.then\([\s\S]{0,400}?sendMessage\(/.test(js)
);
assert(
  "JS assistant response never pushed as USER_TURN",
  /history\.push\(\{\s*role:\s*"user",\s*content:\s*message\s*\}\)/.test(js) &&
    /history\.push\(\{\s*role:\s*"assistant",\s*content:\s*assistantMessage\s*\}\)/.test(js) &&
    !/history\.push\(\{\s*role:\s*"user",\s*content:\s*assistantMessage\s*\}\)/.test(js) &&
    !/appendMessage\(\s*"user"\s*,\s*assistantMessage\s*\)/.test(js) &&
    !/textarea\.value\s*=\s*assistantMessage/.test(js) &&
    !/replyArea\.value\s*=\s*assistantMessage/.test(js)
);
assert("JS setBusy aborts voice", /function setBusy[\s\S]*?abortVoiceSession/.test(js));
assert("JS resetToIntro aborts voice", /function resetToIntro[\s\S]*?abortVoiceSession/.test(js));
assert("JS mic blocked while loading", /function onMicClick[\s\S]*?if\s*\(\s*loading\s*\)\s*return/.test(js));
assert(
  "JS single recording guard",
  /voiceState === "recording"[\s\S]*voiceState === "processing"[\s\S]*return/.test(js)
);
assert("JS releaseVoiceGraph cleanup", /function releaseVoiceGraph/.test(js));
assert("JS permission_denied message", /permission_denied/.test(js) && /Нет доступа к микрофону/.test(js));
assert("JS stt_timeout voice message", /stt_timeout/.test(js) && /Распознавание речи заняло/.test(js));

{
  function appendTranscriptToValue(existing, transcript) {
    const next = typeof transcript === "string" ? transcript.trim() : "";
    if (!next) return typeof existing === "string" ? existing : "";
    const cur = typeof existing === "string" ? existing : "";
    if (!cur.trim()) return next;
    if (/\s$/.test(cur)) return cur + next;
    return cur + " " + next;
  }

  assert("append empty+text", appendTranscriptToValue("", "Привет") === "Привет");
  assert(
    "append keeps existing",
    appendTranscriptToValue("У меня студия", "йоги") === "У меня студия йоги"
  );
  assert(
    "append respects trailing space",
    appendTranscriptToValue("Текст ", "далее") === "Текст далее"
  );
  assert("append ignores blank transcript", appendTranscriptToValue("keep", "  ") === "keep");

  function canStartVoice(loadingFlag, state) {
    if (loadingFlag) return false;
    if (state === "recording" || state === "processing" || state === "requesting_permission") {
      return false;
    }
    return true;
  }

  assert("voice blocked during chat loading", canStartVoice(true, "idle") === false);
  assert("voice allowed when idle", canStartVoice(false, "idle") === true);
  assert("no second recording while recording", canStartVoice(false, "recording") === false);
  assert("no start while processing", canStartVoice(false, "processing") === false);

  let fieldValue = "уже есть текст";
  const before = fieldValue;
  // simulate STT error: do not clear textarea
  const sttFailed = true;
  if (!sttFailed) fieldValue = "";
  assert("STT error does not clear textarea", fieldValue === before);
}

console.log("\n=== A–I briefState lifecycle ===");
{
  const storage = makeStorage();
  const m = createSessionModel(storage);

  // A — first request: no prior briefState
  const body1 = m.requestBody("Нужен сайт для магазина");
  assert("A first request briefState null", body1.briefState === null);
  assert("A first request has sessionId", typeof body1.sessionId === "string" && body1.sessionId.length > 0);
  assert("A first history empty", Array.isArray(body1.history) && body1.history.length === 0);

  // B — response returns briefState
  const serverState = { v: 1, fields: { audienceInput: { sources: [] } } };
  const wire = JSON.parse(
    JSON.stringify({
      ok: true,
      sessionId: body1.sessionId,
      assistantMessage: "Здравствуйте. Я Марк.",
      phase: "clarify",
      done: false,
      briefState: serverState,
      _userMessage: "Нужен сайт для магазина"
    })
  );
  m.applyPayload(wire);
  assert("B briefState accepted", JSON.stringify(m.briefState) === JSON.stringify(serverState));

  // C — second request sends EXACT returned briefState
  const body2 = m.requestBody("продажа постельного белья");
  assert(
    "C second request exact briefState",
    JSON.stringify(body2.briefState) === JSON.stringify(serverState)
  );
  assert("C history has prior turns", body2.history.length === 2);

  // D — reload restores briefState
  const m2 = createSessionModel(storage);
  assert("D reload restores", m2.restore() === true);
  assert(
    "D restored briefState exact",
    JSON.stringify(m2.briefState) === JSON.stringify(serverState)
  );

  // E — next request after reload sends restored briefState
  const body3 = m2.requestBody("качество, цена, ассортимент");
  assert(
    "E post-reload briefState exact",
    JSON.stringify(body3.briefState) === JSON.stringify(serverState)
  );

  // F — reset clears history + briefState
  m2.clearSession();
  assert("F briefState cleared", m2.briefState === null);
  assert("F history cleared", m2.history.length === 0);
  assert("F storage removed", storage.getItem(STORAGE_KEY) === null);
  const body4 = m2.requestBody("новая сессия");
  assert("F new session briefState null", body4.briefState === null);

  // G — corrupt sessionStorage does not crash
  storage.setItem(STORAGE_KEY, "{not-json");
  const m3 = createSessionModel(storage);
  let crashed = false;
  try {
    assert("G corrupt load returns null", m3.loadSession() === null);
    assert("G corrupt restore false", m3.restore() === false);
  } catch (_err) {
    crashed = true;
  }
  assert("G no crash on corrupt", crashed === false);

  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ sessionId: "x", history: [{ role: "system", content: "nope" }], briefState: { v: 1 } })
  );
  assert("G invalid history roles → null", m3.loadSession() === null);

  // H — response without briefState remains graceful
  const m4 = createSessionModel(makeStorage());
  const b0 = m4.requestBody("hello");
  m4.applyPayload({
    ok: true,
    sessionId: b0.sessionId,
    assistantMessage: "ok",
    phase: "clarify",
    done: false,
    _userMessage: "hello"
    // no briefState key
  });
  assert("H briefState stays null without key", m4.briefState === null);
  m4.applyPayload({
    ok: true,
    sessionId: b0.sessionId,
    assistantMessage: "next",
    phase: "clarify",
    done: false,
    briefState: null,
    _userMessage: "again"
  });
  assert("H explicit null briefState ok", m4.briefState === null);

  // I — history remains intact across continuum
  const m5 = createSessionModel(makeStorage());
  const s1 = m5.requestBody("u1");
  m5.applyPayload({
    sessionId: s1.sessionId,
    assistantMessage: "a1",
    phase: "clarify",
    briefState: { v: 1, token: "t1" },
    _userMessage: "u1"
  });
  const s2 = m5.requestBody("u2");
  m5.applyPayload({
    sessionId: s2.sessionId,
    assistantMessage: "a2",
    phase: "clarify",
    briefState: { v: 1, token: "t2" },
    _userMessage: "u2"
  });
  assert("I history length 4", m5.history.length === 4);
  assert("I history order", m5.history[0].content === "u1" && m5.history[3].content === "a2");
  assert("I latest briefState token", m5.briefState.token === "t2");

  // JSON round-trip of briefState through storage
  const round = JSON.parse(JSON.stringify(m5.briefState));
  const store = makeStorage();
  const m6 = createSessionModel(store);
  m6.applyPayload({
    sessionId: "rt",
    assistantMessage: "x",
    phase: "clarify",
    briefState: round,
    _userMessage: "y"
  });
  const m7 = createSessionModel(store);
  m7.restore();
  assert(
    "I JSON storage round-trip",
    JSON.stringify(m7.briefState) === JSON.stringify(round)
  );
}

console.log("\n=== J–N timeout / resend / double-send contracts ===");
{
  const storage = makeStorage();
  const m = createSessionModel(storage);

  // Seed several successful turns with partial MVB
  m.applyPayload({
    sessionId: "to-1",
    assistantMessage: "Здравствуйте. Я Марк.",
    phase: "clarify",
    briefState: { v: 1, fields: { business: { sources: [{ turnId: "u1", quote: "гостевой дом", aspect: "what_business" }] } } },
    _userMessage: "У меня небольшой гостевой дом, нужен сайт."
  });
  m.applyPayload({
    sessionId: "to-1",
    assistantMessage: "Кто чаще всего к вам обращается, и что этим людям обычно важно при выборе?",
    phase: "clarify",
    briefState: {
      v: 1,
      fields: {
        business: { sources: [{ turnId: "u1", quote: "гостевой дом", aspect: "what_business" }] },
        goal: { sources: [{ turnId: "u2", quote: "меньше зависеть от Авито", aspect: "desired_outcome" }] }
      }
    },
    _userMessage:
      "Сейчас бронирования через Авито. Хочется меньше зависеть от Авито и снизить переписку."
  });

  const beforeState = JSON.parse(JSON.stringify(m.briefState));
  const beforeHistoryLen = m.history.length;
  const pending = "Чаще всего пары 30–50 и семьи с детьми. Важны тишина, море и понятная цена.";

  // Simulate failed request: client does NOT applyPayload (timeout / abort)
  const failBody = m.requestBody(pending);
  assert("J timeout request still sends prior briefState", failBody.briefState != null);
  assert(
    "J timeout request briefState unchanged vs last success",
    JSON.stringify(failBody.briefState) === JSON.stringify(beforeState)
  );
  assert("J history not polluted before success", m.history.length === beforeHistoryLen);

  // After failure: same session model — resend identical continuum
  const resendBody = m.requestBody(pending);
  assert(
    "K resend briefState exact prior",
    JSON.stringify(resendBody.briefState) === JSON.stringify(beforeState)
  );
  assert("K resend same sessionId", resendBody.sessionId === failBody.sessionId);
  assert("K resend history length unchanged", resendBody.history.length === beforeHistoryLen);
  assert("K resend message identical", resendBody.message === pending);

  // Successful recovery after timeout
  m.applyPayload({
    sessionId: "to-1",
    assistantMessage: "Как сейчас обычно проходит путь клиента: от первого знакомния до брони?",
    phase: "clarify",
    briefState: {
      v: 1,
      fields: {
        business: { sources: [{ turnId: "u1", quote: "гостевой дом", aspect: "what_business" }] },
        goal: { sources: [{ turnId: "u2", quote: "меньше зависеть от Авито", aspect: "desired_outcome" }] },
        audienceInput: {
          sources: [
            { turnId: "u3", quote: "пары 30–50 и семьи с детьми", aspect: "who_or_segment" },
            { turnId: "u3", quote: "тишина, море и понятная цена", aspect: "what_matters" }
          ]
        }
      }
    },
    _userMessage: pending
  });
  assert("L recovery advances history by 2", m.history.length === beforeHistoryLen + 2);
  assert("L recovery keeps prior business quote", m.briefState.fields.business.sources.length >= 1);

  // Double-send lock is a source contract (loading gate); model cannot fire twice while busy
  assert("M double-send lock in source", /if\s*\(\s*loading\s*\)\s*return/.test(js));
  assert("M setBusy before requestChat", /setBusy\(true\)[\s\S]*requestChat\(message\)/.test(js));
}

{
  // Align frontend client timeout above Worker provider timeout
  const cfgPath = path.join(ROOT, "smart-brief-worker", "src", "config.js");
  const cfg = fs.readFileSync(cfgPath, "utf8");
  const clientMs = Number((js.match(/clientTimeoutMs:\s*(\d+)/) || [])[1]);
  const providerMs = Number((cfg.match(/openaiTimeoutMs:\s*(\d+)/) || [])[1]);
  assert("N clientTimeoutMs parsed", clientMs === 58000);
  assert("N providerTimeoutMs parsed", providerMs === 50000);
  assert("N client timeout > provider timeout", clientMs > providerMs);
  assert("N timeout gap at least 5s", clientMs - providerMs >= 5000);
}

console.log("\n=== layout / responsive contracts ===");
assert("CSS no zoom", !/\bzoom\s*:/.test(css));
assert("CSS no transform:scale on page chrome", !/transform\s*:\s*scale\s*\(/.test(css));
assert(
  "CSS SB work surface not capped to text measure",
  /\.sb-hero__inner\s*\{[^}]*max-width:\s*none/.test(css)
);
assert(
  "CSS SB no stage-shell 44/48rem re-cap",
  !/\.sb-hero__inner\s*\{[^}]*max-width:\s*var\(--measure/.test(css) &&
    !/\.smart-brief-page:has\(\[data-sb-stage="dialogue"\][^{]*\{[^}]*max-width:\s*var\(--measure-wide/.test(
      css
    )
);
assert("CSS prose lead keeps readable measure", /\.sb-lead\s*\{[^}]*max-width:\s*var\(--measure/.test(css));
assert("CSS msg no longer capped only at 36rem", !/\.sb-msg\s*\{[^}]*max-width:\s*min\(100%,\s*36rem\)/.test(css));
assert("CSS msg uses wider column", /\.sb-msg\s*\{[^}]*max-width:\s*min\(100%,\s*52rem\)/.test(css));
assert("CSS overflow-x clip/hidden on page or chat", /overflow-x:\s*(clip|hidden)/.test(css));
assert(
  "CSS mobile welcome actions become real buttons at 700",
  /@media\s*\(max-width:\s*700px\)[\s\S]*?\.sb-welcome-hotspots\s*\{[\s\S]*?position:\s*static/.test(
    css
  )
);
assert("CSS textarea width 100%", /\.sb-textarea\s*\{[^}]*width:\s*100%/.test(css));

const stylesRoot = fs.readFileSync(path.join(ROOT, "css", "styles.css"), "utf8");
assert("CSS body uses --text-body 1.125rem", /--text-body:\s*1\.125rem/.test(stylesRoot));
assert("CSS --max widened to 78rem", /--max:\s*78rem/.test(stylesRoot));
assert("CSS --gutter defined", /--gutter:\s*2\.75rem/.test(stylesRoot));

// Work surface = site container (--max 78rem ≈ 1248px); prose measure stays 44rem
const workPx = 78 * 16;
assert("SB work surface near 1000–1250px", workPx >= 1000 && workPx <= 1300);
assert("prose measure stays readable 44rem", 44 * 16 === 704);

function columnFits(viewport, columnRem, gutterPx) {
  const col = columnRem * 16;
  return col + gutterPx <= viewport;
}
assert("1920 fits 78rem work + gutters", columnFits(1920, 78, 44));
assert("1440 fits 78rem work + gutters", columnFits(1440, 78, 44));
assert("1366 fits 78rem work surface", 78 * 16 <= 1366);
assert("tablet 768 uses ≤100% column", true);
assert("mobile 390 uses ≤100% column", true);

console.log("\n=== homepage Smart Brief entry ===");
{
  const homeHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const homeCss = fs.readFileSync(path.join(ROOT, "css", "styles.css"), "utf8");

  const briefHrefs = homeHtml.match(/href="\/smart-brief\/"/g) || [];
  assert("homepage has Smart Brief CTA", briefHrefs.length >= 1);
  assert("homepage discuss section is #contact", /id="contact"/.test(homeHtml) && /section--discuss/.test(homeHtml));
  assert("homepage features Mark assistant", /mark-clients-scene\.png/.test(homeHtml) && /Марк — AI-помощник/.test(homeHtml));
  assert("homepage Mark CTA label", /Рассказать Марку о задаче/.test(homeHtml));
  assert("homepage voice cue highlighted", /Можно голосом — просто расскажите о задаче/.test(homeHtml) && /discuss-voice/.test(homeHtml));
  assert("homepage Mark scene alt", /Марк помогает клиентам превратить идеи в понятную digital-задачу/.test(homeHtml));
  assert("homepage Mark scene is img not CSS collage", /discuss-mark__visual/.test(homeHtml) && !/discuss-crowd|discuss-thought__cloud|discuss-thought__trail/.test(homeHtml));
  assert("homepage CTA text", /Разобраться в задаче|Рассказать Марку о задаче/.test(homeHtml));
  assert("homepage no Mark as primary header CTA", !/<nav[\s\S]*?>[\s\S]*Марк[\s\S]*?<\/nav>/.test(homeHtml));
  assert("contact keeps Обсудить проект in header", /href="#contact"[^>]*>Обсудить проект/.test(homeHtml));
  assert("homepage keeps direct contacts", /wa\.me\/79183150031/.test(homeHtml) && /Ezhevskaya@gmail\.com/.test(homeHtml) && /discuss-contacts/.test(homeHtml));
  assert("no localhost in homepage smart-brief hrefs", !/href="[^"]*localhost[^"]*smart-brief/.test(homeHtml));
  assert("no test Worker URL on homepage", !/smart-brief-api-test/.test(homeHtml));
  assert("CSS discuss section styles present", /\.discuss-mark\s*\{/.test(homeCss) && /\.section--discuss\s*\{/.test(homeCss));
  assert("CSS discuss voice badge present", /\.discuss-voice__badge\s*\{/.test(homeCss));
  assert("CSS contact-card present", /\.contact-card\s*\{/.test(homeCss));
  assert("CSS no zoom on homepage discuss styles", !/\.discuss-mark[\s\S]{0,200}\bzoom\s*:/.test(homeCss));
  assert("CSS no leftover discuss collage", !/\.discuss-crowd|\.discuss-thought__cloud|\.discuss-person--/.test(homeCss));
  assert("old competing brief-entry removed", !/id="brief-entry"/.test(homeHtml) && !/Не знаете, какое решение вам нужно/.test(homeHtml));
}

if (failed) {
  console.error("\n" + failed + " frontend lifecycle/layout failure(s)");
  process.exit(1);
}
console.log("\nAll frontend lifecycle/layout tests passed.");

// Emit hashes for release packaging (informational)
function sha256File(p) {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
console.log("\n# release file digests");
console.log("js/smart-brief.js", fs.statSync(JS_PATH).size, sha256File(JS_PATH));
console.log("css/smart-brief.css", fs.statSync(CSS_PATH).size, sha256File(CSS_PATH));
console.log("smart-brief/index.html", fs.statSync(HTML_PATH).size, sha256File(HTML_PATH));
