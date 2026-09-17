import { LIMITS } from "./config.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim();
}

/**
 * Validates and normalizes the chat request body.
 * Client-supplied system/developer roles are dropped.
 */
export function validateChatBody(raw) {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "validation_error" };
  }

  const message = cleanText(raw.message);
  if (!message) {
    return { ok: false, error: "validation_error" };
  }
  if (message.length > LIMITS.maxMessageChars) {
    return { ok: false, error: "validation_error" };
  }

  let sessionId = cleanText(raw.sessionId);
  if (sessionId.length > 80) {
    return { ok: false, error: "validation_error" };
  }

  const historyIn = Array.isArray(raw.history) ? raw.history : [];
  if (historyIn.length > LIMITS.maxHistoryItems) {
    return { ok: false, error: "validation_error" };
  }

  const history = [];
  for (let i = 0; i < historyIn.length; i += 1) {
    const item = historyIn[i];
    if (!isPlainObject(item)) {
      return { ok: false, error: "validation_error" };
    }
    const role = item.role;
    if (role !== "user" && role !== "assistant") {
      // Ignore forbidden roles (system/developer/etc.) instead of accepting them.
      continue;
    }
    const content = cleanText(item.content);
    if (!content) continue;
    if (content.length > LIMITS.maxMessageChars) {
      return { ok: false, error: "validation_error" };
    }
    history.push({ role, content });
  }

  return {
    ok: true,
    data: {
      sessionId: sessionId || null,
      message,
      history
    }
  };
}

/** Trim history for model cost control. */
export function trimHistoryForModel(history) {
  const sliced = history.slice(-LIMITS.maxHistoryForModel);
  let total = 0;
  const kept = [];

  for (let i = sliced.length - 1; i >= 0; i -= 1) {
    const item = sliced[i];
    const nextTotal = total + item.content.length;
    if (nextTotal > LIMITS.maxHistoryCharsForModel && kept.length > 0) {
      break;
    }
    kept.unshift(item);
    total = nextTotal;
  }

  return kept;
}
