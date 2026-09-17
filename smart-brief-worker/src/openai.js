import { DEFAULT_MODEL, LIMITS } from "./config.js";
import { RUNTIME_INSTRUCTIONS } from "./prompt.js";

function extractOutputText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks = [];

  for (let i = 0; i < output.length; i += 1) {
    const item = output[i];
    if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (let j = 0; j < item.content.length; j += 1) {
      const part = item.content[j];
      if (part && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

function parseModelJson(text) {
  if (!text) return null;

  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (_err) {
    return null;
  }
}

function normalizeAssistantPayload(rawText) {
  const parsed = parseModelJson(rawText);
  let assistantMessage = "";
  let phase = "clarify";
  let done = false;

  if (parsed && typeof parsed === "object") {
    assistantMessage =
      typeof parsed.assistantMessage === "string"
        ? parsed.assistantMessage.trim()
        : typeof parsed.message === "string"
          ? parsed.message.trim()
          : "";
    if (parsed.phase === "clarify" || parsed.phase === "recommend" || parsed.phase === "handoff") {
      phase = parsed.phase;
    }
    done = Boolean(parsed.done);
  }

  if (!assistantMessage) {
    assistantMessage = (rawText || "").trim();
    phase = "clarify";
    done = false;
  }

  if (assistantMessage.length > LIMITS.maxAssistantChars) {
    assistantMessage = assistantMessage.slice(0, LIMITS.maxAssistantChars).trim();
  }

  if (phase === "recommend" || phase === "handoff") {
    // Concept turns may complete the clarifying loop.
    if (done !== true && phase === "handoff") done = true;
  }

  return { assistantMessage, phase, done };
}

/**
 * Calls OpenAI Responses API.
 * Model comes from env.OPENAI_MODEL (fallback DEFAULT_MODEL) for easy A/B later.
 */
export async function createSmartBriefReply({ apiKey, model, history, message }) {
  const input = history.concat([{ role: "user", content: message }]).map((item) => ({
    role: item.role,
    content: item.content
  }));

  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, LIMITS.openaiTimeoutMs);

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        instructions: RUNTIME_INSTRUCTIONS,
        input,
        store: false,
        max_output_tokens: LIMITS.maxOutputTokens
      })
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const err = new Error("openai_http_" + response.status);
    err.code = "unavailable";
    throw err;
  }

  const payload = await response.json();
  const rawText = extractOutputText(payload);
  const normalized = normalizeAssistantPayload(rawText);

  if (!normalized.assistantMessage) {
    const err = new Error("empty_model_output");
    err.code = "unavailable";
    throw err;
  }

  return normalized;
}
