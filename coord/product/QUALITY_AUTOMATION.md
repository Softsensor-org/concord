# Code-Quality Automation (COORD-083)

The capstone of the QGATE series. This automates the manual
audit -> file-tickets workflow that produced COORD-064..082: a schedulable
coord audit runs the static code-quality checks against a repo and **auto-files
governed quality tickets** onto the board on a cadence — with dedup, a flood
cap, and a dry-run-by-default safety model.

## Pieces

| Piece | Location | Role |
|---|---|---|
| Check library | `coord/scripts/arch-checks.js` (COORD-078) | The analysis engine: size / complexity / imports / duplication / monolith. Reused as-is. |
| Scan runner + generator | `coord/scripts/quality-scan.js` (COORD-083) | Runs the library over a target repo, normalizes findings into proposed tickets, dedups, and files them. |
| Filing mechanism | `coord/scripts/gov open-followup` (default) or `gov file-ticket --status proposed` (`--propose`) | The SAME governed mutations used to hand-file. The generator shells out so every auto-filed ticket is validated and audit-logged like a manual one. `--propose` routes through the COORD-285 single-writer create path so debt lands in the approval-gated **quarantine** (see below). |
| Entrypoint | `coord/scripts/gov quality-scan` / `node coord/scripts/quality-scan.js` | The runnable command wired to a cadence below. |
| Single-shot cadence runner | `coord/scripts/quality-propose-cron.js` (COORD-286) | A DELIBERATELY THIN trigger that runs scan-and-propose **once** in the cadence shape (`--severity-floor warn --cap N --apply --propose`). NOT a daemon — the cadence is owned by whatever schedules it (crontab / GH-Actions). Mirrors the COORD-243 detect/do/**trigger** split. |

## Command

```
coord/scripts/gov quality-scan \
  [--apply] \
  [--propose]                  # file as quarantined `proposed` (alias: --status proposed)
  [--root <dir>]               # repo/dir to scan        (default: this repo root)
  [--board <path>]             # board read for dedup     (default: coord/board/tasks.json)
  [--depends-on <ticket>]      # parent for prompt cover  (default: COORD-083)
  [--repo <code>]              # board repo code          (default: X)
  [--prefix <PREFIX>]          # auto-id prefix           (default: QSCAN)
  [--type <type>]              # ticket type              (default: refactor)
  [--severity-floor warn|fail] # which findings file      (default: fail; cadence uses warn)
  [--cap <n>]                  # max tickets per run      (default: 5)
  [--status todo|proposed]     # explicit form of --propose (default: todo)
  [--config <json>]            # arch-checks config override
```

### Filing status — `--propose` (the quarantine, COORD-286)

By default the generator files **`todo`** tickets via `gov open-followup` —
straight into open work. With **`--propose`** (alias `--status proposed`) it
routes through the COORD-285 single-writer create path
`gov file-ticket --status proposed`, so the auto-generated debt lands in the
approval-gated **`proposed` quarantine** instead of the backlog. A `proposed`
ticket is **not** open/actionable work (it is excluded from next/ready/gap
counts and `gov start` refuses it). A human triages it:

- `gov approve <id>` — promote `proposed -> todo` (it becomes real work).
- `gov reject <id> --reason "<why>"` — decline `proposed -> superseded`.

**This is the recommended cadence mode:** machine-proposed debt should be
human-approved before it competes for scheduling. Dedup is status-agnostic — the
`[qkey:...]` marker counts `proposed` rows too — so re-running the cadence does
**not** double-file a proposal already sitting in the queue (idempotent). Only a
`done` fix or a `reject`ed (`superseded`) proposal frees a key to be re-proposed.

## Safety model (read before `--apply`)

- **Dry-run is the default.** Without `--apply`, the command prints exactly what
  it WOULD file and mutates nothing. Always dry-run first.
- **Dedup.** Before filing, the runner reads the board and collects the stable
  finding keys recorded in every OPEN (non-`done` / non-`superseded`) ticket's
  description via a machine marker `[qkey:<key>]`. A finding whose key already
  has an open ticket is skipped. The same scan run twice files nothing the
  second time. Within a single run, two findings that collapse to one key file
  once.
  - The **stable key** is `check:file:normalized-detail` and deliberately
    ignores volatile measured values (e.g. the exact LOC count) so a file that
    grew from 1700 to 1750 LOC is still the *same* issue, not a new ticket.
- **Cap.** At most `--cap` tickets are filed per run (default 5). The remainder
  is reported as `Capped (...)` — never silently dropped — and resurfaces on the
  next run (higher-priority findings are filed first).
- **Severity floor.** Only findings at or above `--severity-floor` (default
  `fail`) are eligible. Lower-severity findings are reported as `below-floor`.

### Severity floor — the two intended modes (read this)

arch-checks is **warning-first**: size / complexity / duplication / monolith /
hardcoding / deadcode all default to severity `warn`. `fail` severity is reserved
for *escalated* findings (e.g. a hard-budget breach configured to fail). This
produces two deliberate modes for quality-scan, and the distinction matters:

| Mode | Floor | Files | When to use |
|---|---|---|---|
| **Ad-hoc / interactive** (DEFAULT) | `fail` | Only escalated, fail-severity findings | A human running the scan by hand. The conservative default does **not** mass-file the warn-class debt backlog and surprise the caller. On a board whose debt is all warn-class, the default floor files **nothing** — by design. |
| **Cadence** (scheduled) | `warn` | warn-class debt too (the real residual backlog) | The periodic/CI run. This is what actually surfaces the backlog, in **bounded batches** via a small `--cap`. |

> **Why the default is `fail`, not `warn`:** flipping the global default to `warn`
> would make an innocent interactive `quality-scan --apply` dump the entire
> warn-class backlog onto the board. The default stays conservative; the
> cadence opts in to `--severity-floor warn` explicitly. The `--cap` + dedup
> (skippedOpen / skippedInRun) are what keep the warn-floor cadence from
> flooding or repeating: capped findings resurface on the next run, and
> already-filed ones are skipped.

### Severity -> priority mapping

| Finding | Default priority |
|---|---|
| `fail` severity | P2 |
| `warn` severity | P3 |
| `monolith` check | P2 (even at `warn` — architectural risk) |

## Cadence — how to schedule it

This ships a **schedulable command**, not a daemon. Wire it to whatever
scheduler the deployment already uses. Run dry-run first; only enable `--apply`
once the dry-run output looks sane for the target repo.

**The cadence runs at `--severity-floor warn --propose`** (not the ad-hoc `fail`
default, and into the **quarantine** rather than open work) so it surfaces the
warn-class debt backlog for human approval — see the two-modes table and the
`--propose` section above. It pairs warn-floor with a small `--cap` (here `3`)
so each run files a **bounded batch**; the remainder is reported as `Capped (...)`
and resurfaces on the next run, highest-priority first. Dedup (counting
`proposed` rows) ensures a finding already proposed is not re-filed. This is what
makes the auto-filer surface real debt steadily instead of being a no-op (`fail`
floor → 0 eligible on a warn-only board) or a flood (warn floor with no cap).

> **Then a human triages the queue.** Each scheduled run only *proposes*. Review
> the `proposed` tickets and either `gov approve <id>` (→ `todo`, real work) or
> `gov reject <id> --reason "<why>"` (→ `superseded`). Nothing the cadence files
> enters open work without that explicit approval. (A read-only triage view of
> the queue is tracked separately — see the board.)

There is **no live scheduler** in this template (public CI was removed). The
trigger is the thin single-shot runner `coord/scripts/quality-propose-cron.js`
(runs the cadence shape once) plus the recipes below — wire ONE of them to
whatever scheduler the deployment already runs.

### Option A — cron (self-hosted runner / ops box)

```cron
# Weekly Monday 06:00: scan the repo and PROPOSE up to 3 warn-class debt tickets
# per run (the cadence mode — quarantined, awaiting human approve/reject).
# Either invoke the gov verb directly:
0 6 * * 1  cd /path/to/project && COORD_SESSION_ID=coord-quality-cron \
  coord/scripts/gov quality-scan --root . --severity-floor warn --cap 3 --apply --propose \
  >> /var/log/coord-quality-scan.log 2>&1

# ...or call the single-shot runner (same cadence shape, --apply --propose baked in):
# 0 6 * * 1  cd /path/to/project && COORD_SESSION_ID=coord-quality-cron \
#   node coord/scripts/quality-propose-cron.js >> /var/log/coord-quality-scan.log 2>&1
```

### Option B — GitHub Actions scheduled workflow

Add `.github/workflows/quality-scan.yml`:

```yaml
name: quality-scan
on:
  schedule:
    - cron: '0 6 * * 1'   # Mondays 06:00 UTC
  workflow_dispatch: {}    # manual trigger for ad-hoc dry-runs
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      # Dry-run on PRs / manual; --apply --propose only on the scheduled cadence
      # and only if your board mutations are committed back by a follow-up step.
      # Cadence floor is `warn` + a small cap (bounded batch) — see two-modes table.
      - name: quality-scan (dry-run)
        run: node coord/scripts/quality-scan.js --root . --severity-floor warn --cap 3 --propose
```

To actually file from CI, add `--apply` (or call
`node coord/scripts/quality-propose-cron.js`, which bakes in
`--apply --propose`), set `COORD_SESSION_ID`, and commit the resulting
`coord/board/` changes back (the generator mutates board state via the governed
create path, so the run must commit + push like any board change). The cadence
files **`proposed`** tickets — a human still runs `gov approve` / `gov reject`
on the queue before any of it becomes open work.

## Deferred

The ticket also mentioned optional hardcoding / dead-code detectors. The
arch-checks library (size/complexity/imports/duplication/monolith) is the
delivered core; additional detectors are tracked as a P3 follow-up rather than
silently dropped.
