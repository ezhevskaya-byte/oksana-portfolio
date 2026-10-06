/**
 * Yandex SpeechKit sync STT for Smart Brief Voice Input V1.
 * Isolated from /api/chat and YandexGPT provider credentials.
 */
import { LIMITS } from "./config.js";

export const STT_RECOGNIZE_URL = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";

function throwCoded(message, code) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve STT credentials. Uses ONLY YANDEX_SPEECHKIT_API_KEY (never YANDEX_API_KEY).
 */
export function resolveSttConfig(env) {
  const source = env && typeof env === "object" ? env : {};
  const apiKey = source.YANDEX_SPEECHKIT_API_KEY;
  if (!nonEmpty(apiKey)) {
    return { ok: false, error: "missing_stt_config" };
  }
  return {
    ok: true,
    apiKey: String(apiKey).trim(),
    timeoutMs: LIMITS.sttTimeoutMs
  };
}

/**
 * Map Content-Type → SpeechKit format query params.
 * V1 preferred: audio/lpcm (16 kHz mono). Optional: audio/ogg (oggopus).
 */
export function resolveAudioFormat(contentTypeHeader) {
  const raw = String(contentTypeHeader || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (raw === "audio/lpcm" || raw === "audio/pcm") {
    return {
      ok: true,
      contentType: raw,
      format: "lpcm",
      sampleRateHertz: LIMITS.sttLpcmSampleRateHz
    };
  }

  if (raw === "audio/ogg" || raw === "application/ogg") {
    return {
      ok: true,
      contentType: raw,
      format: "oggopus",
      sampleRateHertz: null
    };
  }

  if (raw === "application/octet-stream") {
    // Explicit octet-stream treated as LPCM V1 default when no subtype given.
    return {
      ok: true,
      contentType: raw,
      format: "lpcm",
      sampleRateHertz: LIMITS.sttLpcmSampleRateHz
    };
  }

  return { ok: false, error: "unsupported_audio" };
}

/**
 * Estimate LPCM duration (16-bit mono). Returns seconds or null if not LPCM.
 */
export function estimateLpcmDurationSec(byteLength, sampleRateHz) {
  const rate = typeof sampleRateHz === "number" && sampleRateHz > 0 ? sampleRateHz : 0;
  const bytes = typeof byteLength === "number" && byteLength >= 0 ? byteLength : 0;
  if (!rate) return null;
  // 16-bit mono → 2 bytes per sample
  return bytes / (rate * 2);
}

/**
 * Validate upload size / LPCM duration before calling SpeechKit.
 */
export function validateAudioLimits(byteLength, formatInfo) {
  if (typeof byteLength !== "number" || byteLength <= 0) {
    return { ok: false, error: "validation_error" };
  }
  if (byteLength > LIMITS.sttMaxUploadBytes) {
    return { ok: false, error: "validation_error" };
  }
  if (formatInfo && formatInfo.format === "lpcm") {
    const sec = estimateLpcmDurationSec(byteLength, formatInfo.sampleRateHertz);
    if (sec != null && sec > LIMITS.sttMaxDurationSec) {
      return { ok: false, error: "recording_too_long" };
    }
  }
  return { ok: true };
}

function buildRecognizeUrl(formatInfo) {
  const url = new URL(STT_RECOGNIZE_URL);
  url.searchParams.set("lang", "ru-RU");
  url.searchParams.set("format", formatInfo.format);
  if (formatInfo.format === "lpcm" && formatInfo.sampleRateHertz) {
    url.searchParams.set("sampleRateHertz", String(formatInfo.sampleRateHertz));
  }
  return url.toString();
}

/**
 * Call SpeechKit sync recognize. Never logs apiKey or audio bytes.
 */
export async function recognizeSpeech(config, formatInfo, audioBytes, options) {
  if (!config || !config.ok) {
    throwCoded("stt_config_missing", "unavailable");
  }
  if (!formatInfo || !formatInfo.ok) {
    throwCoded("unsupported_audio", "unsupported_audio");
  }

  const fetchImpl =
    options && typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const timeoutMs =
    typeof config.timeoutMs === "number" ? config.timeoutMs : LIMITS.sttTimeoutMs;

  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    try {
      response = await fetchImpl(buildRecognizeUrl(formatInfo), {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: "Api-Key " + config.apiKey,
          "Content-Type": "application/octet-stream"
        },
        body: audioBytes
      });
    } catch (fetchErr) {
      const aborted =
        Boolean(fetchErr) &&
        (fetchErr.name === "AbortError" ||
          fetchErr.code === 20 ||
          /aborted/i.test(String(fetchErr.message || "")));
      console.error("[smart-brief] stt_fetch_failed", {
        aborted: aborted,
        name: fetchErr && fetchErr.name
      });
      throwCoded(
        aborted ? "stt_timeout" : "stt_fetch_failed",
        aborted ? "stt_timeout" : "unavailable"
      );
    }
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_parseErr) {
    payload = null;
  }

  if (!response.ok) {
    const upstreamCode =
      payload && typeof payload.error_code === "string" ? payload.error_code : "";
    console.error("[smart-brief] stt_upstream_error", {
      status: response.status,
      error_code: upstreamCode || null
    });
    if (
      response.status === 400 &&
      /duration|too long|longer/i.test(
        String((payload && payload.error_message) || upstreamCode || "")
      )
    ) {
      throwCoded("recording_too_long", "recording_too_long");
    }
    throwCoded("stt_http_" + response.status, "stt_upstream");
  }

  const text =
    payload && typeof payload.result === "string" ? payload.result.trim() : "";
  if (!text) {
    // Empty recognition is a valid upstream outcome (silence) — surface as empty text ok
    // or validation? Prefer ok with empty string so client can show "не расслышали".
    return { text: "", rawChars: 0 };
  }

  return {
    text: text.slice(0, LIMITS.maxMessageChars),
    rawChars: text.length
  };
}
