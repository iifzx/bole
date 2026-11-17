# Search Sources & Fallback Order

How to find candidate skills for a task. Work through the tiers in order;
each tier narrows nothing for the next — a candidate found anywhere still
goes through the same scoring (`rubric.md`) before being recommended.

Registry rankings (installs, stars) are **discovery hints only**. Everything
is re-judged by Argus before it reaches the user.

## Tier 1 — The ledger (always first)

Read `data/index.json` (compact; grep on `name` and `best_for`). A ledger hit
gives you score + confidence + evidence instantly, and every entry here has
already survived static evaluation.

- `confidence ≥ 0.4` → use directly, show evidence.
- `confidence < 0.4` → candidate is promising but unproven: verify on the spot
  (re-run the rubric) and prepare a ledger update via the REPORT workflow.

## Tier 2 — skills.sh registry (primary external source)

`npx skills find "<keywords>"` — the [skills.sh](https://skills.sh) CLI
(Vercel). Search with **precision-first keyword tiers**, exact before broad:

1. **Exact match** — the domain term itself (`"pdf"`, `"playwright"`)
2. **Functional match** — the verb/outcome (`"merge tables"`, `"extract invoices"`)
3. **Domain match** — the surrounding field (`"document processing"`)

Broaden only when a tier returns fewer than 3 candidates. First run downloads
the package; if `npx` is unavailable or the network is blocked, fall back to
Tier 3.

## Tier 3 — Web search (fallback & coverage)

Use whatever web tools the session offers (WebSearch / WebFetch):

- [skillsmp.com](https://skillsmp.com) — GitHub-crawled skills search engine
- [github.com/topics/agent-skills](https://github.com/topics/agent-skills) — GitHub topic index
- [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) — curated catalog (human-PR curation ≈ a weak prior, not a score)
- ClawHub — OpenClaw community hub

## Never search by popularity

`stars`, `installs`, and "trending" are recorded as `popularity` metadata on
the record and shown to the user as *reference only*. They never enter
`final` or `confidence`.

## Mechanism credit

The task-decomposition + keyword-tier search + candidate-matrix workflow is
adapted and extended from
[agentscope-ai/OpenJudge · find-skills-combo](https://github.com/agentscope-ai/OpenJudge/blob/main/skills/find-skills-combo/SKILL.md)
— with the key difference that candidate evaluation is grounded in a
persistent, evidence-backed ledger instead of per-session improvisation.
