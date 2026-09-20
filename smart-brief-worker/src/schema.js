/**
 * OpenAI Responses API structured output schema for Smart Brief ModelTurn.
 * B′: coverage uses grounded sources (turnId + exact quote + aspect hint).
 * Strict JSON Schema subset: additionalProperties false, all props required.
 */

const COVERAGE_STATUS = {
  type: "string",
  enum: ["known", "partial", "unknown"]
};

const SOURCE_ASPECT = {
  type: "string",
  enum: [
    "what_business",
    "desired_outcome",
    "who_or_segment",
    "what_matters",
    "path_steps",
    "pain",
    "tools",
    "ideal_flow"
  ]
};

const coverageSource = {
  type: "object",
  additionalProperties: false,
  properties: {
    turnId: {
      type: "string",
      description: "Server-assigned user turn id from USER_TURNS, e.g. u1."
    },
    quote: {
      type: "string",
      description:
        "Exact contiguous substring copied from that user turn only. No paraphrase, no assistant text."
    },
    aspect: SOURCE_ASPECT,
    operation: {
      type: "string",
      enum: ["support", "replace"],
      description:
        "support = add evidence; replace = supersede older sources for this aspect (corrections). Still requires grounded quote."
    }
  },
  required: ["turnId", "quote", "aspect", "operation"]
};

const coverageField = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: COVERAGE_STATUS,
    sources: {
      type: "array",
      items: coverageSource,
      description:
        "Grounded quotes from USER_TURNS. Empty when unknown. aspect is a hint only — server validates quotes."
    }
  },
  required: ["status", "sources"]
};

const expertPlanObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    realProblem: { type: "string" },
    audienceHypothesis: { type: "string" },
    primarySolution: { type: "string" },
    alternative: {
      type: "string",
      description:
        "Real alternative OR explicit 'none: <why no meaningful alternative>' — never invent a fake option."
    },
    whyPrimary: { type: "string" },
    reuseNote: { type: "string" },
    startNow: { type: "string" },
    addLater: {
      type: "string",
      description: "Next-stage ideas OR 'none' if not needed."
    },
    doNotBuildYet: {
      type: "string",
      description: "What to avoid now OR 'none' if nothing to warn about."
    },
    insight: { type: "string" }
  },
  required: [
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
  ]
};

export const CRITICAL_COVERAGE_KEYS = [
  "business",
  "goal",
  "audienceInput",
  "customerJourney",
  "friction",
  "existingTools",
  "desiredFlow"
];

export const MODEL_TURN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    assistantMessage: {
      type: "string",
      description:
        "Recommend/preliminary prose for the client when gates allow. On clarify turns may mirror clarifyFallbackMessage but server will not send this field if brief is not ready."
    },
    phase: {
      type: "string",
      enum: ["clarify", "recommend", "handoff"]
    },
    done: { type: "boolean" },
    briefCoverage: {
      type: "object",
      additionalProperties: false,
      properties: {
        business: coverageField,
        goal: coverageField,
        audienceInput: coverageField,
        customerJourney: coverageField,
        friction: coverageField,
        existingTools: coverageField,
        desiredFlow: coverageField
      },
      required: CRITICAL_COVERAGE_KEYS
    },
    nextInformationNeed: {
      type: "object",
      additionalProperties: false,
      properties: {
        focus: {
          type: "string",
          enum: [
            "business",
            "goal",
            "audienceInput",
            "customerJourney",
            "friction",
            "existingTools",
            "desiredFlow",
            "none"
          ]
        },
        reason: { type: "string" }
      },
      required: ["focus", "reason"]
    },
    clarifyFallbackMessage: {
      type: "string",
      description:
        "Client-visible clarify text. REQUIRED whenever recommendationMode=none or brief may be blocked. Server sends this (not assistantMessage) when not recommending."
    },
    recommendationMode: {
      type: "string",
      enum: ["none", "normal", "preliminary"]
    },
    lowEngagement: { type: "boolean" },
    expertPlan: {
      type: ["object", "null"],
      properties: expertPlanObject.properties,
      required: expertPlanObject.required,
      additionalProperties: false
    }
  },
  required: [
    "assistantMessage",
    "phase",
    "done",
    "briefCoverage",
    "nextInformationNeed",
    "clarifyFallbackMessage",
    "recommendationMode",
    "lowEngagement",
    "expertPlan"
  ]
};

export const TEXT_FORMAT = {
  type: "json_schema",
  name: "smart_brief_model_turn",
  strict: true,
  schema: MODEL_TURN_SCHEMA
};

/** Approximate serialized schema size for reporting. */
export function schemaCharLength() {
  return JSON.stringify(MODEL_TURN_SCHEMA).length;
}
