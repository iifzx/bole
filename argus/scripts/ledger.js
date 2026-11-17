#!/usr/bin/env node
/**
 * ledger.js — 相马经 (Horse Ledger) maintenance CLI for Argus.
 *
 * Zero-dependency Node.js (>=18). Implements the scoring model documented in
 * ../references/scoring.md exactly; that file is the spec, this is the engine.
 *
 * Commands:
 *   validate-all            validate every record & report, plus derived-field consistency
 *   add <report.json>       merge a field report into its skill record, rebuild index
 *   static <patch.json>     merge a static rubric evaluation {id, static, ...}, rebuild index
 *   build-index [--check]   regenerate data/index.json (--check fails if it would change)
 *   show <id>               print a record
 *   recompute               recompute all records from their reports (self-healing)
 *
 * Exit codes: 0 ok, 1 validation/data error, 2 usage error.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve(__dirname, "..", "data");
const SKILLS_DIR = path.join(DATA_DIR, "skills");
const REPORTS_DIR = path.join(DATA_DIR, "reports");
const INDEX_PATH = path.join(DATA_DIR, "index.json");

const STALE_DAYS = 180;
const DIMENSIONS_STATIC = ["trigger", "structure", "actionability", "safety", "portability"];
const DIMENSIONS_FIELD = ["effectiveness", "efficiency", "reliability"];
const HISTORY_EVENTS = ["seed", "static-eval", "report-added", "recompute", "score-conflict", "score-stale", "hash-pin"];
const SOURCES = ["github", "skills.sh", "skillsmp", "clawhub", "manual", "unknown"];
const VERDICTS = ["worked", "partial", "failed"];
const SEVERITIES = ["info", "low", "medium", "high", "critical"];
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------- helpers --

const round2 = (x) => Math.round(x * 100) / 100;
const pad2 = (n) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const nowStamp = () => {
  const d = new Date();
  return `${today()}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

class Fail extends Error {}

function assert(cond, msg) {
  if (!cond) throw new Fail(msg);
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Fail(`cannot read ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Fail(`${file}: invalid JSON (${e.message})`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

const SEG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
function assertSafeSegment(seg, what) {
  assert(typeof seg === "string" && seg.length > 0, `${what}: empty path segment`);
  assert(seg !== "." && seg !== "..", `${what}: illegal segment "${seg}"`);
  assert(SEG_RE.test(seg), `${what}: segment "${seg}" must match ${SEG_RE}`);
}

function assertSafeId(id, what = "id") {
  assert(typeof id === "string" && id.length > 0, `${what}: required`);
  const segs = id.split("/");
  assert(segs.length >= 2, `${what}: expected <owner>/<repo>/<skill>`);
  for (const s of segs) assertSafeSegment(s, what);
}

function isDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function isStamp(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(s);
}

function isIntInRange(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

function isNumInRange(v, lo, hi) {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
}

function walkJsonFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
  }
  return out;
}

/** id -> path under a data subdirectory (skills/ or reports/), posix-style rel path */
function idPaths(id, sub) {
  const rel = id.split("/").join(path.sep);
  return { abs: path.join(DATA_DIR, sub, rel), relPosix: id };
}

// -------------------------------------------------------------- validators --

function validateReport(rep, where) {
  assertSafeId(rep.id, `${where}: id`);
  assert(isStamp(rep.reported_at), `${where}: reported_at must be YYYY-MM-DDTHH-mm-ss`);
  assert(typeof rep.task === "string" && rep.task.trim().length > 0, `${where}: task required`);
  assert(rep.task.length <= 500, `${where}: task over 500 chars`);
  assert(VERDICTS.includes(rep.verdict), `${where}: verdict must be one of ${VERDICTS.join("|")}`);
  assert(rep.scores && typeof rep.scores === "object", `${where}: scores required`);
  for (const d of DIMENSIONS_FIELD) {
    assert(isIntInRange(rep.scores[d], 1, 5), `${where}: scores.${d} must be an integer 1-5`);
  }
  assert(
    typeof rep.evidence === "string" && rep.evidence.trim().length >= 10,
    `${where}: evidence required (min 10 chars) — vague reports are rejected`
  );
  if (rep.environment !== undefined) {
    assert(rep.environment && typeof rep.environment === "object" && !Array.isArray(rep.environment),
      `${where}: environment must be an object`);
  }
  if (rep.reporter !== undefined) assert(typeof rep.reporter === "string", `${where}: reporter must be a string`);
}

function validateStatic(st, where) {
  assert(st && typeof st === "object", `${where}: static must be an object or null`);
  for (const d of DIMENSIONS_STATIC) {
    assert(isIntInRange(st[d], 1, 5), `${where}: static.${d} must be an integer 1-5`);
  }
  assert(Array.isArray(st.notes), `${where}: static.notes must be an array`);
  assert(Array.isArray(st.safety_flags), `${where}: static.safety_flags must be an array`);
  for (const f of st.safety_flags) {
    assert(f && typeof f === "object" && !Array.isArray(f), `${where}: safety_flags entries must be objects {severity, finding, detail, quote?}`);
    assert(SEVERITIES.includes(f.severity), `${where}: safety_flags.severity must be one of ${SEVERITIES.join("|")}`);
    assert(typeof f.finding === "string" && /^[a-z0-9_-]+$/.test(f.finding), `${where}: safety_flags.finding must be a kebab-case id`);
    assert(typeof f.detail === "string" && f.detail.trim().length > 0, `${where}: safety_flags.detail required`);
    assert(f.quote === undefined || typeof f.quote === "string", `${where}: safety_flags.quote must be a string`);
  }
  assert(typeof st.evaluator === "string" && st.evaluator.length > 0, `${where}: static.evaluator required`);
  assert(isDate(st.evaluated_at), `${where}: static.evaluated_at must be YYYY-MM-DD`);
}

function validateRecord(rec, where) {
  assertSafeId(rec.id, `${where}: id`);
  assert(typeof rec.name === "string" && rec.name.length > 0, `${where}: name required`);
  assert(rec.name === rec.id.split("/").pop(), `${where}: name must equal the last segment of id`);
  assert(SOURCES.includes(rec.source), `${where}: source must be one of ${SOURCES.join("|")}`);
  assert(rec.url === null || rec.url === undefined || typeof rec.url === "string", `${where}: url must be a string or null`);
  assert(rec.description === undefined || typeof rec.description === "string", `${where}: description must be a string`);
  assert(Array.isArray(rec.best_for), `${where}: best_for must be an array`);
  assert(rec.best_for.every((k) => typeof k === "string" && k.length > 0), `${where}: best_for entries must be non-empty strings`);
  assert(rec.best_for.length <= 8, `${where}: best_for holds at most 8 keywords`);

  if (rec.popularity !== undefined && rec.popularity !== null) {
    const p = rec.popularity;
    assert(p && typeof p === "object", `${where}: popularity must be an object`);
    assert(p.stars === null || p.stars === undefined || Number.isInteger(p.stars), `${where}: popularity.stars`);
    assert(p.installs === null || p.installs === undefined || Number.isInteger(p.installs), `${where}: popularity.installs`);
    assert(isDate(p.checked_at), `${where}: popularity.checked_at must be YYYY-MM-DD`);
  }

  if (rec.static !== null) validateStatic(rec.static, where);

  const f = rec.field;
  assert(f && typeof f === "object", `${where}: field required`);
  assert(Number.isInteger(f.n_reports) && f.n_reports >= 0, `${where}: field.n_reports must be an integer >= 0`);
  for (const d of DIMENSIONS_FIELD) {
    const lo = f.n_reports === 0 ? 0 : 1;
    assert(isNumInRange(f[d], lo, 5), `${where}: field.${d} must be a number ${lo}-5`);
  }

  assert(Number.isInteger(rec.final) && rec.final >= 0 && rec.final <= 100, `${where}: final must be an integer 0-100`);
  assert(isNumInRange(rec.confidence, 0, 1), `${where}: confidence must be 0-1`);
  assert(Array.isArray(rec.history), `${where}: history must be an array`);
  for (const h of rec.history) {
    assert(isDate(h.at), `${where}: history.at must be YYYY-MM-DD`);
    assert(HISTORY_EVENTS.includes(h.event), `${where}: history.event must be one of ${HISTORY_EVENTS.join("|")}`);
    assert(Number.isInteger(h.final) && h.final >= 0 && h.final <= 100, `${where}: history.final`);
    assert(isNumInRange(h.confidence, 0, 1), `${where}: history.confidence`);
    assert(Number.isInteger(h.n_reports) && h.n_reports >= 0, `${where}: history.n_reports`);
    assert(h.note === undefined || typeof h.note === "string", `${where}: history.note must be a string`);
  }
  assert(Array.isArray(rec.reports), `${where}: reports must be an array`);
  if (rec.conflict_events !== undefined) {
    assert(Array.isArray(rec.conflict_events), `${where}: conflict_events must be an array`);
    assert(rec.conflict_events.every(isStamp), `${where}: conflict_events entries must be YYYY-MM-DDTHH-mm-ss stamps`);
  }
  if (rec.content_hash !== undefined && rec.content_hash !== null) {
    assert(typeof rec.content_hash === "string" && HASH_RE.test(rec.content_hash), `${where}: content_hash must be "sha256:<64 hex>"`);
    assert(isDate(rec.hash_checked_at), `${where}: hash_checked_at must be YYYY-MM-DD`);
    if (rec.hash_source_url !== undefined) {
      assert(typeof rec.hash_source_url === "string" && /^https:\/\//.test(rec.hash_source_url), `${where}: hash_source_url must be an https URL`);
    }
  }
  if (rec.stale !== undefined) assert(typeof rec.stale === "boolean", `${where}: stale must be a boolean`);
  if (rec.stale_hash !== undefined && rec.stale_hash !== null) {
    assert(typeof rec.stale_hash === "string" && HASH_RE.test(rec.stale_hash), `${where}: stale_hash must be "sha256:<64 hex>"`);
  }
  if (rec.duplicate_of !== undefined && rec.duplicate_of !== null) {
    assertSafeId(rec.duplicate_of, `${where}: duplicate_of`);
    assert(rec.duplicate_of !== rec.id, `${where}: a record cannot be its own duplicate`);
  }
  if (rec.trigger_eval !== undefined) {
    const t = rec.trigger_eval;
    assert(t && typeof t === "object" && !Array.isArray(t), `${where}: trigger_eval must be an object`);
    assert(isNumInRange(t.rate, 0, 1), `${where}: trigger_eval.rate must be 0-1`);
    assert(Number.isInteger(t.n_queries) && t.n_queries > 0, `${where}: trigger_eval.n_queries must be a positive integer`);
    assert(isDate(t.ran_at), `${where}: trigger_eval.ran_at must be YYYY-MM-DD`);
  }
  assert(isDate(rec.updated), `${where}: updated must be YYYY-MM-DD`);
}

// ------------------------------------------------------------- score model --

function mean(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function stddev(nums) {
  const m = mean(nums);
  return Math.sqrt(mean(nums.map((x) => (x - m) * (x - m))));
}

function static100(rec) {
  if (!rec.static) return null;
  return mean(DIMENSIONS_STATIC.map((d) => rec.static[d])) * 20;
}

/** Load every valid report belonging to a record (self-healing: globs the dir). */
function loadReports(rec) {
  const out = [];
  const dir = idPaths(rec.id, "reports").abs;
  for (const file of walkJsonFiles(dir)) {
    const rep = readJson(file);
    const where = path.relative(DATA_DIR, file);
    validateReport(rep, where);
    assert(rep.id === rec.id, `${where}: report id "${rep.id}" does not match directory id "${rec.id}"`);
    out.push({ rep, file });
  }
  out.sort((a, b) => (a.rep.reported_at < b.rep.reported_at ? -1 : 1));
  return out;
}

/**
 * Recompute field aggregates, final, confidence for `rec` from its reports.
 * Confidence is a pure function of (static, reports, conflict_events, dates)
 * so that validate-all can reproduce it byte-for-byte (scoring.md §5).
 */
function recomputeRecord(rec, reports) {
  const n = reports.length;
  const vals = Object.fromEntries(DIMENSIONS_FIELD.map((d) => [d, n ? round2(mean(reports.map((r) => r.rep.scores[d]))) : 0]));
  rec.field = { ...vals, n_reports: n };
  rec.reports = reports.map((r) => path.relative(idPaths(rec.id, "reports").abs, r.file).split(path.sep).join("/"));

  const s = static100(rec);
  const f = n ? mean(DIMENSIONS_FIELD.map((d) => vals[d])) * 20 : null;
  // pending skeleton (no static, no reports): final 0, confidence 0 — imported, unevaluated
  if (s === null && f === null) {
    rec.final = 0;
    rec.confidence = 0;
  } else {
    rec.final = s === null ? Math.round(f) : f === null ? Math.round(s) : Math.round(0.4 * s + 0.6 * f);
    let conf = Math.min(0.95, 0.3 + 0.1 * n);
    if (n >= 2 && stddev(reports.map((r) => r.rep.scores.effectiveness)) >= 1.0) conf *= 0.8;
    const known = new Set(reports.map((r) => r.rep.reported_at));
    const conflicts = (rec.conflict_events || []).filter((stamp) => known.has(stamp)).length;
    conf *= Math.pow(0.85, conflicts);
    if (rec.stale) conf *= 0.5; // upstream content changed since evaluation (scoring.md §5)
    if (rec.updated && Date.parse(today()) - Date.parse(rec.updated) > STALE_DAYS * 86400000) conf *= 0.9;
    if (s === null) conf = Math.min(conf, 0.7);
    rec.confidence = round2(Math.min(0.95, conf));
  }

  // §6 red line: a flag at high/critical severity caps the final score;
  // info/low/medium flags are transparency, not a verdict
  const maxSev = rec.static && Array.isArray(rec.static.safety_flags)
    ? rec.static.safety_flags.reduce((m, f) => Math.max(m, SEVERITIES.indexOf(f.severity)), -1)
    : -1;
  if (maxSev >= SEVERITIES.indexOf("high")) rec.final = Math.min(rec.final, 40);
  rec.updated = today();
  return rec;
}

function pushHistory(rec, event, note) {
  rec.history.push({ at: today(), event, final: rec.final, confidence: rec.confidence, n_reports: rec.field.n_reports, note });
}

// ---------------------------------------------------------------- commands --

function skeletonRecord(id) {
  return {
    id,
    name: id.split("/").pop(),
    source: "unknown",
    url: null,
    description: "",
    best_for: [],
    popularity: { stars: null, installs: null, checked_at: today() },
    static: null,
    field: { effectiveness: 0, efficiency: 0, reliability: 0, n_reports: 0 },
    conflict_events: [],
    final: 0,
    confidence: 0,
    history: [],
    reports: [],
    updated: today(),
  };
}

function loadRecord(id) {
  const file = path.join(idPaths(id, "skills").abs + ".json");
  if (!fs.existsSync(file)) return { rec: null, file };
  const rec = readJson(file);
  validateRecord(rec, path.relative(DATA_DIR, file));
  return { rec, file };
}

function saveRecord(rec, file) {
  writeJson(file, rec);
}

function cmdAdd(reportFile) {
  assert(reportFile, "add: missing report file argument");
  const rep = readJson(reportFile);
  validateReport(rep, reportFile);
  const { rec, file } = loadRecord(rep.id);
  const isNew = rec === null;
  const target = rec || skeletonRecord(rep.id);

  // conflict detection against the previous aggregate (scoring.md §5);
  // the event is persisted in conflict_events so validate-all can reproduce it
  if (!isNew && target.field.n_reports > 0 && Math.abs(target.field.effectiveness - rep.scores.effectiveness) >= 2) {
    target.conflict_events = [...(target.conflict_events || []), rep.reported_at];
  }

  const reports = [...loadReports(target)];
  if (!reports.some((r) => r.rep.reported_at === rep.reported_at)) {
    const dest = path.join(idPaths(rep.id, "reports").abs, `${rep.reported_at}.json`);
    const srcAbs = path.resolve(reportFile);
    if (fs.existsSync(dest) && path.resolve(dest) !== srcAbs) {
      throw new Fail(`report ${path.relative(DATA_DIR, dest)} already exists`);
    }
    writeJson(dest, rep);
    if (path.resolve(dest) !== srcAbs) fs.unlinkSync(srcAbs); // move semantics: relocate the report
    reports.push({ rep, file: dest });
    reports.sort((a, b) => (a.rep.reported_at < b.rep.reported_at ? -1 : 1));
  }

  target.updated = target.updated || today(); // pre-date for staleness math
  recomputeRecord(target, reports);
  pushHistory(target, "report-added", `${rep.reported_at} (${rep.verdict}) by ${rep.reporter || "anonymous"}`);
  if ((target.conflict_events || []).includes(rep.reported_at)) {
    pushHistory(target, "score-conflict", `new effectiveness ${rep.scores.effectiveness} vs aggregate ${target.field.effectiveness}`);
  }
  saveRecord(target, file);
  buildIndex(false);
  const hadConflict = (target.conflict_events || []).includes(rep.reported_at);
  console.log(`${isNew ? "created record" : "updated record"} ${target.id}`);
  console.log(`  verdict=${rep.verdict}  final=${target.final}  confidence=${target.confidence}  n_reports=${target.field.n_reports}`);
  if (hadConflict) console.log("  ! conflicting evidence — confidence penalised, re-verification recommended");
  if (target.static === null) console.log("  ! record has no static evaluation yet — run the rubric and use `static`");
}

/** Find another ledger record whose evaluated content hash matches (fork/copy detection). */
function findDuplicateByHash(hash, selfId) {
  for (const file of walkJsonFiles(SKILLS_DIR)) {
    const rec = readJson(file);
    if (rec.id !== selfId && rec.content_hash && rec.content_hash === hash) return rec.id;
  }
  return null;
}

function cmdStatic(patchFile) {
  assert(patchFile, "static: missing patch file argument");
  const patch = readJson(patchFile);
  assertSafeId(patch.id, "patch: id");
  const st = { ...patch.static, evaluated_at: patch.static.evaluated_at || today() };
  validateStatic(st, "patch.static");
  const { rec, file } = loadRecord(patch.id);
  const isNew = rec === null;
  const target = rec || skeletonRecord(patch.id);
  target.static = st;
  for (const k of ["url", "description", "best_for", "popularity"]) {
    if (patch[k] !== undefined) target[k] = patch[k];
  }
  if (target.source === "unknown" && patch.source && SOURCES.includes(patch.source)) target.source = patch.source;

  let dupNote = "";
  if (patch.content_hash !== undefined && patch.content_hash !== null) {
    assert(typeof patch.content_hash === "string" && HASH_RE.test(patch.content_hash), "patch.content_hash must be sha256:<64hex>");
    const dup = findDuplicateByHash(patch.content_hash, target.id);
    if (dup) {
      target.duplicate_of = dup;
      dupNote = `  ! content-identical to ${dup} — recorded as duplicate_of`;
    }
    target.content_hash = patch.content_hash;
    target.hash_checked_at = today();
    delete target.stale;
    delete target.stale_hash;
  }

  const reports = loadReports(target);
  recomputeRecord(target, reports);
  const flagSummary = st.safety_flags.map((f) => `${f.severity}:${f.finding}`).join("; ");
  pushHistory(target, "static-eval", `by ${st.evaluator}${flagSummary ? ` (flags: ${flagSummary})` : ""}`);
  saveRecord(target, file);
  buildIndex(false);
  const maxSevIdx = st.safety_flags.reduce((m, f) => Math.max(m, SEVERITIES.indexOf(f.severity)), -1);
  console.log(`${isNew ? "created record" : "updated record"} ${target.id}`);
  console.log(`  static=${static100(target)?.toFixed(1)}  final=${target.final}  confidence=${target.confidence}`);
  if (patch.content_hash) console.log(`  pinned ${patch.content_hash.slice(0, 18)}… @ ${target.hash_checked_at}`);
  if (maxSevIdx >= SEVERITIES.indexOf("high")) console.log(`  !! RED LINE — final capped at 40; do not recommend silently (${flagSummary})`);
  else if (st.safety_flags.length > 0) console.log(`  note: ${st.safety_flags.length} advisory flag(s) recorded for transparency (max severity: ${SEVERITIES[maxSevIdx] ?? "none"}, no cap)`);
  if (dupNote) console.log(dupNote);
}

function buildIndex(check) {
  const records = [];
  for (const file of walkJsonFiles(SKILLS_DIR)) {
    const rec = readJson(file);
    validateRecord(rec, path.relative(DATA_DIR, file));
    records.push(rec);
  }
  records.sort((a, b) => (a.id < b.id ? -1 : 1));
  let previous = null;
  if (check && fs.existsSync(INDEX_PATH)) previous = readJson(INDEX_PATH);
  const generatedAt = previous ? previous.generated_at : nowStamp();
  const index = {
    version: 1,
    generated_at: generatedAt,
    count: records.length,
    skills: records.map((r) => ({
      id: r.id,
      name: r.name,
      final: r.final,
      confidence: r.confidence,
      n_reports: r.field.n_reports,
      best_for: r.best_for,
      updated: r.updated,
      stale: !!r.stale,
      duplicate_of: r.duplicate_of || null,
    })),
  };
  const serialized = JSON.stringify(index, null, 2) + "\n";
  if (check) {
    const current = fs.existsSync(INDEX_PATH) ? fs.readFileSync(INDEX_PATH, "utf8") : null;
    if (current === serialized) {
      console.log("index.json is in sync");
      return;
    }
    throw new Fail("index.json is out of sync with skill records — run `build-index` and commit the result");
  }
  writeJson(INDEX_PATH, index);
  console.log(`index.json rebuilt (${records.length} skills)`);
}

function cmdRecompute() {
  let count = 0;
  for (const file of walkJsonFiles(SKILLS_DIR)) {
    const rec = readJson(file);
    validateRecord(rec, path.relative(DATA_DIR, file));
    const staleBefore = rec.confidence;
    const reports = loadReports(rec);
    recomputeRecord(rec, reports);
    if (staleBefore !== rec.confidence) {
      pushHistory(rec, "recompute", "recomputed from reports (staleness/conflict rules re-applied)");
    }
    saveRecord(rec, file);
    count++;
  }
  buildIndex(false);
  console.log(`recomputed ${count} record(s)`);
}

function cmdMarkStale(id, currentHash) {
  assertSafeId(id, "id");
  assert(currentHash && HASH_RE.test(currentHash), "mark-stale: current hash (sha256:<64hex>) required — compute it from the live upstream content");
  const { rec, file } = loadRecord(id);
  if (!rec) throw new Fail(`no record for ${id}`);
  if (!rec.content_hash) throw new Fail(`${id} has no content_hash pinned — nothing to compare`);
  if (currentHash === rec.content_hash) {
    console.log(`${id}: upstream unchanged — not marking stale`);
    return;
  }
  rec.stale = true;
  rec.stale_hash = currentHash;
  recomputeRecord(rec, loadReports(rec));
  pushHistory(rec, "score-stale", `upstream changed (was ${rec.content_hash.slice(0, 18)}…, now ${currentHash.slice(0, 18)}…) — confidence halved pending re-evaluation`);
  saveRecord(rec, file);
  buildIndex(false);
  console.log(`${id}: marked stale — confidence now ${rec.confidence}; re-evaluate and register a fresh static patch to clear`);
}

function cmdShow(id) {
  assertSafeId(id, "id");
  const { rec, file } = loadRecord(id);
  if (!rec) throw new Fail(`no record for ${id} (expected at ${path.relative(process.cwd(), file)})`);
  console.log(JSON.stringify(rec, null, 2));
}

function cmdValidateAll() {
  let errors = 0;
  const records = [];
  for (const file of walkJsonFiles(SKILLS_DIR)) {
    const where = path.relative(DATA_DIR, file);
    try {
      const rec = readJson(file);
      validateRecord(rec, where);
      // derived-field consistency: recompute from reports and compare
      const probe = JSON.parse(JSON.stringify(rec));
      const reports = loadReports(probe);
      const expectedReports = probe.reports.map((rel) => path.join(idPaths(probe.id, "reports").abs, ...rel.split("/")));
      assert(
        reports.length === expectedReports.length && expectedReports.every((f) => fs.existsSync(f)),
        `${where}: reports[] does not match files under data/reports/${probe.id}/`
      );
      recomputeRecord(probe, reports);
      for (const k of ["field", "final", "confidence", "reports"]) {
        assert(JSON.stringify(probe[k]) === JSON.stringify(rec[k]),
          `${where}: derived field "${k}" is stale — run \`recompute\` and commit`);
      }
      for (const rel of rec.reports) {
        const rf = path.join(idPaths(rec.id, "reports").abs, ...rel.split("/"));
        assert(fs.existsSync(rf), `${where}: report file missing: data/reports/${rel}`);
      }
      records.push(rec);
    } catch (e) {
      errors++;
      console.error(`FAIL ${where}: ${e.message}`);
    }
  }
  for (const file of walkJsonFiles(REPORTS_DIR)) {
    const where = path.relative(DATA_DIR, file);
    if (where.split(path.sep)[1] === "staging") continue; // staging/ = unvalidated inbox; `add` validates on merge
    try {
      const rep = readJson(file);
      validateReport(rep, where);
      const ownerDir = path.join(idPaths(rep.id, "reports").abs);
      assert(file.startsWith(ownerDir + path.sep), `${where}: report lives outside its id directory data/reports/${rep.id}/`);
    } catch (e) {
      errors++;
      console.error(`FAIL ${where}: ${e.message}`);
    }
  }
  if (errors) throw new Fail(`${errors} validation error(s)`);
  console.log(`OK: ${records.length} record(s), all reports valid, derived fields in sync`);
}

// -------------------------------------------------------------------- main --

const USAGE = `ledger.js — 相马经 maintenance CLI

  node ledger.js validate-all
  node ledger.js add <report.json>
  node ledger.js static <patch.json>
  node ledger.js build-index [--check]
  node ledger.js show <id>
  node ledger.js recompute
  node ledger.js mark-stale <id> <sha256:...>   upstream changed; halve confidence until re-evaluated`;

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    switch (cmd) {
      case "validate-all": cmdValidateAll(); break;
      case "add": cmdAdd(rest[0]); break;
      case "static": cmdStatic(rest[0]); break;
      case "build-index": buildIndex(rest.includes("--check")); break;
      case "show": cmdShow(rest[0]); break;
      case "recompute": cmdRecompute(); break;
      case "mark-stale": cmdMarkStale(rest[0], rest[1]); break;
      default:
        console.log(USAGE);
        process.exit(cmd === undefined ? 0 : 2);
    }
  } catch (e) {
    if (e instanceof Fail) {
      console.error(`FAIL: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

main(process.argv.slice(2));
