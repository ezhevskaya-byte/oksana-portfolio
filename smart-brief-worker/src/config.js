/** Configurable limits and defaults for Smart Brief Worker MVP. */

export const DEFAULT_MODEL = "gpt-5.4-mini";

export const LIMITS = {
  /** Max characters in a single user message. */
  maxMessageChars: 4000,
  /** Max history items accepted from client (before trimming for model). */
  maxHistoryItems: 24,
  /** Max history items sent to the model. */
  maxHistoryForModel: 12,
  /** Max characters across history contents sent to the model. */
  maxHistoryCharsForModel: 12000,
  /** Max characters of assistant message returned to client. */
  maxAssistantChars: 4500,
  /** OpenAI max_output_tokens. */
  maxOutputTokens: 900,
  /** Fetch timeout for OpenAI (ms). */
  openaiTimeoutMs: 45000,
  /** Best-effort in-memory rate limit window (ms). */
  rateLimitWindowMs: 60_000,
  /** Best-effort max requests per IP per window (single isolate only). */
  rateLimitMaxPerWindow: 20
};

export const ALLOWED_ORIGINS = [
  "https://ezhevskaya.ru",
  "http://127.0.0.1:5173",
  "http://localhost:5173"
];
