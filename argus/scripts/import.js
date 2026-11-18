#!/usr/bin/env node
/**
 * import.js — pull candidate skills from existing catalogs into the 相马经
 * as **pending** entries (零依赖 Node >=18).
 *
 * Borrowed databases, upgraded: external catalogs supply *coverage* and
 * popularity metadata only. Their rankings/scores are never imported — every
 * entry lands as static=null, n_reports=0, final=0, confidence=0 ("已收录，
 * 待评估") and must pass the rubric before it can influence any
 * recommendation.
 *
 * Commands:
 *   skillsmp --creator <name> [--limit 20] [--page 1]
 *       SkillsMP REST API (anonymous: 50 req/day, 10/min — be sparse).
 *       https://skillsmp.com/api/v1/skills/search?creator=...&limit=...&page=...
 *   skills-sh <keyword> [keyword...]
 *       Shells `npx --yes skills find <kw>` (skills.sh) and parses
 *       owner/repo@skill + install counts.
 *   pending
 *       List ledger entries still awaiting static evaluation.
 *
 * Exit codes: 0 ok, 1 import error, 2 usage error.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { normalizeCategory, classify } = require("./taxonomy");

const DATA_DIR = path.resolve(__dirname, "..", "data");
const SKILLS_DIR = path.join(DATA_DIR, "skills");
const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

class Fail extends Error {}

function out(m) { process.stdout.write(m + "\n"); }

function assertSafeSegment(seg, what) {
  if (typeof seg !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(seg) || seg === "." || seg === "..") {
    throw new Fail(`${what}: unsafe segment "${seg}"`);
  }
}

function skeleton(id, { source, url, description, popularity, category }) {
  const cat = normalizeCategory(category) || classify({ id, name: id.split("/").pop(), description, bestFor: [] });
  return {
    id,
    name: id.split("/").pop(),
    source,
    url: url || null,
    description: (description || "").replace(/\s+/g, " ").trim(),
    best_for: [],
    category: cat,
    popularity: { stars: popularity?.stars ?? null, installs: popularity?.installs ?? null, checked_at: today() },
    static: null,
    field: { effectiveness: 0, efficiency: 0, reliability: 0, n_reports: 0 },
    conflict_events: [],
    final: 0,
    confidence: 0,
    history: [{ at: today(), event: "seed", final: 0, confidence: 0, n_reports: 0, note: `imported from ${source} catalog — pending static evaluation` }],
    reports: [],
    updated: today(),
  };
}

function upsert(rec) {
  const file = path.join(SKILLS_DIR, ...rec.id.split("/")) + ".json";
  if (fs.existsSync(file)) {
    const cur = JSON.parse(fs.readFileSync(file, "utf8"));
    cur.popularity = { ...rec.popularity, stars: rec.popularity.stars ?? cur.popularity?.stars ?? null };
    if (!cur.description && rec.description) cur.description = rec.description;
    if (!cur.url && rec.url) cur.url = rec.url;
    if (!cur.category && rec.category) cur.category = rec.category;
    cur.updated = today();
    fs.writeFileSync(file, JSON.stringify(cur, null, 2) + "\n");
    return "refreshed";
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  return "imported";
}

/** github tree URL -> {owner, repo, skill} or null */
function parseGithubUrl(u) {
  const m = /github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/[^/]+)?\/?(.*)/.exec(u || "");
  if (!m) return null;
  const [, owner, repo, p = ""] = m;
  const segs = p.split("/").filter(Boolean);
  // conventional layouts: <owner>/<repo>/skills/<name> or .../<name>
  const skill = segs.length ? segs[segs.length - 1] : null;
  if (!skill || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(skill)) return null;
  return { owner, repo, skill };
}

async function importSkillsmp(args) {
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const creator = get("--creator");
  const q = get("--q");
  if (!creator && !q) throw new Fail("skillsmp: --creator <name> or --q <keyword> required");
  const limit = Math.min(Number(get("--limit") || 20), 50);
  const page = Number(get("--page") || 1);
  const category = get("--category") || null;
  const params = new URLSearchParams({ limit: String(limit), page: String(page) });
  if (creator) params.set("creator", creator);
  if (q) params.set("q", q);
  if (params.get("sortBy") !== "relevance" && !q) params.set("sortBy", "stars");
  const url = `https://skillsmp.com/api/v1/skills/search?${params.toString()}`;
  out(`GET ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Fail(`SkillsMP returned ${res.status} (anonymous quota: 50 req/day, 10/min)`);
  const body = await res.json();
  const skills = body?.data?.skills || [];
  let imported = 0, refreshed = 0, skipped = 0;
  for (const s of skills) {
    const gh = parseGithubUrl(s.githubUrl);
    const skillName = gh ? gh.skill : s.name;
    if (!skillName) { skipped++; continue; }
    const id = `${gh ? gh.owner : s.author}/${gh ? gh.repo : s.author}/${skillName}`;
    try {
      assertSafeSegment(gh ? gh.owner : s.author, "owner");
      assertSafeSegment(gh ? gh.repo : s.author, "repo");
      assertSafeSegment(skillName, "skill");
    } catch (e) { skipped++; process.stderr.write(`  skip ${s.githubUrl}: ${e.message}\n`); continue; }
    const status = upsert(skeleton(id, {
      source: "skillsmp",
      url: s.githubUrl,
      description: s.description,
      popularity: { stars: typeof s.stars === "number" ? s.stars : null },
      category: category || (q ? classify({ id, description: s.description }) : null),
    }));
    status === "imported" ? imported++ : refreshed++;
    out(`  ${status.padEnd(9)} ${id}${s.stars ? ` (stars ${s.stars})` : ""}`);
  }
  out(`done: ${imported} imported, ${refreshed} refreshed, ${skipped} skipped (page ${page}/${body?.pagination?.totalPages ?? "?"}, total ${body?.pagination?.total ?? "?"})`);
  out("remember: imported entries are PENDING (final 0, confidence 0) — evaluate with the rubric before trusting.");
}

function parseInstalls(s) {
  const m = /([\d.]+)\s*([KM]?)/i.exec(s || "");
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(/k/i.test(m[2]) ? n * 1000 : /m/i.test(m[2]) ? n * 1000000 : n);
}

function importSkillsSh(keywords) {
  if (!keywords.length) throw new Fail("skills-sh: at least one keyword required");
  // sanitized: keywords are interpolated into a shell command below
  for (const kw of keywords) {
    if (/["'`;&|<>$]/.test(kw)) throw new Fail(`skills-sh: unsafe keyword "${kw}"`);
  }
  const topIdx = keywords.indexOf("--top");
  let top = 8;
  if (topIdx >= 0) {
    top = Number(keywords[topIdx + 1]);
    keywords.splice(topIdx, 2);
  }
  const catIdx = keywords.indexOf("--category");
  const category = catIdx >= 0 ? keywords[catIdx + 1] : null;
  if (catIdx >= 0) keywords.splice(catIdx, 2);
  let imported = 0, refreshed = 0;
  for (const kw of keywords) {
    out(`npx skills find "${kw}" (top ${top} by installs)`);
    const r = spawnSync(`npx --yes skills find ${kw}`, { encoding: "utf8", timeout: 90000, shell: true });
    if (r.error || !r.stdout) { process.stderr.write(`  npx failed for "${kw}" — skipping (${(r.error || { message: "no output" }).message})\n`); continue; }
    const re = /^\s*([\w.-]+)\/([\w.-]+)@([\w.-]+)\s+(\d[\d.,]*\s*[KM]?)\s*installs?\s*$/im;
    const found = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = re.exec(line);
      if (!m) continue;
      const [, owner, repo, skill, installsStr] = m;
      try {
        assertSafeSegment(owner, "owner"); assertSafeSegment(repo, "repo"); assertSafeSegment(skill, "skill");
      } catch { continue; }
      found.push({ owner, repo, skill, installsStr, installs: parseInstalls(installsStr) });
    }
    found.sort((a, b) => (b.installs || 0) - (a.installs || 0));
    let count = 0;
    for (const f of found.slice(0, top)) {
      const id = `${f.owner}/${f.repo}/${f.skill}`;
      const status = upsert(skeleton(id, {
        source: "skills.sh",
        url: `https://skills.sh/${f.owner}/${f.repo}/${f.skill}`,
        description: "",
        popularity: { installs: f.installs },
        category: category || classify({ id }),
      }));
      status === "imported" ? imported++ : refreshed++;
      count++;
      out(`  ${status.padEnd(9)} ${id} (${f.installsStr.trim()} installs)`);
    }
    if (!count) out(`  no parseable results for "${kw}"`);
  }
  out(`done: ${imported} imported, ${refreshed} refreshed`);
  out("remember: imported entries are PENDING (final 0, confidence 0) — evaluate with the rubric before trusting.");
}

function cmdPending() {
  const walk = (d, acc = []) => {
    if (!fs.existsSync(d)) return acc;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, acc);
      else if (e.name.endsWith(".json")) acc.push(JSON.parse(fs.readFileSync(full, "utf8")));
    }
    return acc;
  };
  const all = walk(SKILLS_DIR);
  const pending = all.filter((r) => r.static === null);
  out(`${all.length} record(s), ${pending.length} pending static evaluation:`);
  for (const r of pending) out(`  ${r.id}  [${r.source}]  installs=${r.popularity?.installs ?? "-"} stars=${r.popularity?.stars ?? "-"}`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "skillsmp": await importSkillsmp(rest); break;
      case "skills-sh": importSkillsSh(rest); break;
      case "pending": cmdPending(); return;
      default:
        out(`usage: import.js skillsmp --creator <name> | --q <keyword> [--limit 20] [--page 1] [--category <cat>]
       import.js skills-sh <keyword> [keyword...] [--top 8] [--category <cat>]
       import.js pending`);
        process.exit(cmd === undefined ? 0 : 2);
    }
    // the index is derived data — keep it in sync after any mutation
    const idx = spawnSync(`node "${path.join(__dirname, "ledger.js")}" build-index`, { encoding: "utf8", shell: true });
    if (idx.stdout) out(idx.stdout.trim());
    if (idx.status !== 0) process.stderr.write(idx.stderr || "index rebuild failed\n");
  } catch (e) {
    process.stderr.write(`FAIL: ${e instanceof Fail ? e.message : e.message}\n`);
    process.exit(1);
  }
}

main(process.argv.slice(2));
