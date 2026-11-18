#!/usr/bin/env node
/**
 * lint.js — mechanical SKILL.md analyzer for Argus (零依赖 Node >=18).
 *
 * The deterministic half of the static rubric: ~40 borrowed-and-adapted
 * checks from sayed3li97/skillscore (27-rule/7-category design) and
 * joeynyc/skillscore (proximity exfil detection, privilege/loop checks,
 * MCP/portability rules), remapped onto Argus's five dimensions
 * (trigger / structure / actionability / safety / portability) so results
 * slot straight into the ledger's `static` patch (references/rubric.md).
 *
 * The agent runs this FIRST, then applies judgment on top and registers the
 * merged evaluation with `node ledger.js static <patch.json>`. Mechanical
 * scores are suggestions — judgment may override, evidence stays.
 *
 * Commands:
 *   check <path>            lint a local skill dir or SKILL.md
 *   check --url <github-url>  lint a GitHub-hosted skill (raw fetch)
 *   conflicts [path]        trigger-surface overlap: ledger records by default,
 *                           or a folder of skill dirs
 *   flags: --json  --min-score <n> (check gate, exit 1 below n)
 *
 * Exit codes: 0 ok, 1 gate/conflict threshold failed, 2 usage error.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const crypto = require("crypto");

const KNOWN_FM_KEYS = ["name", "description", "allowed-tools", "license", "metadata"];
const STOPWORDS = new Set(["the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with", "when", "use", "used", "using", "this", "that", "it", "its", "is", "are", "be", "been", "can", "could", "should", "would", "will", "if", "as", "by", "at", "from", "your", "you", "we", "our", "i", "not", "no", "into", "about", "than", "then", "there", "their", "they", "them", "has", "have", "had", "do", "does", "did", "so", "such", "also", "any", "all", "more", "most", "other", "some", "what", "which", "who", "how", "skill", "skills", "agent", "agents"]);
// English + Chinese action verbs (Chinese list added after live false-warns on
// Chinese descriptions — agent-verified gap, 2026-11-18)
const ACTION_VERBS = /^(creates?|edits?|builds?|manages?|provides?|helps?|covers?|handles?|analyz|extracts?|converts?|generates?|designs?|writes?|reviews?|validates?|orchestrates?|searches?|finds?|scans?|monitors?|controls?|tests?|debugs?|deploys?|formats?|transforms?|comprehensives?|complete|professional|use|stop|applies?|supports?|automates?|fixes?|checks?|reads?|view|run|runs?|installs?|cleans?|tracks?|processes?|renders?|parses?|query|queries|routes?|restyles?|splits?|merges?|fills?|exports?|imports?|audits?|routs?|处理|创建|编辑|提供|支持|管理|转换|生成|设计|提取|合并|拆分|审查|验证|搜索|查找|扫描|监控|测试|调试|部署|格式化|写入|读取|自动化|分析|修复|检查|对比|比较|识别|翻译|总结|撰写|优化|编排|调度|爬取|抓取|下载|上传|操作|构建|解读|评测|评分|评估|推荐|执行|发送|接收|整理|清洗|标注)/;

class Fail extends Error {}

function out(msg) { process.stdout.write(msg + "\n"); }
function die(msg, code = 2) { process.stderr.write(`FAIL: ${msg}\n`); process.exit(code); }

// ------------------------------------------------------------ text helpers --

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 9;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

function tokenize(text) {
  // Chinese runs have no spaces: emit overlapping 2-grams so alignment scoring
  // can match (found via live eval — whole-sentence tokens never aligned)
  const out = [];
  for (const w of String(text).toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!w) continue;
    if (/^[\u4e00-\u9fff]+$/.test(w)) {
      if (w.length === 1) continue;
      if (w.length === 2) { out.push(w); continue; }
      for (let i = 0; i + 2 <= w.length; i++) out.push(w.slice(i, i + 2));
    } else if (w.length > 2 && !STOPWORDS.has(w)) {
      out.push(w.length > 4 ? w.replace(/(ings?|ies|ing|es|s)$/, "") : w);
    }
  }
  return out;
}

function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { present: false, fm: {}, body: raw };
  const lines = m[1].split(/\r?\n/);
  const fm = {};
  let key = null, folded = false;
  for (const line of lines) {
    if (folded) { // continuation of a `>` / `|-` folded scalar
      if (/^\s+\S/.test(line)) { fm[key] += " " + line.trim(); continue; }
      folded = false; key = null;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      if (/^[>|][+-]?$/.test(v) || v === "") { if (v) folded = /^[>|]/.test(v); fm[key] = fm[key] || ""; }
      else fm[key] = v.replace(/^["']|["']$/g, "");
    } else if (/^\s*-\s+/.test(line) && key) { // allowed-tools style lists
      fm[key] += "\n" + line.trim();
    }
  }
  return { present: true, fm, body: raw.slice(m[0].length) };
}

function contentBlocks(body) {
  const blocks = [];
  let inFence = false, cur = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^```/.test(line.trim())) { blocks.push({ fence: true, text: cur.join("\n") }); cur = []; inFence = !inFence; continue; }
    if (!inFence) cur.push(line);
  }
  blocks.push({ fence: inFence, text: cur.join("\n") });
  return blocks; // trailing block fence=true means unclosed
}

// ------------------------------------------------------------------ checks --

function runChecks({ present, fm, body, dir }) {
  /** each: {id, dim, status: pass|warn|fail, detail} */
  const C = [];
  const add = (id, dim, status, detail) => C.push({ id, dim, status, detail });

  // ---- frontmatter (maps to trigger + portability) ----
  add("fm_present", "portability", present ? "pass" : "fail",
    present ? "YAML frontmatter present" : "no `---` delimited frontmatter — the skill cannot load as an Agent Skill");

  if (present) {
    const name = fm.name || "";
    add("name_format", "trigger",
      /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 64 && !name.includes("--") ? "pass" : "fail",
      `name "${name}" ${/^[a-z0-9][a-z0-9-]*$/.test(name) ? "format ok" : "must be lowercase kebab-case"}, ${name.length} chars (<=64)`);
    if (dir) {
      const base = path.basename(path.resolve(dir)).toLowerCase();
      if (base && base !== "skills") add("name_matches_dir", "trigger", base === name ? "pass" : "warn",
        base === name ? `directory name "${base}" matches frontmatter name` : `directory "${base}" != frontmatter name "${name}" — discovery requires a match`);
    }
    // unknown keys with typo detection (borrowed: A5)
    for (const k of Object.keys(fm)) {
      if (KNOWN_FM_KEYS.includes(k)) continue;
      const near = KNOWN_FM_KEYS.find((kk) => levenshtein(kk.toLowerCase(), k.toLowerCase()) <= 2);
      add("fm_keys", "portability", near ? "warn" : "warn",
        near ? `unknown frontmatter key "${k}" — did you mean "${near}"?` : `unknown frontmatter key "${k}" (known: ${KNOWN_FM_KEYS.join(", ")})`);
    }
    if (fm["allowed-tools"] !== undefined) {
      const ok = /^[\w\s:,\-()]+$/.test(fm["allowed-tools"]);
      add("allowed_tools", "safety", ok ? "pass" : "warn",
        ok ? `allowed-tools declares: ${fm["allowed-tools"].replace(/\n/g, " ").slice(0, 80)}` : "allowed-tools entry is not a plain tool-name list");
    }
  }

  const desc = fm.description || "";
  const descBody = desc.replace(/\s+/g, " ").trim();
  add("desc_present", "trigger", descBody ? (descBody.length <= 1024 ? "pass" : "fail") : "fail",
    descBody ? `description ${descBody.length} chars (limit 1024)` : "description missing — the skill can never trigger");

  if (descBody) {
    add("desc_what", "trigger", ACTION_VERBS.test(descBody.slice(0, 60)) ? "pass" : "warn",
      ACTION_VERBS.test(descBody.slice(0, 60)) ? "opens with an action verb (states WHAT)" : "opening does not state WHAT with an action verb");
    add("desc_when", "trigger", /use (this )?(when|for|it)|when the user|whenever|trigger|用于|使用场景|何时|当用户|适用于|触发/i.test(descBody) ? "pass" : "warn",
      /use (this )?(when|for|it)|when the user|whenever|trigger|用于|使用场景|何时|当用户|适用于|触发/i.test(descBody) ? "states WHEN to trigger" : "no WHEN clause — routing will be weak");
    // strip quoted user utterances ("how do I…", 「…」, “…”) before the first-person test —
    // quoted phrases are evidence of routing intent, not the skill's own voice
    const unquoted = descBody.replace(/"[^"]*"|“[^”]*”|「[^」]*」|『[^』]*』/g, " ");
    const firstPerson = /\b(i|we|my|our|mine)\b|我们|我的/i.test(unquoted);
    add("desc_third_person", "trigger", firstPerson ? "warn" : "pass", firstPerson ? "first-person voice in description breaks routing convention" : "third-person voice");
    const first60 = descBody.slice(0, 60);
    add("desc_frontloaded", "trigger", tokenize(first60).length >= 2 ? "pass" : "warn",
      tokenize(first60).length >= 2 ? `front-loaded keywords: ${tokenize(first60).slice(0, 4).join(", ")}` : `first 60 chars are generic ("${first60.slice(0, 40)}…")`);
    add("desc_boundary", "trigger", /do not use|don'?t use|not (for|when)|avoid (using|for)|不适用|不要(用于|在)/i.test(descBody) ? "pass" : "warn",
      /do not use|don'?t use|not (for|when)|avoid (using|for)|不适用|不要(用于|在)/i.test(descBody) ? "has a boundary clause (when NOT to use)" : "no boundary clause — risk of over-triggering");
    if (descBody.length > 600) add("desc_length_risk", "trigger", "warn", `description ${descBody.length} chars — frontmatter descriptions get truncated in context; keep the trigger-critical part early`);
  }

  // ---- body / structure ----
  const lines = body.split(/\r?\n/);
  add("body_length", "structure",
    lines.length <= 500 ? "pass" : lines.length <= 1000 ? "warn" : "fail",
    `${lines.length} lines (guide: <=500; 500–1000 decays; >1000 fails)`);

  const hasSubdirs = dir && ["references", "scripts", "assets"].some((d) => fs.existsSync(path.join(dir, d)));
  const mdLinks = [...body.matchAll(/\]\(([^)#]+\.(?:md|json|yaml|txt))\)/g)].map((m) => m[1]);
  add("progressive_disclosure", "structure",
    hasSubdirs || mdLinks.length > 0 ? "pass" : lines.length > 300 ? "warn" : "pass",
    hasSubdirs ? "detail split into references/scripts/assets" : mdLinks.length ? `${mdLinks.length} reference file link(s)` : lines.length > 300 ? `${lines.length} lines with no split into references/ — progressive disclosure missing` : "small enough to stay single-file");

  // broken relative links (mechanical win)
  if (dir && mdLinks.length) {
    const broken = mdLinks.filter((l) => !l.startsWith("http") && !fs.existsSync(path.join(dir, decodeURIComponent(l))));
    add("links_resolve", "structure", broken.length ? "warn" : "pass",
      broken.length ? `broken relative link(s): ${broken.slice(0, 3).join(", ")}` : "all relative links resolve");
  }

  const text = contentBlocks(body).map((b) => b.text).join("\n");
  add("bloat", "structure", /^#{1,3}\s*(introduction|what is|overview of the|background)\b/im.test(body) ? "warn" : "pass",
    /^#{1,3}\s*(introduction|what is|overview of the|background)\b/im.test(body) ? "explainer headers present — agents already know this material" : "no explainer bloat headers");
  add("stale_dates", "structure", /\bas of (19|20)\d\d|\bcopyright (19|20)\d\d|\b(19|20)\d\d-(0[1-9]|1[0-2])-[0-3]\d\b/.test(text) ? "warn" : "pass",
    /\bas of (19|20)\d\d|\bcopyright (19|20)\d\d|\b(19|20)\d\d-(0[1-9]|1[0-2])-[0-3]\d\b/.test(text) ? "date-anchored statements will rot" : "no rotting date anchors");
  add("backslash_paths", "portability", /\\\\[\w.-]+|(^|[\s`(])\w:\\\\?[\w\\]+/m.test(body) || /\b[A-Za-z]:\\/.test(body) ? "warn" : "pass",
    /\b[A-Za-z]:\\/.test(body) ? "Windows-style absolute paths — not portable" : "no Windows-style paths");
  add("abs_paths", "portability", /(^|[\s`(])\/(home|Users|root|usr\/local|var\/)\S*/m.test(body) ? "warn" : "pass",
    /(^|[\s`(])\/(home|Users|root|usr\/local|var\/)\S*/m.test(body) ? "hardcoded absolute paths — prefer relative or $HOME" : "no hardcoded absolute paths");

  // ---- instruction design (actionability) ----
  add("numbered_steps", "actionability", /^\s*\d+[.)]\s+\S/m.test(body) || /^\s*-\s+\[[ x]\]/m.test(body) ? "pass" : "warn",
    /^\s*\d+[.)]\s+\S/m.test(body) ? "numbered workflow steps present" : /^\s*-\s+\[[ x]\]/m.test(body) ? "checklist present" : "no numbered steps or checklists found");
  const fences = contentBlocks(body).filter((b) => b.fence).length;
  add("code_example", "actionability", fences > 0 ? "pass" : "warn", `${fences} fenced code block(s)`);
  add("feedback_loop", "actionability", /verify|validate|check (that|the)|confirm|re-?run|repeat|再次|校验|验证|确认|复查/i.test(text) ? "pass" : "warn",
    /verify|validate|check (that|the)|confirm|re-?run|repeat|再次|校验|验证|确认|复查/i.test(text) ? "verification/feedback loop present" : "no verify/repeat loop — errors surface late");
  add("anti_patterns", "actionability", /anti-?pattern|avoid|never|do not|don'?t|常见错误|避免|禁止|不要|切勿|反模式|禁忌|误区|陷阱|一律不要/i.test(text) ? "pass" : "warn",
    /anti-?pattern|avoid|never|do not|don'?t|常见错误|避免|禁止|不要|切勿|反模式|禁忌|误区|陷阱|一律不要/i.test(text) ? "anti-patterns stated explicitly" : "no explicit anti-patterns — agent must guess the failure modes");
  add("error_handling", "actionability", /try\s*[{(]|set -e|\|\| (exit|return|fallback)|重试|失败时|出错|异常处理|错误处理|回退|降级|报错/.test(text) ? "pass" : "warn",
    /try\s*[{(]|set -e|\|\| (exit|return|fallback)|重试|失败时|出错|异常处理|错误处理|回退|降级|报错/.test(text) ? "error handling visible in examples/prose" : "no error-handling markers in examples");
  add("dep_check", "actionability", /--version|command -v|which |python3? -c |node -e |依赖|前置要求|已安装/.test(text) ? "pass" : "warn",
    /--version|command -v|which |python3? -c |node -e |依赖|前置要求|已安装/.test(text) ? "dependency verification present" : "no dependency checks — skills fail mysteriously on other machines");

  // ---- safety (borrowed: proximity exfil, escalation, §D-0 patterns) ----
  const scanText = body; // scripts content would need fetching; SKILL.md body first
  let safetyScore = 5;
  const flags = [];
  const secRe = /(password|passwd|secret|api[_-]?key|token|credential|private[_-]?key|私钥|密钥|凭据)/i;
  const netRe = /(https?:\/\/|curl\s|wget\s|fetch\(|requests\.(post|put)|\bnc\b|netcat)/i;
  const secLines = [], netLines = [];
  scanText.split(/\r?\n/).forEach((l, i) => { if (secRe.test(l)) secLines.push(i); if (netRe.test(l)) netLines.push(i); });
  const prox = secLines.filter((s) => netLines.some((n) => Math.abs(n - s) <= 5)).length;
  if (prox > 0) { add("secret_proximity", "safety", "warn", `${prox} line(s) pair a secret-like term with a network call within 5 lines — manual review required`); safetyScore -= 1; }
  if (/(curl|wget)[^|]*\|\s*(ba)?sh|Invoke-\w+.*-?Exec|eval\(\s*base64/i.test(scanText)) {
    add("piped_remote", "safety", "fail", "remote code piped straight into a shell (curl|sh / eval base64) — §D-0 red line");
    flags.push("piped remote execution pattern"); safetyScore = 1;
  }
  if (/base64[^)\n]*(--decode| -d\b)/i.test(scanText)) { add("base64_decode", "safety", "warn", "base64 decode present — obfuscation review required"); safetyScore -= 1; }
  if (/\brm\s+-rf\b/.test(scanText)) { add("rm_rf", "safety", "warn", "`rm -rf` present — must be scoped and confirmed"); safetyScore -= 1; }
  if (/\bsudo\b/.test(scanText)) { add("sudo", "safety", "warn", "privilege escalation present — needs justification"); safetyScore -= 1; }
  if (/(\benv\b\s*\|\s*\S+|printenv\s*(>|>>|\|)|process\.env[^)]*\b(log|send|post|fetch|http))/i.test(scanText)) { add("env_dump", "safety", "warn", "environment variables piped/logged — exfiltration review"); safetyScore -= 1; }
  if (/while\s+true\s*;?\s*(do)?\s*$/im.test(scanText) && !/\bbreak\b|\btimeout\b/.test(scanText)) { add("unbounded_loop", "safety", "warn", "unbounded loop without break/timeout guard"); safetyScore -= 1; }
  if (fm.present && (fm["allowed-tools"] === undefined) && /(curl|wget|http)/.test(scanText)) {
    add("undeclared_network", "safety", "warn", "network calls in body but allowed-tools undeclared — declare least privilege");
    safetyScore -= 1;
  }
  if (dir) {
    const scriptsDir = path.join(dir, "scripts");
    const scriptFiles = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir).filter((f) => /\.(sh|js|py|ps1|cmd|bat)$/i.test(f)) : [];
    if (scriptFiles.length) {
      const documented = scriptFiles.every((f) => scanText.includes(f)) || /safety|危险|安全|destructive/i.test(scanText);
      add("scripts_documented", "safety", documented ? "pass" : "warn",
        documented ? `bundled scripts referenced: ${scriptFiles.join(", ")}` : `bundled scripts exist (${scriptFiles.join(", ")}) but are not documented / lack a safety note — borrowed rule G1/G2`);
      if (!documented) safetyScore -= 1;
    }
  }
  safetyScore = Math.max(1, Math.min(5, safetyScore));

  // ---- MCP format (borrowed: joeynyc portability) ----
  const mcpBad = /\bmcp__[a-z0-9_-]+__[a-z0-9_-]+/i.test(scanText);
  add("mcp_format", "portability", mcpBad ? "warn" : "pass",
    mcpBad ? "mcp__server__tool references — the cross-skill convention is `ServerName:tool_name`" : "no off-convention MCP references");

  return { checks: C, safetyScore, flags };
}

// ----------------------------------------------------------------- scoring --

function dimensionScores(checks, safetyScore) {
  const dims = ["trigger", "structure", "actionability", "safety", "portability"];
  const scores = {};
  for (const dim of dims) {
    if (dim === "safety") { scores[dim] = safetyScore; continue; }
    const mine = checks.filter((c) => c.dim === dim);
    if (!mine.length) { scores[dim] = 3; continue; }
    const ratio = mine.reduce((a, c) => a + (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0), 0) / mine.length;
    scores[dim] = Math.max(1, Math.min(5, 1 + Math.round(ratio * 4)));
  }
  return scores;
}

function grade(score100) {
  return score100 >= 97 ? "A+" : score100 >= 93 ? "A" : score100 >= 90 ? "A-" : score100 >= 87 ? "B+" : score100 >= 83 ? "B"
    : score100 >= 80 ? "B-" : score100 >= 77 ? "C+" : score100 >= 73 ? "C" : score100 >= 70 ? "C-"
    : score100 >= 65 ? "D" : score100 >= 60 ? "D-" : "F";
}

/** Canonical content hash: BOM stripped, CRLF→LF, SHA-256 (spec shared with watch.js). */
const round2 = (x) => Math.round(x * 100) / 100;
const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

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

function assert(cond, msg) {
  if (!cond) throw new Fail(msg);
}

function contentHash(raw) {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  return "sha256:" + crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

function lintSource(raw, label, dir) {
  const { present, fm, body } = parseFrontmatter(raw);
  const { checks, safetyScore, flags } = runChecks({ present, fm, body, dir });
  const scores = dimensionScores(checks, safetyScore);
  const mean = (["trigger", "structure", "actionability", "safety", "portability"].reduce((a, d) => a + scores[d], 0)) / 5;
  const score100 = Math.round(mean * 20);
  const desc = (fm.description || "").replace(/\s+/g, " ").trim();
  const tokens = {
    description_permanent: Math.ceil(desc.length / 4),
    manifest_active: Math.ceil(raw.length / 4),
    note: "chars/4 heuristic; add ~10% for Claude-calibrated counts (borrowed calibration)",
  };
  return { label, checks, scores, score100, grade: grade(score100), tokens, flags, fm, body, content_hash: contentHash(raw), description: desc, regions: descriptionRegions(desc) };
}

function suggestedPatch(r) {
  const evidence = (dim) =>
    r.checks.filter((c) => c.dim === dim && c.status !== "pass").map((c) => `${c.id}: ${c.detail}`)
      .concat(r.checks.filter((c) => c.dim === dim && c.status === "pass").slice(0, 1).map((c) => `${c.id}: ${c.detail}`));
  return {
    id: `TODO-owner/repo/${r.fm.name || r.label}`,
    content_hash: r.content_hash,
    static: {
      trigger: r.scores.trigger,
      structure: r.scores.structure,
      actionability: r.scores.actionability,
      safety: r.scores.safety,
      portability: r.scores.portability,
      notes: ["mechanical-lint baseline — REVIEW AND OVERRIDE WITH JUDGMENT BEFORE REGISTERING",
        ...["trigger", "structure", "actionability", "safety", "portability"].map((d) => `${d}: ${evidence(d).join("; ") || "no findings"}`)],
      safety_flags: r.flags,
      evaluator: "mechanical-lint",
    },
  };
}

function printReport(r, json) {
  if (json) { out(JSON.stringify({ ...r, suggested_patch: suggestedPatch(r) }, null, 2)); return; }
  out(`\n== ${r.label} — mechanical score ${r.score100}/100 (${r.grade}) ==`);
  out(`  pinned          ${r.content_hash}`);
  for (const [dim, s] of Object.entries(r.scores)) out(`  ${dim.padEnd(14)} ${s}/5`);
  out(`  tokens          desc≈${r.tokens.description_permanent}  manifest≈${r.tokens.manifest_active} (${r.tokens.note})`);
  const problems = r.checks.filter((c) => c.status !== "pass");
  if (problems.length === 0) out("  all mechanical checks pass");
  for (const c of problems) out(`  [${c.status.toUpperCase()}] ${c.id} (${c.dim}): ${c.detail}`);
  if (r.flags.length) out(`  RED FLAGS: ${r.flags.join("; ")}`);
  out(`  → review suggested_patch (--json), then register: node ledger.js static <patch.json>\n`);
}

// ---------------------------------------------------------------- conflicts --

function triggerSurface(text) {
  const m = /use (this )?(?:skill )?when([\s\S]*?)(?:$|do not|don'?t|avoid|boundary)/i.exec(text);
  const useWhen = m ? m[1] : "";
  const first = text.split(/[.!?\n]/)[0] || "";
  return new Set([...tokenize(useWhen), ...tokenize(first)]);
}

function cmdConflicts(target) {
  const pairs = [];
  if (target) {
    const entries = fs.readdirSync(target, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const e of entries) {
      const f = path.join(target, e.name, "SKILL.md");
      if (fs.existsSync(f)) pairs.push({ id: e.name, surf: triggerSurface(fs.readFileSync(f, "utf8")) });
    }
    if (!pairs.length) die(`no SKILL.md files under subdirectories of ${target}`);
  } else {
    const skillsDir = path.join(__dirname, "..", "data", "skills");
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".json")) {
          const rec = JSON.parse(fs.readFileSync(full, "utf8"));
          pairs.push({ id: rec.id, surf: new Set([...tokenize(rec.description || ""), ...(rec.best_for || []), ...tokenize(rec.name)]) });
        }
      }
    };
    if (!fs.existsSync(skillsDir)) die("ledger empty — run from the argus skill or pass a folder of skill dirs");
    walk(skillsDir);
  }
  let flagged = 0;
  for (let i = 0; i < pairs.length; i++)
    for (let j = i + 1; j < pairs.length; j++) {
      const a = pairs[i].surf, b = pairs[j].surf;
      if (!a.size || !b.size) continue;
      const shared = [...a].filter((w) => b.has(w));
      const ratio = shared.length / Math.min(a.size, b.size);
      if (ratio >= 0.6) { flagged++; out(`OVERLAP ${(ratio * 100).toFixed(0)}%  ${pairs[i].id} <-> ${pairs[j].id}  shared: ${shared.join(", ")}`); }
    }
  out(flagged ? `${flagged} overlapping trigger surface(s) — skills may shadow each other` : `no trigger-surface overlaps across ${pairs.length} skill(s)`);
  if (flagged > 0) process.exitCode = 1;
}

// ------------------------------------------------------------------ remote --

function githubRawUrl(url) {
  const m = /github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/?(.*)/.exec(url)
    || /github\.com\/([^/]+)\/([^/]+)/.exec(url);
  if (!m) return null;
  const [, owner, repo, ref = "main", p = ""] = m;
  const clean = p.replace(/\/$/, "");
  const refs = ref ? [ref] : ["main", "master"];
  return { owner, repo, refs, file: clean && /SKILL\.md$/.test(clean) ? clean : clean ? `${clean}/SKILL.md` : "SKILL.md" };
}

async function fetchRaw(url) {
  const g = githubRawUrl(url);
  if (!g) die(`not a GitHub URL: ${url}`);
  for (const ref of g.refs) {
    const candidate = `https://raw.githubusercontent.com/${g.owner}/${g.repo}/${ref}/${g.file}`;
    try {
      const res = await fetch(candidate, { signal: AbortSignal.timeout(20000) });
      if (res.ok) {
        const raw = await res.text();
        return { raw, label: `${g.owner}/${g.repo}@${ref}`, dir: null };
      }
    } catch (e) { /* next ref */ }
  }
  die(`could not fetch SKILL.md for ${url} (tried refs: ${g.refs.join(", ")})`);
}

// ------------------------------------------------------------- eval harness --

function descriptionRegions(desc) {
  const d = String(desc || "").replace(/\s+/g, " ").trim();
  // boundary + when patterns in English AND Chinese (live-calibrated on wecomcli-sheet:
  // its when-clause starts with 用于, its boundary routes with 改用/使用 …)
  const boundaryRe = /(?:do not use|don'?t use|not (?:for|when)|avoid (?:using|for)|改用|不适用|请?勿|避免)[:\s]*([\s\S]+)$/i;
  const whenRe = /(?:use (?:this )?(?:when|for|it)|when the user|whenever|trigger(?:s)? on|用于|当用户|应使用(?:本)?技能|适用于|触发词?[:：]?)[:\s]*([\s\S]+?)(?=$|do not use|don'?t use|not (?:for|when)|avoid (?:using|for)|改用|不适用)/i;
  const boundaryM = boundaryRe.exec(d);
  const whenM = whenRe.exec(d);
  const firstSentence = (d.split(/[.!?。！？]/)[0] || "").trim();
  return {
    trigger: new Set([...tokenize(whenM ? whenM[1] : ""), ...tokenize(firstSentence)]),
    boundary: new Set(tokenize(boundaryM ? boundaryM[1] : "")),
  };
}

const DISTRACTORS = [
  "write a haiku about the ocean",
  "explain the theory of relativity to me",
  "what is the capital of France",
  "help me draft a wedding toast",
  "translate this paragraph into German",
  "recommend a good mystery novel",
  "how do I boil an egg perfectly",
  "summarize this meeting transcript",
  "plan a two-week vacation in Japan",
  "write a sonnet about autumn leaves",
];

function cmdEvalInit(r, args) {
  const name = (r.fm.name || r.label).replace(/[^a-zA-Z0-9._-]/g, "-");
  const outFile = args[0] || `eval-${name}.json`;
  const trig = [...r.regions.trigger].slice(0, 10);
  const should = [];
  for (let i = 0; i < 10; i++) {
    should.push(trig[i] ? `auto — refine by hand: help me with ${trig[i]}` : `auto — refine by hand: task ${i + 1} that must trigger this skill`);
  }
  const shouldNot = [];
  for (let i = 0; i < 5; i++) shouldNot.push(DISTRACTORS[i]);
  const bnd = [...r.regions.boundary].slice(0, 5);
  for (let i = 0; i < 5; i++) {
    shouldNot.push(bnd[i] ? `auto — refine by hand: ${bnd[i]} (boundary case)` : DISTRACTORS[5 + i]);
  }
  const spec = {
    skill: r.label,
    content_hash: r.content_hash,
    note: "scaffold auto-generated from the description — REFINE EVERY QUERY BY HAND, then `lint.js eval run`",
    should_trigger: should,
    should_not_trigger: shouldNot,
  };
  fs.writeFileSync(outFile, JSON.stringify(spec, null, 2) + "\n");
  out(`scaffold written to ${outFile}`);
  out("next: refine the 20 queries by hand, then: node lint.js eval run <path-or-url> " + outFile);
}

// Chinese-majority queries: bigram filler dilutes the alignment ratio, so the
// pass bar is lower (live-calibrated: 0.3 separates real trigger queries from
// distractors where English 0.5 left every Chinese query failing)
const zhRatio = (s) => {
  const zh = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (s.match(/[a-zA-Z0-9]/g) || []).length;
  return zh / (zh + latin || 1);
};
const alignThreshold = (q) => (zhRatio(q) >= 0.3 ? 0.3 : 0.5);

function cmdEvalRun(r, args) {
  const evalFile = args.find((a) => a.endsWith(".json"));
  if (!evalFile) die("eval run: eval JSON file required (see `eval init`)");
  const spec = readJson(evalFile);
  assert(Array.isArray(spec.should_trigger) && spec.should_trigger.length >= 5, "eval: should_trigger needs >= 5 queries");
  assert(Array.isArray(spec.should_not_trigger) && spec.should_not_trigger.length >= 5, "eval: should_not_trigger needs >= 5 queries");
  const results = [];
  let passed = 0;
  for (const q of spec.should_trigger) {
    const toks = tokenize(q).filter((t) => !t.startsWith("auto"));
    const hit = toks.filter((t) => r.regions.trigger.has(t)).length;
    const alignment = round2(hit / Math.max(1, toks.length));
    const ok = toks.length > 0 && alignment >= alignThreshold(q);
    results.push({ cls: "should", q, ok, alignment });
    if (ok) passed++;
  }
  for (const q of spec.should_not_trigger) {
    const toks = tokenize(q).filter((t) => !t.startsWith("auto"));
    const boundaryHit = toks.some((t) => r.regions.boundary.has(t));
    const hit = toks.filter((t) => r.regions.trigger.has(t)).length;
    const alignment = round2(hit / Math.max(1, toks.length));
    const ok = boundaryHit || alignment < alignThreshold(q);
    results.push({ cls: "should_not", q, ok, alignment, boundaryHit });
    if (ok) passed++;
  }
  const rate = round2(passed / results.length);
  const jsonOut = process.argv.includes("--json");
  if (jsonOut) {
    out(JSON.stringify({
      trigger_rate: rate,
      n_queries: results.length,
      should_pass: results.filter((x) => x.cls === "should" && x.ok).length + "/" + spec.should_trigger.length,
      shouldnt_pass: results.filter((x) => x.cls === "should_not" && x.ok).length + "/" + spec.should_not_trigger.length,
      per_query: results,
      record_block: { trigger_eval: { rate, n_queries: results.length, ran_at: today() } },
      note: "text-alignment heuristic against the description regions — measures routing intent, not live model routing",
    }, null, 2));
    return;
  }
  out(`\n== trigger eval — ${r.label} ==`);
  for (const x of results) {
    out(`  ${x.ok ? "PASS" : "FAIL"}  ${x.cls.padEnd(10)} align=${x.alignment.toFixed(2)}${x.boundaryHit ? " (boundary)" : ""}  "${String(x.q).slice(0, 60)}"`);
  }
  out(`  trigger_rate: ${(rate * 100).toFixed(0)}%  (${passed}/${results.length})`);
  out("  record block for the ledger: {\"trigger_eval\": {\"rate\": " + rate + ", \"n_queries\": " + results.length + ", \"ran_at\": \"" + today() + "\"}}");
  if (rate < 0.6) out("  ! rate < 0.6 — description/routing needs rework before trusting this skill's trigger");
}

// -------------------------------------------------------------------- main --

function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const flags = argv.filter((a) => a.startsWith("--"));
  const json = flags.includes("--json");
  const minScoreIdx = flags.indexOf("--min-score");
  const minScore = minScoreIdx >= 0 ? Number(argv[argv.indexOf("--min-score") + 1]) : null;
  const cmd = args[0];

  (async () => {
    if (cmd === "conflicts") { cmdConflicts(args[1]); return; }
    if (cmd !== "check" && cmd !== "eval") {
      out("usage: lint.js check <path|--url <github-url>> [--json] [--min-score N]\n" +
          "       lint.js eval init <path|--url <github-url>> [outfile]\n" +
          "       lint.js eval run <path|--url <github-url>> <eval.json> [--json]\n" +
          "       lint.js conflicts [folder-of-skills]");
      process.exit(cmd === undefined ? 0 : 2);
    }
    const urlIdx = argv.indexOf("--url");
    const pathArg = cmd === "eval" ? args[2] : args[1];
    let r;
    if (urlIdx >= 0) {
      const remote = await fetchRaw(argv[urlIdx + 1]);
      r = lintSource(remote.raw, remote.label, null);
    } else if (pathArg) {
      const p = path.resolve(pathArg);
      const dir = fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p);
      const file = fs.statSync(p).isDirectory() ? path.join(p, "SKILL.md") : p;
      if (!fs.existsSync(file)) die(`no SKILL.md at ${file}`);
      r = lintSource(fs.readFileSync(file, "utf8"), path.basename(dir || file), dir);
    } else { die("provide a path or --url <github-url>"); }
    if (cmd === "eval") {
      const sub = args[1];
      if (sub === "init") cmdEvalInit(r, args.slice(3));
      else if (sub === "run") cmdEvalRun(r, args.slice(3));
      else die("eval: subcommand must be init or run — usage: lint.js eval init|run <path|--url …> [file]");
      return;
    }
    printReport(r, json);
    if (minScore !== null && r.score100 < minScore) {
      process.stderr.write(`FAIL: mechanical score ${r.score100} < gate ${minScore}\n`);
      process.exit(1);
    }
  })().catch((e) => die(e.message));
}

main(process.argv.slice(2));
