# 相马经 · Scoring Model & Ledger Schema

> The ledger (相马经, "Horse-Judging Classic") is Argus's persistent quality
> database. It lives **inside this skill** (`data/`) and grows through field
> reports contributed by every real-world use. Scores are **never** derived
> from GitHub stars or install counts — those are recorded as `popularity`
> metadata only, for display.

This document is the single source of truth. `scripts/ledger.js` implements
exactly these rules; the agent applies them when judging on the spot.

---

## 1. File layout

```
data/
├── index.json                       # auto-generated, compact, read this FIRST
├── skills/<owner>/<repo>/<skill>.json   # one full record per skill
└── reports/<owner>/<repo>/<skill>/<timestamp>.json   # append-only evidence
```

- **Skill id** = `<owner>/<repo>/<skill>` (path segments must be filename-safe:
  `a-z0-9._-`, no empty segments, no `..`). The record path must match the id.
- Reports are **append-only**. Records are derived: field aggregates, `final`,
  and `confidence` are always recomputed by `ledger.js`, never hand-edited.

---

## 2. Record schema (`data/skills/**/*.json`)

```json
{
  "id": "anthropic/skills/pdf",
  "name": "pdf",
  "source": "github",
  "url": "https://github.com/anthropics/skills",
  "description": "One-line summary copied from the skill's own frontmatter.",
  "best_for": ["pdf", "merge", "forms", "extraction"],
  "popularity": {
    "stars": null,
    "installs": null,
    "checked_at": "2026-11-18"
  },
  "static": {
    "trigger": 5,
    "structure": 5,
    "actionability": 5,
    "safety": 5,
    "portability": 5,
    "notes": ["short evidence-backed remarks, one per noteworthy dimension"],
    "safety_flags": [],
    "evaluator": "seed-static",
    "evaluated_at": "2026-11-18"
  },
  "field": {
    "effectiveness": 4.5,
    "efficiency": 3.5,
    "reliability": 4.5,
    "n_reports": 2
  },
  "conflict_events": [],
  "final": 88,
  "confidence": 0.5,
  "history": [
    {
      "at": "2026-11-18",
      "event": "seed",
      "final": 88,
      "confidence": 0.5,
      "n_reports": 2,
      "note": "why the score changed"
    }
  ],
  "reports": ["anthropic/skills/pdf/2026-11-10T09-30-00.json"],
  "updated": "2026-11-18"
}
```

Field rules:

| Field | Type | Rules |
|---|---|---|
| `id` | string | kebab-ish path, must equal path-derived id |
| `source` | enum | `github` \| `skills.sh` \| `skillsmp` \| `clawhub` \| `manual` \| `unknown` |
| `best_for` | string[] | 2–8 lowercase keywords; the index is grepped on these |
| `popularity` | object | optional; **display metadata only — never an input to any score** |
| `static.*` | int 1–5 | the five rubric dimensions (see `rubric.md`); `null` until first static evaluation |
| `static.safety_flags` | string[] | non-empty ⇒ red-line alert, see §6 |
| `static.evaluator` | string | provenance: `seed-static`, `mechanical-lint` (then judgment must review it), `session-2026-11-18T14-05-00Z`, … |
| `field.*` | number 1–5 | means over reports, 2 decimals; `0` when `n_reports` is 0 |
| `conflict_events` | string[] | `reported_at` stamps of reports whose effectiveness clashed with the pre-existing aggregate (§5); persists the penalty so it is reproducible |
| `final` | int 0–100 | derived, see §4 |
| `confidence` | number 0–1 | derived, 2 decimals, see §5 |
| `history[].event` | enum | `seed` \| `static-eval` \| `report-added` \| `recompute` \| `score-conflict` |
| `reports[]` | string[] | report paths **relative to `data/reports/`** |
| `updated` | date | `YYYY-MM-DD`, auto-set on every mutation |

---

## 3. Report schema (`data/reports/**/*.json`)

One real-world use of a skill. Written by the agent after the user actually
used the recommended skill; merged with `node scripts/ledger.js add <file>`.

```json
{
  "id": "anthropic/skills/pdf",
  "reported_at": "2026-11-10T09-30-00",
  "task": "Merge 12 scanned PDFs and extract the invoice table",
  "verdict": "worked",
  "scores": { "effectiveness": 5, "efficiency": 4, "reliability": 5 },
  "evidence": "What actually happened, concretely. Required.",
  "environment": { "agent": "zcode", "os": "win32" },
  "reporter": "anonymous"
}
```

| Field | Rules |
|---|---|
| `id` | must match an existing record id, or `add` will create a skeleton record (then a static evaluation is due) |
| `reported_at` | `YYYY-MM-DDTHH-mm-ss`, filename-safe (no colons) |
| `verdict` | `worked` \| `partial` \| `failed` |
| `scores.*` | int 1–5. `effectiveness` = did it achieve the task; `efficiency` = token/time cost vs doing it manually; `reliability` = worked without manual rescue |
| `evidence` | non-empty, concrete (what was attempted, what happened). Vague reports are rejected |
| `reporter` | GitHub handle or `anonymous` |

A `failed` verdict is as valuable as a `worked` one — never soften evidence.

---

## 4. Final score (0–100)

```
static_100 = mean(trigger, structure, actionability, safety, portability) × 20
field_100  = mean(effectiveness, efficiency, reliability) × 20

final = round( 0.4 × static_100 + 0.6 × field_100 )   if n_reports > 0
final = round( static_100 )                            if n_reports = 0  (provisional)
final = round( field_100 )                             if static = null  (field-only)
final = 0                                              if static = null AND n_reports = 0
```

The 0.6 weight on field data is deliberate: **real-world results outweigh
static prose analysis**. A skill with only static evaluation is provisional.

**Pending entries** (imported from external catalogs, never yet evaluated)
carry `static: null`, `n_reports: 0`, `final: 0`, `confidence: 0` — visible
in the index as *unevaluated*, never mistaken for a real score.

**Letter grades** (display only, scale borrowed from joeynyc/skillscore):

| A+ | A | A- | B+ | B | B- | C+ | C | C- | D | D- | F |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ≥97 | 93–96 | 90–92 | 87–89 | 83–86 | 80–82 | 77–79 | 73–76 | 70–72 | 65–69 | 60–64 | <60 |

## 5. Confidence (0–1)

```
base        = 0.3 + 0.1 × n_reports            (cap 0.95)
disagreement: if n_reports ≥ 2 and population stddev of per-report
              effectiveness ≥ 1.0  →  confidence ×= 0.80
conflict:    on add, a report whose effectiveness differs from the
             pre-existing aggregate by ≥ 2 is recorded in `conflict_events`;
             every such event  →  confidence ×= 0.85
staleness:   `recompute` only — if updated is > 180 days old
              →  confidence ×= 0.90
field-only:  if static = null, cap confidence at 0.70
```

Confidence is a **pure function of the stored data** (static, reports,
`conflict_events`, dates) — `validate-all` recomputes it and rejects any
drift. Nothing about the score is remembered outside the record.

Interpretation: `< 0.4` provisional — re-verify on the spot before trusting;
`0.4–0.7` usable with caveats; `> 0.7` battle-tested.

## 6. Safety red lines (overrides everything)

If the static evaluation finds any red-line pattern from `rubric.md §D-0`
(prompt injection, data exfiltration, obfuscated/destructive commands, or
an install-time script doing more than declared):

1. `static.safety ≤ 2`, `safety_flags` lists the concrete findings
2. `final` is capped at `40` regardless of other dimensions
3. The skill must not be recommended silently — surface the flag, warn the
   user, and suggest a deeper scan with
   [cisco-ai-defense/skill-scanner](https://github.com/cisco-ai-defense/skill-scanner)

## 7. Provenance & honesty

- `evaluator` marks who scored: `seed-static` for the original seed entries,
  `mechanical-lint` for a baseline produced by `scripts/lint.js` (must be
  reviewed with judgment before it is trusted), `session-<timestamp>` for
  live evaluations.
- Seed records are illustrative examples of the schema — their static scores
  are documented static readings of the SKILL.md text, not community verdicts
  (hence low confidence).
- Never invent reports. A report is written only after a real use. A report
  with empty or generic `evidence` must be rejected.

## 8. Borrowed databases, upgraded (import pipeline)

`scripts/import.js` pulls candidate skills from existing catalogs into the
ledger as **pending** entries:

```bash
node scripts/import.js skillsmp --creator anthropics --limit 5   # SkillsMP REST API
node scripts/import.js skills-sh "playwright" --top 5            # skills.sh CLI output
node scripts/import.js pending                                    # list unevaluated entries
```

The design rule: **borrow coverage, never borrow rankings.** External
catalogs (SkillsMP, skills.sh, ClawHub) supply three things and only three:

1. **Discovery** — what exists at all
2. **Identity** — canonical `owner/repo/skill` ids and URLs
3. **Popularity metadata** — installs/stars, stored under `popularity` for
   display only

Everything else about a skill is re-derived here: the entry lands as
`final: 0, confidence: 0` (pending) and must pass the mechanical lint plus
judgment (`rubric.md`) before it can influence a recommendation. Import caps
(`--limit`, `--top`) keep the ledger a curated shortlist, not a catalog dump.
