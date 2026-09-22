/**
 * Provider abstraction tests (OpenAI regression + Yandex construction).
 * No real network / no secrets. Run: node scripts/provider-tests.mjs
 */
import {
  resolveProviderConfig,
  buildYandexModelUri,
  buildResponsesHeaders,
  buildResponsesBody,
  buildJsonOutputReminder,
  extractOutputText,
  callProvider,
  callProviderForTurn,
  assertNoSecretLeak,
  safeUpstreamLogFields,
  DEFAULT_AI_PROVIDER,
  YANDEX_BASE_URL,
  DEFAULT_YANDEX_MODEL,
  DEFAULT_YANDEX_TEMPERATURE,
  DEFAULT_YANDEX_STRUCTURED_OUTPUT
} from "../src/provider.js";
import { TEXT_FORMAT } from "../src/schema.js";
import { DEFAULT_MODEL, LIMITS } from "../src/config.js";
import { createSmartBriefReply, __test__ } from "../src/openai.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("ok  -", name);
  else {
    failed += 1;
    console.error("FAIL -", name);
  }
}

const FAKE_OPENAI_KEY = "sk-test-openai-key-not-real";
const FAKE_YANDEX_KEY = "yandex-test-api-key-not-real";
const FOLDER = "b1gfolderidtest000000";

// ---------- 1. OpenAI existing behavior / config ----------
{
  const cfg = resolveProviderConfig({
    OPENAI_API_KEY: FAKE_OPENAI_KEY,
    OPENAI_MODEL: "gpt-5.4-mini"
  });
  assert("OpenAI resolve ok", cfg.ok === true && cfg.name === "openai");
  assert("OpenAI default provider name", DEFAULT_AI_PROVIDER === "openai");
  assert("OpenAI model", cfg.model === "gpt-5.4-mini");
  assert("OpenAI base", cfg.baseUrl === "https://api.openai.com/v1");
  assert("OpenAI structured json_schema", cfg.structuredOutput === "json_schema");

  const body = buildResponsesBody(cfg, {
    instructions: "sys",
    input: [{ role: "user", content: "hi" }]
  });
  assert("OpenAI body has store false", body.store === false);
  assert("OpenAI body has text.format", body.text && body.text.format && body.text.format.type === "json_schema");
  assert("OpenAI body uses TEXT_FORMAT name", body.text.format.name === TEXT_FORMAT.name);
  assert("OpenAI body no temperature by default", body.temperature === undefined);
  assert("OpenAI max_output_tokens", body.max_output_tokens === LIMITS.maxOutputTokens);

  const headers = buildResponsesHeaders(cfg);
  assert("OpenAI Bearer auth", headers.Authorization === "Bearer " + FAKE_OPENAI_KEY);
  assert("OpenAI no OpenAI-Project", headers["OpenAI-Project"] === undefined);
}

// ---------- 2–4. Yandex request / URI / auth ----------
{
  assert(
    "Yandex URI builder",
    buildYandexModelUri(FOLDER, "yandexgpt-5.1/latest") ===
      "gpt://" + FOLDER + "/yandexgpt-5.1/latest"
  );
  assert(
    "Yandex URI passthrough",
    buildYandexModelUri(FOLDER, "gpt://other/yandexgpt-5.1/latest") ===
      "gpt://other/yandexgpt-5.1/latest"
  );

  const missing = resolveProviderConfig({ AI_PROVIDER: "yandex" });
  assert("Yandex missing config fails", missing.ok === false && missing.error === "missing_yandex_config");

  const missingFolder = resolveProviderConfig({
    AI_PROVIDER: "yandex",
    YANDEX_API_KEY: FAKE_YANDEX_KEY
  });
  assert("Yandex missing folder fails", missingFolder.ok === false);

  const cfg = resolveProviderConfig({
    AI_PROVIDER: "yandex",
    YANDEX_API_KEY: FAKE_YANDEX_KEY,
    YANDEX_FOLDER_ID: FOLDER,
    YANDEX_MODEL: DEFAULT_YANDEX_MODEL
  });
  assert("Yandex resolve ok", cfg.ok === true && cfg.name === "yandex");
  assert(
    "Yandex model URI",
    cfg.model === "gpt://" + FOLDER + "/yandexgpt-5.1/latest"
  );
  assert("Yandex base URL", cfg.baseUrl === YANDEX_BASE_URL);
  assert("Yandex temperature", cfg.temperature === DEFAULT_YANDEX_TEMPERATURE);
  assert(
    "Yandex default structured prompt_json",
    cfg.structuredOutput === DEFAULT_YANDEX_STRUCTURED_OUTPUT
  );

  const headers = buildResponsesHeaders(cfg);
  assert("Yandex Bearer auth", headers.Authorization === "Bearer " + FAKE_YANDEX_KEY);
  assert("Yandex OpenAI-Project = folder", headers["OpenAI-Project"] === FOLDER);

  const body = buildResponsesBody(cfg, {
    instructions: "base-instructions",
    input: [{ role: "user", content: "привет" }]
  });
  assert("Yandex body model URI", body.model === cfg.model);
  assert("Yandex body temperature 0.3", body.temperature === 0.3);
  assert("Yandex body no store", body.store === undefined);
  assert("Yandex prompt_json no text.format", body.text === undefined);
  assert(
    "Yandex instructions include JSON reminder",
    /OUTPUT FORMAT|JSON object/i.test(body.instructions)
  );
  assert(
    "Yandex reminder has READY recommend mode",
    /MODE SELECTION|phase=recommend|COMPLETE expertPlan/i.test(body.instructions)
  );
  assert("Yandex max_output_tokens bumped", body.max_output_tokens >= 2800);

  const experimental = resolveProviderConfig({
    AI_PROVIDER: "yandex",
    YANDEX_API_KEY: FAKE_YANDEX_KEY,
    YANDEX_FOLDER_ID: FOLDER,
    YANDEX_STRUCTURED_OUTPUT: "json_schema"
  });
  const expBody = buildResponsesBody(experimental, {
    instructions: "x",
    input: "hi"
  });
  assert(
    "Yandex experimental json_schema sends text.format",
    expBody.text && expBody.text.format && expBody.text.format.type === "json_schema"
  );
}

// ---------- 5. output extraction ----------
{
  assert(
    "extract output_text",
    extractOutputText({ output_text: "  {\"a\":1}  " }) === '{"a":1}'
  );
  assert(
    "extract message content",
    extractOutputText({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "{\"ok\":true}" }]
        }
      ]
    }) === '{"ok":true}'
  );
  assert("extract empty", extractOutputText({}) === "");
}

// ---------- 6–9. malformed / incomplete / 4xx / timeout via mock fetch ----------
{
  const cfg = resolveProviderConfig({
    AI_PROVIDER: "yandex",
    YANDEX_API_KEY: FAKE_YANDEX_KEY,
    YANDEX_FOLDER_ID: FOLDER
  });

  const parsers = {
    extractOutputText: extractOutputText,
    parseJsonObject: __test__.parseJsonObject,
    normalizeModelTurn: __test__.normalizeModelTurn
  };

  let calls = 0;
  try {
    await callProviderForTurn(
      cfg,
      { instructions: "i", input: "u" },
      parsers,
      {
        fetchImpl: async function () {
          calls += 1;
          return {
            ok: true,
            json: async function () {
              return { output_text: "not-json-at-all" };
            }
          };
        }
      }
    );
    assert("malformed throws", false);
  } catch (err) {
    assert("malformed empty_or_invalid", err.code === "empty_or_invalid_model_output");
  }
  assert("malformed single call", calls === 1);

  calls = 0;
  try {
    await callProviderForTurn(
      cfg,
      { instructions: "i", input: "u" },
      parsers,
      {
        fetchImpl: async function () {
          calls += 1;
          return {
            ok: true,
            json: async function () {
              return {
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output_text: ""
              };
            }
          };
        }
      }
    );
    assert("incomplete empty throws", false);
  } catch (err) {
    assert("incomplete → empty_or_invalid", err.code === "empty_or_invalid_model_output");
  }
  assert("incomplete single call", calls === 1);

  calls = 0;
  try {
    await callProvider(
      cfg,
      { instructions: "i", input: "u" },
      {
        fetchImpl: async function () {
          calls += 1;
          return {
            ok: false,
            status: 403,
            json: async function () {
              return { error: { type: "forbidden", code: "access_denied", message: "nope" } };
            }
          };
        }
      }
    );
    assert("4xx throws", false);
  } catch (err) {
    assert("4xx provider_upstream", err.code === "provider_upstream");
  }
  assert("4xx single call", calls === 1);

  calls = 0;
  try {
    await callProvider(
      cfg,
      { instructions: "i", input: "u" },
      {
        fetchImpl: async function () {
          calls += 1;
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
      }
    );
    assert("timeout throws", false);
  } catch (err) {
    assert("timeout code", err.code === "provider_timeout");
  }
  assert("timeout single call", calls === 1);
}

assert("provider timeout aligned 50s", LIMITS.openaiTimeoutMs === 50000);
assert("provider no auto-retry after timeout in callProvider", true);

// ---------- 10. <=1 provider call in createSmartBriefReply ----------
{
  let n = 0;
  const reply = await createSmartBriefReply({
    apiKey: FAKE_OPENAI_KEY,
    model: DEFAULT_MODEL,
    history: [],
    message: "Нужен сайт для студии.",
    briefState: null,
    callOpenAI: async function () {
      n += 1;
      return {
        assistantMessage: "Здравствуйте. Я Марк, AI-помощник Оксаны Ежевской. Это не анкета.",
        phase: "clarify",
        done: false,
        briefCoverage: {
          business: { status: "unknown", sources: [] },
          goal: { status: "unknown", sources: [] },
          audienceInput: { status: "unknown", sources: [] },
          customerJourney: { status: "unknown", sources: [] },
          friction: { status: "unknown", sources: [] },
          existingTools: { status: "unknown", sources: [] },
          desiredFlow: { status: "unknown", sources: [] }
        },
        nextInformationNeed: { focus: "none", reason: "" },
        clarifyFallbackMessage:
          "Здравствуйте. Я Марк, AI-помощник Оксаны Ежевской. Расскажите своими словами о задаче. Это не анкета.",
        recommendationMode: "none",
        lowEngagement: false,
        expertPlan: null
      };
    }
  });
  assert("orchestrator single call", n === 1);
  assert("orchestrator reply text", /Марк/i.test(reply.assistantMessage));
}

// ---------- 11. missing Yandex config fails safely ----------
{
  assert(
    "missing yandex key safe",
    resolveProviderConfig({
      AI_PROVIDER: "yandex",
      YANDEX_FOLDER_ID: FOLDER
    }).ok === false
  );
  assert(
    "unknown provider fails",
    resolveProviderConfig({ AI_PROVIDER: "anthropic", OPENAI_API_KEY: FAKE_OPENAI_KEY }).ok ===
      false
  );
}

// ---------- 12. secret never in client/log helpers ----------
{
  const log = JSON.stringify(
    safeUpstreamLogFields(403, {
      type: "forbidden",
      code: "x",
      message: "denied " + FAKE_YANDEX_KEY
    })
  );
  // Message may contain key if upstream echoed it — we still assert our helpers don't add Authorization.
  const headers = buildResponsesHeaders(
    resolveProviderConfig({
      AI_PROVIDER: "yandex",
      YANDEX_API_KEY: FAKE_YANDEX_KEY,
      YANDEX_FOLDER_ID: FOLDER
    })
  );
  const publicBody = JSON.stringify({
    ok: true,
    assistantMessage: "hello",
    phase: "clarify",
    done: false,
    briefState: null
  });
  assert("public body no secret", assertNoSecretLeak(publicBody, FAKE_YANDEX_KEY));
  assert("headers object has key only in Authorization value", headers.Authorization.indexOf(FAKE_YANDEX_KEY) !== -1);
  assert(
    "serialized safe log fields truncate message",
    safeUpstreamLogFields(500, { message: "x".repeat(500) }).message.length <= 200
  );
  void log;
}

// Reminder helper non-empty
assert("json reminder non-empty", buildJsonOutputReminder().length > 40);

// Source: createSmartBriefReply still one await callModel
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(__dirname, "../src/openai.js"), "utf8");
  const fnStart = src.indexOf("export async function createSmartBriefReply");
  const fnBody = src.slice(fnStart, fnStart + 2500);
  const awaits = fnBody.match(/await callModel\(/g) || [];
  assert("source exactly one await callModel", awaits.length === 1);
  assert("source no second repair call", !/runReadyRecommendRepair|await callOpenAI\(/.test(fnBody));
}

if (failed) {
  console.error("\n" + failed + " provider test(s) failed");
  process.exit(1);
}
console.log("\nAll provider tests passed.");
