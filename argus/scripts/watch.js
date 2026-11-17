#!/usr/bin/env node
/**
 * watch.js — upstream drift detector for the 相马经 (零依赖 Node >=18).
 *
 * Re-fetches each evaluated record's SKILL.md, recomputes its content hash
 * (same spec as lint.js: BOM strip + CRLF→LF + SHA-256), and reports drift:
 * the upstream skill changed since the score was pinned.
 *
 * Read-only: it REPORTS; applying drift is a human/agent decision via
 *   node ledger.js mark-stale <id> <sha256:...>   (halves confidence)
 *   node lint.js check --url ... (re-evaluate, then `ledger.js static` re-pin)
 *
 * Output: a markdown report on stdout. The line "NO-DRIFT" means nothing
 * changed. Exit code 1 when drift or errors exist (CI-friendly).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SKILLS_DIR = path.resolve(__dirname, "..", "data", "skills");

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile() && e.name.endsWith(".json")) acc.push(full);
  }
  return acc;
}

/** Candidate raw URLs ordered best-first: the pinned source URL, then heuristics, then the repo tree. */
function candidates(rec) {
  const [owner, repo, skill] = rec.id.split("/");
  const urls = [];
  if (rec.hash_source_url) urls.push(rec.hash_source_url);
  const m = /github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)\/?(.*))?/.exec(rec.url || "");
  const refs = m && m[3] ? [m[3]] : ["main", "master"];
  const paths = [];
  if (m && m[4]) {
    const p = m[4].replace(/\/$/, "");
    paths.push(/SKILL\.md$/.test(p) ? p : `${p}/SKILL.md`);
  }
  paths.push(`${skill}/SKILL.md`, `skills/${skill}/SKILL.md`, "SKILL.md");
  for (const ref of refs) for (const p of paths) urls.push(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`);
  return urls;
}

/** GitHub trees API fallback: find SKILL.md paths whose parent dir matches the skill name. */
async function treeCandidates(rec) {
  const [owner, repo, skill] = rec.id.split("/");
  const ref = /github\.com\/[^/]+\/[^/]+\/(?:tree|blob)\/([^/]+)/.exec(rec.url || "")?.[1] || "main";
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    const j = await res.json();
    const all = (j.tree || []).filter((t) => t.type === "blob" && /(^|\/)SKILL\.md$/.test(t.path));
    const named = all.filter((t) => t.path.split("/").slice(-2)[0] === skill);
    const picked = (named.length ? named : all).slice(0, 3);
    return picked.map((t) => `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${t.path}`);
  } catch { return []; }
}

async function fetchHash(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const raw = await res.text();
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  return { hash: "sha256:" + crypto.createHash("sha256").update(normalized, "utf8").digest("hex"), url };
}

async function main() {
  const lines = [];
  let checked = 0, unchanged = 0, drifted = 0, unpinned = 0, errors = 0;
  for (const file of walk(SKILLS_DIR)) {
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    if (rec.static === null) continue; // pending entries have nothing pinned to protect
    if (!rec.content_hash) {
      unpinned++;
      lines.push(`- UNPINNED ${rec.id} — evaluated before hashing existed; re-run \`lint.js check --url …\` and re-register to pin`);
      continue;
    }
    let found = null;
    for (const u of candidates(rec)) {
      try {
        const r = await fetchHash(u);
        if (r) { found = r; break; }
      } catch { /* next candidate */ }
      await new Promise((r) => setTimeout(r, 150)); // be polite to raw.githubusercontent
    }
    if (!found) {
      for (const u of await treeCandidates(rec)) {
        try {
          const r = await fetchHash(u);
          if (r) { found = r; break; }
        } catch { /* next candidate */ }
      }
    }
    if (!found) { errors++; lines.push(`- FETCH-FAIL ${rec.id} — no candidate URL answered`); continue; }
    checked++;
    if (found.hash === rec.content_hash) unchanged++;
    else {
      drifted++;
      lines.push(`- DRIFT ${rec.id}\n  evaluated: ${rec.content_hash}\n  current:   ${found.hash}\n  from: ${found.url}\n  → node argus/scripts/ledger.js mark-stale ${rec.id} ${found.hash}`);
    }
  }
  const header = `# Ledger drift report (${new Date().toISOString().slice(0, 10)})\n\nchecked=${checked} unchanged=${unchanged} drifted=${drifted} unpinned=${unpinned} fetch-failed=${errors}\n`;
  const body = lines.length ? lines.join("\n") + "\n" : "NO-DRIFT\n";
  process.stdout.write(header + body);
  process.exit(drifted + errors > 0 ? 1 : 0);
}

main();
