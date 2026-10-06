/**
 * LIVE retest — HTTP via PowerShell Invoke-WebRequest (stable vs Node undici ECONNRESET).
 */
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API =
  process.env.SMOKE_API_URL ||
  "https://smart-brief-api-test.ezhevskaya.workers.dev/api/chat";
const ORIGIN = process.env.SMOKE_ORIGIN || "https://ezhevskaya.ru";
const TMP = join(__dirname, "_live8-tmp");
if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
const SCENARIOS = JSON.parse(
  readFileSync(join(__dirname, "_live-retest-8-scenarios.json"), "utf8")
);

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

function chat(sessionId, message, history, briefState) {
  const bodyPath = join(TMP, "req-" + Date.now() + ".json");
  const outPath = join(TMP, "res-" + Date.now() + ".json");
  const psPath = join(TMP, "chat.ps1");
  writeFileSync(
    bodyPath,
    JSON.stringify({ sessionId, message, history, briefState }),
    "utf8"
  );
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "$utf8 = New-Object System.Text.UTF8Encoding $false",
    "$body = Get-Content -LiteralPath '" + bodyPath.replace(/'/g, "''") + "' -Raw -Encoding UTF8",
    "$bytes = $utf8.GetBytes($body)",
    "for ($i=1; $i -le 6; $i++) {",
    "  try {",
    "    $r = Invoke-WebRequest -Uri '" +
      API +
      "' -Method POST -ContentType 'application/json; charset=utf-8' -Headers @{Origin='" +
      ORIGIN +
      "'} -Body $bytes -TimeoutSec 120",
    "    $text = $utf8.GetString($r.RawContentStream.ToArray())",
    "    if ([string]::IsNullOrWhiteSpace($text)) { $text = $r.Content }",
    "    Set-Content -LiteralPath '" +
      outPath.replace(/'/g, "''") +
      "' -Value $text -Encoding UTF8",
    "    exit 0",
    "  } catch {",
    "    Start-Sleep -Seconds (2*$i)",
    "  }",
    "}",
    "Set-Content -LiteralPath '" +
      outPath.replace(/'/g, "''") +
      "' -Value '{\"ok\":false,\"error\":\"fetch_failed\"}' -Encoding UTF8",
    "exit 1"
  ].join("\r\n");
  writeFileSync(psPath, ps, "utf8");

  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 180000 }
    );
  } catch (err) {
    // still try to read outPath
  }

  let payload = { ok: false, error: "fetch_failed" };
  try {
    payload = JSON.parse(readFileSync(outPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (_e) {}
  try {
    unlinkSync(bodyPath);
  } catch (_e) {}
  try {
    unlinkSync(outPath);
  } catch (_e) {}
  try {
    unlinkSync(psPath);
  } catch (_e) {}
  return { status: payload && payload.assistantMessage ? 200 : 0, payload };
}

function answerFor(markText, bank, used) {
  const t = String(markText || "").toLowerCase();
  let key = "default";
  if (/чем\s+именно|о\s+вашем\s+бизнесе|что\s+предлагаете|какой\s+у\s+вас\s+бизнес/.test(t))
    key = "business";
  else if (/какого\s+результата|что\s+должно\s+измениться|какую\s+задач/.test(t)) key = "goal";
  else if (/кто\s+(?:чаще|обычно)|основные\s+(?:клиент|покупател|ученик|гост)|останавливается|покупает/.test(t))
    key = "who";
  else if (/важнее\s+всего|что\s+для\s+(?:этих|них|гостей|клиентов)|при\s+выборе|обращают\s+внимание|что\s+важно/.test(t))
    key = "matters";
  else if (/следующий\s+шаг|как\s+обычно\s+проходит|путь\s+клиента|что\s+происходит\s+дальше|как\s+доходит/.test(t))
    key = "journey";
  else if (/теряется\s+время|где\s+сейчас\s+больше/.test(t)) key = "friction";
  else if (/помимо|инструмент|таблиц|crm|календар|ведёте|пользуетесь/.test(t)) key = "tools";
  else if (/как\s+бы\s+вы\s+хотели|в\s+идеале|идеальный\s+первый/.test(t)) key = "flow";
  else if (/оплат|предоплат|стабильн|расписан|преподавател|мест\s|одинаков|предварительн|собрать\s+обращение/.test(t))
    key = "disc";

  const pool = [].concat(bank[key] || [], bank.disc || [], bank.default || []);
  for (let i = 0; i < pool.length; i += 1) {
    const a = pool[i];
    if (a && !used[a]) {
      used[a] = true;
      return a;
    }
  }
  return "Могу уточнить: почти всё вручную, хочу спокойнее принимать обращения.";
}

async function runScenario(scenario) {
  const sid = "live8-" + scenario.id + "-" + Date.now();
  const transcript = [];
  const used = Object.create(null);
  let history = [];
  let briefState = null;
  let message = scenario.open;
  let recommend = null;
  const markQs = [];

  for (let turn = 0; turn < 14; turn += 1) {
    if (turn > 0) await sleep(900);
    const r = chat(sid, message, history, briefState);
    const p = r.payload || {};
    const mark = String(p.assistantMessage || "");
    const phase = p.phase || "";
    transcript.push({ role: "user", text: message });
    transcript.push({
      role: "mark",
      text: mark,
      phase: phase,
      http: r.status,
      ok: p.ok !== false && Boolean(mark)
    });

    if (!mark || p.ok === false) {
      return {
        id: scenario.id,
        domain: scenario.domain,
        transcript,
        ended: "error",
        error: p.error || p.message || "empty"
      };
    }

    history = history.concat([
      { role: "user", content: message },
      { role: "assistant", content: mark }
    ]);
    if (p.briefState) briefState = p.briefState;

    if (phase === "recommend" || phase === "handoff") {
      recommend = mark;
      break;
    }
    markQs.push(mark);
    message = answerFor(mark, scenario.answers, used);
  }

  return {
    id: scenario.id,
    domain: scenario.domain,
    transcript,
    recommend,
    markQuestions: markQs,
    ended: recommend ? "recommend" : "no_recommend"
  };
}

function analyze(result) {
  const notes = [];
  let verdict = "PASS";
  const marks = (result.transcript || []).filter(function (t) {
    return t.role === "mark";
  });
  const clarifies = marks.filter(function (t) {
    return t.phase !== "recommend" && t.phase !== "handoff";
  });

  if (result.ended === "error" || result.ended === "crash" || result.ended === "no_recommend") {
    notes.push(result.ended === "no_recommend" ? "no_recommend" : "error:" + (result.error || result.ended));
    verdict = "FAIL";
  }

  if (result.ended === "recommend" && clarifies.length < 4) {
    notes.push("HARD: premature recommend after only " + clarifies.length + " clarify turns");
    verdict = "FAIL";
  }

  const seen = Object.create(null);
  for (let i = 0; i < clarifies.length; i += 1) {
    const q = String(clarifies[i].text || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/^здравствуйте.*?\. /, "")
      .trim();
    if (seen[q]) {
      notes.push("Exact clarify repeat");
      verdict = "FAIL";
    }
    seen[q] = true;
  }

  let mattersAsks = 0;
  let whoAsks = 0;
  let businessAsks = 0;
  for (let i = 0; i < clarifies.length; i += 1) {
    const t = clarifies[i].text;
    if (/важн|при\s+выборе|обращают\s+внимание/i.test(t) && /гост|клиент|ученик|них|этих/i.test(t))
      mattersAsks += 1;
    if (/кто\s+(?:чаще|обычно)|основные\s+(?:клиент|гост|ученик)|останавливается/i.test(t)) whoAsks += 1;
    if (/о\s+вашем\s+бизнесе|чем\s+именно\s+вы\s+занимаетесь|что\s+предлагаете/i.test(t))
      businessAsks += 1;
  }
  if (mattersAsks > 1) {
    notes.push("HARD: what_matters asked " + mattersAsks + " times");
    verdict = "FAIL";
  }
  if (whoAsks > 1) {
    notes.push("HARD: WHO asked " + whoAsks + " times");
    verdict = "FAIL";
  }
  const open = ((result.transcript || [])[0] && result.transcript[0].text) || "";
  if (
    businessAsks > 0 &&
    /консультир|сда[её]|студи|мастерск|репетитор|магазин|апартамент|квартир|гостев|кадров|йог|торт/i.test(open)
  ) {
    notes.push("BUSINESS re-ask after open evidence");
    if (verdict === "PASS") verdict = "SOFT ISSUE";
  }

  const blob = marks
    .map(function (m) {
      return m.text;
    })
    .join("\n");
  if (
    result.domain.indexOf("lodging") === -1 &&
    /(?:^|[^а-яё])гост(?:ь|я|ю|ем|и|ей)\b/i.test(blob) &&
    !/гостев/i.test(blob)
  ) {
    notes.push("Possible guest domain leak");
    if (verdict !== "FAIL") verdict = "SOFT ISSUE";
  }
  if (
    /договор/i.test(blob) &&
    result.domain.indexOf("b2b") === -1 &&
    result.domain.indexOf("professional") === -1 &&
    result.domain.indexOf("B2B") === -1
  ) {
    notes.push("Ungrounded договор in non-B2B");
    if (verdict === "PASS") verdict = "SOFT ISSUE";
  }

  if (result.recommend && /не удалось безопасно/i.test(result.recommend)) {
    notes.push("READY_FALLBACK");
    verdict = "FAIL";
  }

  return { verdict, notes, repeats: [] };
}

const results = [];
for (let i = 0; i < SCENARIOS.length; i += 1) {
  console.error("Running " + SCENARIOS[i].id + " ...");
  try {
    const r = await runScenario(SCENARIOS[i]);
    r.analysis = analyze(r);
    results.push(r);
    console.error("  -> " + r.ended + " / " + r.analysis.verdict);
  } catch (err) {
    results.push({
      id: SCENARIOS[i].id,
      domain: SCENARIOS[i].domain,
      transcript: [],
      ended: "crash",
      error: String(err && err.message || err),
      analysis: { verdict: "FAIL", notes: ["crash"], repeats: [] }
    });
  }
  await sleep(2000);
}

writeFileSync(join(__dirname, "_live-retest-8-out.json"), JSON.stringify(results, null, 2), "utf8");
const summary = results.map(function (r) {
  return {
    id: r.id,
    domain: r.domain,
    ended: r.ended,
    verdict: r.analysis && r.analysis.verdict,
    notes: r.analysis && r.analysis.notes,
    recommendPreview: (r.recommend || "").slice(0, 220)
  };
});
writeFileSync(join(__dirname, "_live-retest-8-summary.json"), JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary, null, 2));
