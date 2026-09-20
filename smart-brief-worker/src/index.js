import { DEFAULT_MODEL } from "./config.js";
import { resolveAllowedOrigin, jsonResponse, optionsResponse } from "./cors.js";
import { validateChatBody, trimHistoryForModel } from "./validate.js";
import { checkRateLimit } from "./rateLimit.js";
import { createSmartBriefReply } from "./openai.js";

function createSessionId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "sb-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function errorResponse(error, status, origin) {
  return jsonResponse({ ok: false, error }, status, origin);
}

async function handleChat(request, env, origin) {
  const rate = checkRateLimit(request);
  if (!rate.ok) {
    return errorResponse("rate_limited", 429, origin);
  }

  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return errorResponse("validation_error", 400, origin);
  }

  let raw;
  try {
    raw = await request.json();
  } catch (_err) {
    return errorResponse("validation_error", 400, origin);
  }

  // Only message/history/sessionId/briefState envelope are accepted.
  // briefState is opaque and never trusted without re-ground; forged coverage flags are ignored.
  const validated = validateChatBody(raw);
  if (!validated.ok) {
    return errorResponse("validation_error", 400, origin);
  }

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return errorResponse("unavailable", 503, origin);
  }

  const model = (env.OPENAI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const sessionId = validated.data.sessionId || createSessionId();
  const history = trimHistoryForModel(validated.data.history);

  try {
    const reply = await createSmartBriefReply({
      apiKey,
      model,
      history,
      message: validated.data.message,
      briefState: validated.data.briefState
    });

    // Public contract — never leak coverage/plan/gates; briefState is opaque continuum token.
    return jsonResponse(
      {
        ok: true,
        sessionId,
        assistantMessage: reply.assistantMessage,
        phase: reply.phase,
        done: Boolean(reply.done),
        briefState: reply.briefState != null ? reply.briefState : null
      },
      200,
      origin
    );
  } catch (_err) {
    return errorResponse("unavailable", 503, origin);
  }
}

export default {
  async fetch(request, env) {
    const origin = resolveAllowedOrigin(request);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return optionsResponse(origin);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return jsonResponse({ ok: true, service: "smart-brief-api" }, 200, origin);
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      if (!origin && request.headers.get("Origin")) {
        return errorResponse("validation_error", 403, null);
      }
      return handleChat(request, env, origin);
    }

    return errorResponse("validation_error", 404, origin);
  }
};
