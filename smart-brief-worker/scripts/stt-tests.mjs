/**
 * SpeechKit STT /api/transcribe unit tests (no real network / no secrets).
 * Run: node scripts/stt-tests.mjs
 */
import {
  resolveSttConfig,
  resolveAudioFormat,
  validateAudioLimits,
  estimateLpcmDurationSec,
  recognizeSpeech,
  STT_RECOGNIZE_URL
} from "../src/stt.js";
import { LIMITS } from "../src/config.js";
import { checkRateLimit, checkSttRateLimit } from "../src/rateLimit.js";
import worker from "../src/index.js";

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("ok  -", name);
  else {
    failed += 1;
    console.error("FAIL -", name);
  }
}

const FAKE_STT_KEY = "yandex-speechkit-test-key-not-real";

function mockReq(method, path, headers, body) {
  const h = headers || {};
  return {
    method,
    url: "https://smart-brief-api-test.ezhevskaya.workers.dev" + path,
    headers: {
      get(name) {
        const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
        return key ? h[key] : null;
      }
    },
    async arrayBuffer() {
      if (body == null) return new ArrayBuffer(0);
      if (body instanceof ArrayBuffer) return body;
      return body;
    },
    async json() {
      return typeof body === "string" ? JSON.parse(body) : body;
    }
  };
}

console.log("=== stt config / format ===");
assert("missing STT key → unavailable config", resolveSttConfig({}).ok === false);
assert(
  "YANDEX_API_KEY alone is not enough for STT",
  resolveSttConfig({ YANDEX_API_KEY: "chat-key-only" }).ok === false
);
assert(
  "YANDEX_SPEECHKIT_API_KEY resolves",
  resolveSttConfig({ YANDEX_SPEECHKIT_API_KEY: FAKE_STT_KEY }).ok === true
);

assert("audio/lpcm ok", resolveAudioFormat("audio/lpcm").ok === true);
assert("audio/lpcm format", resolveAudioFormat("audio/lpcm").format === "lpcm");
assert(
  "audio/lpcm rate 16k",
  resolveAudioFormat("audio/lpcm").sampleRateHertz === 16000
);
assert("audio/ogg → oggopus", resolveAudioFormat("audio/ogg").format === "oggopus");
assert("webm rejected", resolveAudioFormat("audio/webm").ok === false);
assert("json rejected", resolveAudioFormat("application/json").ok === false);

const oneSecLpcm = 16000 * 2;
assert("1s LPCM estimate", Math.abs(estimateLpcmDurationSec(oneSecLpcm, 16000) - 1) < 0.001);
assert(
  "oversize rejected",
  validateAudioLimits(LIMITS.sttMaxUploadBytes + 1, {
    format: "lpcm",
    sampleRateHertz: 16000
  }).error === "validation_error"
);
assert(
  "LPCM >30s → recording_too_long",
  validateAudioLimits(16000 * 2 * 31, {
    format: "lpcm",
    sampleRateHertz: 16000
  }).error === "recording_too_long"
);
assert(
  "valid 1s LPCM ok",
  validateAudioLimits(oneSecLpcm, { format: "lpcm", sampleRateHertz: 16000 }).ok === true
);

console.log("\n=== recognizeSpeech mock ===");
{
  let calls = 0;
  let seenAuth = "";
  let seenUrl = "";
  const cfg = resolveSttConfig({ YANDEX_SPEECHKIT_API_KEY: FAKE_STT_KEY });
  const fmt = resolveAudioFormat("audio/lpcm");
  const out = await recognizeSpeech(cfg, fmt, new ArrayBuffer(oneSecLpcm), {
    fetchImpl: async function (url, init) {
      calls += 1;
      seenUrl = String(url);
      seenAuth = init && init.headers && init.headers.Authorization;
      return {
        ok: true,
        json: async function () {
          return { result: "Здравствуйте. У меня небольшой гостевой дом." };
        }
      };
    }
  });
  assert("recognize single call", calls === 1);
  assert("recognize uses stt host", seenUrl.indexOf(STT_RECOGNIZE_URL) === 0);
  assert("recognize lang ru-RU", /lang=ru-RU/.test(seenUrl));
  assert("recognize format lpcm", /format=lpcm/.test(seenUrl));
  assert("recognize sampleRate", /sampleRateHertz=16000/.test(seenUrl));
  assert("recognize Api-Key auth", seenAuth === "Api-Key " + FAKE_STT_KEY);
  assert("recognize text", out.text.indexOf("гостевой дом") !== -1);
}

{
  const cfg = resolveSttConfig({ YANDEX_SPEECHKIT_API_KEY: FAKE_STT_KEY });
  const fmt = resolveAudioFormat("audio/lpcm");
  let code = "";
  try {
    await recognizeSpeech(cfg, fmt, new ArrayBuffer(oneSecLpcm), {
      fetchImpl: async function () {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
    });
  } catch (err) {
    code = err.code;
  }
  assert("timeout → stt_timeout", code === "stt_timeout");
}

{
  const cfg = resolveSttConfig({ YANDEX_SPEECHKIT_API_KEY: FAKE_STT_KEY });
  const fmt = resolveAudioFormat("audio/lpcm");
  let code = "";
  try {
    await recognizeSpeech(cfg, fmt, new ArrayBuffer(oneSecLpcm), {
      fetchImpl: async function () {
        return {
          ok: false,
          status: 403,
          json: async function () {
            return { error_code: "FORBIDDEN", error_message: "nope" };
          }
        };
      }
    });
  } catch (err) {
    code = err.code;
  }
  assert("403 → stt_upstream", code === "stt_upstream");
}

console.log("\n=== HTTP /api/transcribe ===");
{
  const env = { YANDEX_SPEECHKIT_API_KEY: FAKE_STT_KEY };
  // Monkey-patch global fetch for SpeechKit during handler
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function (url, init) {
    if (String(url).indexOf("stt.api.cloud.yandex.net") !== -1) {
      return {
        ok: true,
        json: async function () {
          return { result: "Нужен сайт для студии." };
        }
      };
    }
    return realFetch(url, init);
  };

  try {
    const res = await worker.fetch(
      mockReq(
        "POST",
        "/api/transcribe",
        {
          Origin: "http://localhost:5173",
          "Content-Type": "audio/lpcm",
          "Content-Length": String(oneSecLpcm),
          "CF-Connecting-IP": "203.0.113.50"
        },
        new ArrayBuffer(oneSecLpcm)
      ),
      env
    );
    const payload = await res.json();
    assert("transcribe http 200", res.status === 200);
    assert("transcribe ok", payload.ok === true);
    assert("transcribe text", /студии/.test(payload.text));
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  const res = await worker.fetch(
    mockReq(
      "POST",
      "/api/transcribe",
      {
        Origin: "http://localhost:5173",
        "Content-Type": "audio/webm",
        "CF-Connecting-IP": "203.0.113.51"
      },
      new ArrayBuffer(100)
    ),
    { YANDEX_SPEECHKIT_API_KEY: FAKE_STT_KEY }
  );
  const payload = await res.json();
  assert("webm → 400 unsupported_audio", res.status === 400 && payload.error === "unsupported_audio");
}

{
  const res = await worker.fetch(
    mockReq(
      "POST",
      "/api/transcribe",
      {
        Origin: "http://localhost:5173",
        "Content-Type": "audio/lpcm",
        "CF-Connecting-IP": "203.0.113.52"
      },
      new ArrayBuffer(100)
    ),
    {}
  );
  const payload = await res.json();
  assert("missing STT secret → unavailable", res.status === 503 && payload.error === "unavailable");
}

console.log("\n=== rate limits isolated ===");
{
  const chatReq = mockReq("POST", "/api/chat", { "CF-Connecting-IP": "198.51.100.9" });
  const sttReq = mockReq("POST", "/api/transcribe", { "CF-Connecting-IP": "198.51.100.9" });
  let sttLimited = false;
  for (let i = 0; i < LIMITS.sttRateLimitMaxPerWindow + 2; i += 1) {
    if (!checkSttRateLimit(sttReq).ok) sttLimited = true;
  }
  assert("STT rate limit trips", sttLimited === true);
  // Chat bucket for same IP should still be independent / not already exhausted by STT
  assert("chat rate limit still ok after STT trip", checkRateLimit(chatReq).ok === true);
}

assert("stt timeout configured 11s", LIMITS.sttTimeoutMs === 11000);
assert("stt max upload 1MB", LIMITS.sttMaxUploadBytes === 1_000_000);
assert("stt rate max 10", LIMITS.sttRateLimitMaxPerWindow === 10);

if (failed) {
  console.error("\n" + failed + " stt test(s) failed");
  process.exit(1);
}
console.log("\nAll STT tests passed.");
