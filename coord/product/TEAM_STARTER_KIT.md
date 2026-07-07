# Team Starter Kit

Status: starter kit / repeatable team onboarding
Owner: Softsensor
Audience: a team lead or operator standing up a coord board for the first time.

This is the **repeatable package** for getting one team onto governed work. It
assembles pieces that already exist (init, config, agent shims, the readiness
command, the cockpit) into one golden path, plus the two things newcomers always
need: **how to file a governed ticket** and **how to recover** when something
sticks. Every command here is copy/paste; nothing in this doc mutates state by
itself.

Related: `coord/GOVERNANCE.md` (the law), `SOFTSENSOR_ROLLOUT.md` (which boards to
stand up first), `QUICKSTART.md` (the 5-minute tour).

---

## 0. Prerequisites

- Node `>=22.8` (`node -v`).
- The team's git repos (the product cluster this board will govern).
- An identity to act as (corporate SSO for the read UI; a coord agent handle for
  governed mutations — see §4).

## 1. Stand up the board

```bash
# from the donor template
bash /path/to/coord-template/init.sh        # bootstrap a new project from the template
```

Then declare the team's product repos in `coord/project.config.js` (the `repos`
map: code, path, integration branch). One coord board governs one product family;
list only that family's active repos.

Verify the workspace is sane:

```bash
coord/scripts/gov conform        # journal hash-chain PASS
coord/scripts/gov verify-engine  # engine pin IN-SYNC (re-pin only after intentional engine changes)
```

## 2. Map your team

- **Repos** — `coord/project.config.js` `repos` (each gets a one-letter code; `X`
  is coord itself).
- **People** — identity comes from your corporate directory (SSO) for the read UI.
  Developers additionally bind a coord agent handle before any governed mutation
  (§4). Non-developers (BA, manager, analyst) use the read UI only.

## 3. Track gate defaults

Each board's work runs under a track (development, marketing, devops,
product-engineering, data-analytics) that sets the default gate lane. Keep the
template defaults to start; tighten per track later. See
`MULTI_TRACK_GOVERNANCE_PROFILE.md`.

## 4. File your first governed ticket (the golden path)

This is the loop every piece of governed work follows. Do it once by hand so the
team has the muscle memory.

```bash
# 0) one-time per session: bind an agent identity
coord/scripts/gov agentid --assign            # auto-claims a free handle, e.g. claudea255
#    (or) coord/scripts/gov claim --owner <handle>

# 1) file the ticket (atomic, journaled; no prompt/parent required)
coord/scripts/gov file-ticket --repo <code> --type <feature|bug|chore|docs|refactor> \
  --pri <P0|P1|P2|P3> --description "<what + why>"

# 2) make it start-ready, then start (creates an ISOLATED worktree + branch)
coord/scripts/gov set-waiver <ID> --reason "<why no start-ready prompt>"   # or add --with-prompt at file time
coord/scripts/gov start <ID>

# 3) do the work IN the worktree it printed, then commit through gov
coord/scripts/gov commit <ID> --message "<conventional commit message>"

# 4) record closeout evidence (the gate checks these)
coord/scripts/gov update-plan <ID> --repo-gate "not-required"   # or the executed gate result
coord/scripts/gov set-review-cycles <ID> \
  --review-cycle "lens=<lens>; diff=<what changed>; risks=<risk 1>, <risk 2>; findings=<none|finding>; verification=<command>; verdict=pass" \
  --review-cycle "lens=<lens 2>; diff=...; risks=..., ...; findings=none; verification=...; verdict=pass" \
  --review-cycle "lens=<lens 3>; diff=...; risks=..., ...; findings=none; verification=...; verdict=pass"

# 5) finalize (repo-X / coord-owned closes locally with --no-pr)
coord/scripts/gov finalize <ID> --no-pr --source-commit <sha> --landed "<evidence>"
```

Gate gotchas (front-load these to avoid iteration):
- **≥3 review cycles**, each with `risks=` naming **at least two** concrete failure
  modes; the **final cycle must `verdict=pass`**.
- If the work touches a **business-sensitive area** (billing, schema meaning,
  workflow, permissions, compliance, "enterprise/release" wording…), the gate also
  wants a disposition. For genuinely non-behavioral work:
  `gov update-plan <ID> --invariant "business-context investigation: not-required"`
  (the status keyword — `not-required` — must come **right after the colon**).
- If it touches an **architecture/auth/data/contract decision surface**, add
  `gov update-plan <ID> --invariant "decision status: not-required"` and an ADR-
  compliance review cycle that ends with the literal `new ADR: not required`.

### First-ticket templates

```bash
# A. small feature
gov file-ticket --repo F --type feature --pri P2 \
  --description "[<area>] <user-visible capability>. Acceptance: <observable proof>."

# B. bug
gov file-ticket --repo B --type bug --pri P1 \
  --description "[<area>] <symptom> when <trigger>. Expected <X>, got <Y>. Repro: <steps>."

# C. docs / chore
gov file-ticket --repo X --type docs --pri P3 \
  --description "[docs] <what doc> — <gap being closed>."
```

## 5. Check readiness

```bash
coord/scripts/coord doctor --dir . --json --output coord/.runtime/readiness-report.json
```

Then open the cockpit's **`/onboarding`** and **`/readiness`** views — they show the
"ready for governed work?" verdict, the setup checklist, and any pilot blockers,
without you parsing JSON.

## 6. The cockpit (coord-ui)

A read-only window the whole team opens — **no install for non-developers**. Host
it once and share the URL: `https://coord.<team>.<host>` (set per deployment).
The nav is grouped so a newcomer can self-serve:

- **Work** — board, dispatch, pipeline, timeline, triage.
- **Proof** — gates, tests, evidence, traceability, quality.
- **Knowledge** — URS, requirements, ADRs (decisions), screens.
- **Fleet** — agents, runtime, git, cost.
- **Risk** — live-MCP, bootstrap-risk, issues, waivers.
- **Setup** — onboarding, readiness, release, configuration, health.

The home page is an **action center**: what needs attention now, blocked tickets,
fleet status, proof/release state, next safe work, onboarding progress.

## 7. How to recover

The cockpit is read-only; recovery is run from the CLI by the ticket owner (or a
human admin). Match the situation:

| Situation | Command |
|---|---|
| Resuming your own in-flight ticket in a new session | `gov resume <ID>` |
| "ambiguous identity" / lost session binding | `gov claim --owner <handle>` (or `gov agentid --assign`) |
| Two agents fighting one handle | `gov agent-rebind --fresh` |
| Started the wrong ticket (no work yet) | `gov unstart <ID>` |
| Stale lock blocking a ticket | `gov lock-abandon <ID>` |
| Drift between board and journal you accept | `gov reconcile [<ID>] --reason "<why>"` |
| Board row looks wrong; rebuild from the journal | `gov recover <ID>` / `gov rebuild-board` |
| Diagnose everything (read-only) | `gov doctor` |
| Apply safe repairs | `gov doctor --fix` |
| Crossed journal hash-chain (concurrent shared-checkout writes) | `gov repair-chain --confirm --reason "<why>"` |

Golden rules:
- **One governed agent per checkout**, or give each agent its own worktree +
  `coord/.runtime` (run `gov start`, which isolates automatically).
- Never hand-edit `coord/board/tasks.json`, the journal, or plan records — the
  out-of-band seal will trip. Use `gov` verbs, or `gov reconcile` to accept a
  deliberate manual change.
- After any canonical engine change, re-stamp the manifest and `gov verify-engine
  --pin` (re-pin) — otherwise `verify-engine` reports drift.

## 8. Where next

- `coord/GOVERNANCE.md` — the authoritative policy.
- `SOFTSENSOR_ROLLOUT.md` — which boards to stand up first (Board 0 dogfood →
  first adopter pilot → expand).
- `MULTI_TRACK_GOVERNANCE_PROFILE.md` — per-track gate procedures.
- `coord/docs/MULTI_AGENT_TOPOLOGIES.md` — running many agents safely.
