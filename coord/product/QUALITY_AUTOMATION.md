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
| Filing mechanism | `coord/scripts/gov open-followup` | The SAME governed mutation used to hand-file follow-ups. The generator shells out to it so every auto-filed ticket is validated, audit-logged, and prompt-covered like a manual one. |
| Entrypoint | `coord/scripts/gov quality-scan` / `node coord/scripts/quality-scan.js` | The runnable command wired to a cadence below. |

## Command

```
coord/scripts/gov quality-scan \
  [--apply] \
  [--root <dir>]               # repo/dir to scan        (default: this repo root)
  [--board <path>]             # board read for dedup     (default: coord/board/tasks.json)
  [--depends-on <ticket>]      # parent for prompt cover  (default: COORD-083)
  [--repo <code>]              # board repo code          (default: X)
  [--prefix <PREFIX>]          # auto-id prefix           (default: QSCAN)
  [--type <type>]              # ticket type              (default: refactor)
  [--severity-floor warn|fail] # which findings file      (default: fail; cadence uses warn)
  [--cap <n>]                  # max tickets per run      (default: 5)
  [--config <json>]            # arch-checks config override
```

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

**The cadence runs at `--severity-floor warn`** (not the ad-hoc `fail` default)
so it actually files the warn-class debt backlog — see the two-modes table
above. It pairs warn-floor with a small `--cap` (here `3`) so each run files a
**bounded batch**; the remainder is reported as `Capped (...)` and resurfaces on
the next run, highest-priority first. Dedup ensures a finding already filed is
not re-filed. This is what makes the auto-filer surface real debt steadily
instead of being a no-op (`fail` floor → 0 eligible on a warn-only board) or a
flood (warn floor with no cap).

### Option A — cron (self-hosted runner / ops box)

```cron
# Weekly Monday 06:00: scan the repo and file up to 3 warn-class debt tickets
# per run (the cadence mode — see the two-modes table above).
0 6 * * 1  cd /path/to/project && COORD_SESSION_ID=coord-quality-cron \
  coord/scripts/gov quality-scan --root . --severity-floor warn --cap 3 --apply \
  >> /var/log/coord-quality-scan.log 2>&1
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
      # Dry-run on PRs / manual; --apply only on the scheduled cadence and only
      # if your board mutations are committed back by a follow-up step.
      # Cadence floor is `warn` + a small cap (bounded batch) — see two-modes table.
      - name: quality-scan (dry-run)
        run: node coord/scripts/quality-scan.js --root . --severity-floor warn --cap 3
```

To actually file from CI, add `--apply`, set `COORD_SESSION_ID`, and commit the
resulting `coord/board/` changes back (the generator mutates board state via
`gov open-followup`, so the run must commit + push like any board change).

## Deferred

The ticket also mentioned optional hardcoding / dead-code detectors. The
arch-checks library (size/complexity/imports/duplication/monolith) is the
delivered core; additional detectors are tracked as a P3 follow-up rather than
silently dropped.
