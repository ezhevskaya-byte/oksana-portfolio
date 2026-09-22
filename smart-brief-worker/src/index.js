import { resolveAllowedOrigin, jsonResponse, optionsResponse } from "./cors.js";
import { validateChatBody, trimHistoryForModel } from "./validate.js";
import { checkRateLimit } from "./rateLimit.js";
import { createSmartBriefReply } from "./openai.js";
import { resolveProviderConfig } from "./provider.js";

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

  const providerConfig = resolveProviderConfig(env);
  if (!providerConfig.ok) {
    return errorResponse("unavailable", 503, origin);
  }

  const sessionId = validated.data.sessionId || createSessionId();
  const history = trimHistoryForModel(validated.data.history);

  try {
    const reply = await createSmartBriefReply({
      providerConfig: providerConfig,
      // Legacy fields kept for inject-compatible paths / debugging — not used when providerConfig set.
      apiKey: providerConfig.apiKey,
      model: providerConfig.model,
      history,
      message: validated.data.message,
      briefState: validated.data.briefState
    });

    // Public contract — never leak coverage/plan/gates/provider secrets; briefState is opaque.
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
  } catch (err) {
    const code = err && typeof err.code === "string" ? err.code : "";
    if (code === "provider_timeout") {
      return errorResponse("provider_timeout", 503, origin);
    }
    if (code === "provider_upstream") {
      return errorResponse("provider_upstream", 503, origin);
    }
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
