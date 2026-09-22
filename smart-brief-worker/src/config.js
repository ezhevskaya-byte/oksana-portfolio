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
  /** Max JSON chars for opaque briefState from client (ignore if larger). */
  maxBriefStateChars: 16000,
  /** Max sources stored per coverage field in briefState. */
  maxSourcesPerField: 8,
  /** OpenAI max_output_tokens (room for coverage sources + expertPlan without truncation). */
  maxOutputTokens: 2200,
  /**
   * Provider fetch timeout (ms). Kept under frontend clientTimeoutMs (~58s) so a slow
   * upstream returns provider_timeout JSON before the browser AbortController fires.
   * Rare ~75s Yandex spikes are intentionally cut — user retries; no automatic retry.
   */
  openaiTimeoutMs: 50000,
  /** Best-effort in-memory rate limit window (ms). */
  rateLimitWindowMs: 60_000,
  /** Best-effort max requests per IP per window (single isolate only). */
  rateLimitMaxPerWindow: 20
};

/** Gate / engagement policy (server-side, not trusted from client). */
export const GATE_POLICY = {
  /** Critical MVB fields that must be known+grounded for normal recommend. */
  criticalFields: [
    "business",
    "goal",
    "audienceInput",
    "customerJourney",
    "friction",
    "existingTools",
    "desiredFlow"
  ],
  /** Minimum exact-quote length (chars) for a source to count. */
  minQuoteChars: 12,
  /**
   * Required aspect hints per field when status=known.
   * Aspect is NOT semantic proof — only a classification hint from the model.
   */
  requiredAspects: {
    business: ["what_business"],
    goal: ["desired_outcome"],
    audienceInput: ["who_or_segment", "what_matters"],
    customerJourney: ["path_steps"],
    friction: ["pain"],
    existingTools: ["tools"],
    desiredFlow: ["ideal_flow"]
  },
  /** Consecutive low-signal user turns required for preliminary bypass. */
  lowEngagementMinStreak: 3,
  /** User message length at/under this may count as low-signal (chars). */
  lowEngagementMaxChars: 40,
  /** Phrases that count as evasive / low engagement (lowercase). */
  lowEngagementPhrases: [
    "не знаю",
    "неважно",
    "как хотите",
    "как считаете",
    "без разницы",
    "не важно",
    "хз",
    "ок",
    "хорошо",
    "да",
    "нет"
  ],
  /** Substrings that mark a preliminary disclaimer in assistantMessage. */
  preliminaryMarkers: [
    "предварительн",
    "ограниченн",
    "пока не хватает",
    "на основе огранич",
    "неполный"
  ]
};

export const ALLOWED_ORIGINS = [
  "https://ezhevskaya.ru",
  "http://127.0.0.1:5173",
  "http://localhost:5173"
];
