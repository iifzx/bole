# Contributing to 伯乐 · Argus

The most valuable contribution is not code — it's a **field report** (实测
报告): install a skill, use it for real, and tell the ledger what actually
happened. `failed` reports are as welcome as `worked` ones; they are exactly
what turns scores from "looks good" into "works well".

## 0. Prerequisites

- Node.js ≥ 18 (the ledger CLI is dependency-free)
- A GitHub account (for the PR)

## 1. Submit a field report (the flywheel)

### a. Trigger Argus's REPORT mode

After using a skill, tell your agent:

> 报告一下这个 skill 的使用效果 / submit a field report for `<owner/repo/skill>`

The agent interviews you (task, outcome, three 1–5 scores, concrete
evidence), writes the report JSON, and merges it:

```bash
node argus/scripts/ledger.js add <report.json>
```

The command validates the schema, relocates the report into
`argus/data/reports/<id>/`, recomputes `final` and `confidence` from all
reports, rebuilds `index.json`, and moves the source file away (nothing left
behind).

### b. Or do it fully by hand

Create `argus/data/reports/<owner>/<repo>/<skill>/<YYYY-MM-DDTHH-mm-ss>.json`
following the schema in [`argus/references/scoring.md`](argus/references/scoring.md)
§3, then run `node argus/scripts/ledger.js recompute` to fold it in.

### c. Send it upstream

```bash
git checkout -b ledger/<skill-name>-$(date +%F)
git add argus/data
git commit -m "ledger: field report for <owner/repo/skill>"
git push -u origin <branch>
# then open a Pull Request on GitHub
```

CI validates every PR that touches `argus/data/**`: schema validation plus an
`index.json` sync check (`build-index --check`). If CI is red, run
`node argus/scripts/ledger.js validate-all && node argus/scripts/ledger.js build-index`
locally and commit the regenerated index.

## 2. Report quality bar

- `evidence` must be concrete — what you attempted, what happened. Generic
  praise ("works great") is rejected by validation (min 10 chars, and reviewers
  will bounce vague prose).
- Never fabricate a report. One report = one real use.
- Don't soften failures. A `failed` verdict with good evidence is more useful
  than a polite `partial`.
- One report per distinct use; duplicate `reported_at` filenames are rejected.

## 3. Re-evaluating an existing score (static)

Pending entries (`import.js` imports, `final: 0`) and stale scores both need
this flow. Run the mechanical lint + rubric:

```bash
node argus/scripts/lint.js check --url https://github.com/<owner>/<repo>/tree/main/<skill>
# review the suggested_patch with judgment (references/rubric.md Phase 0),
# then register the merged evaluation:
node argus/scripts/ledger.js static <patch.json>
```

Set `evaluator` to something identifiable (`session-<timestamp>` or your
handle — a `mechanical-lint` baseline registered without judgment review is
considered a bug). If you find a §D-0 red-line pattern, record it in
`safety_flags` — the score caps itself at 40 and the flag becomes a loud
warning for everyone.

## 4. Ledger governance

- Derived fields (`field`, `final`, `confidence`, `reports`, `index.json`)
  are **never hand-edited** — `validate-all` recomputes and rejects drift.
  Run `recompute` instead.
- `popularity` (stars/installs) is display metadata only. It must never be
  an input to any score; a PR mixing popularity into scoring will be rejected.
- Records and reports live in `argus/data/` and are versioned with the repo —
  the ledger *is* the repository.

## 5. Improving the skill itself

Changes to `SKILL.md`, `references/`, or `scripts/` are regular PRs. Keep the
body of `SKILL.md` under ~300 lines (progressive disclosure into
`references/`), keep `ledger.js` dependency-free, and keep
`references/scoring.md` as the single source of truth for any formula change.
