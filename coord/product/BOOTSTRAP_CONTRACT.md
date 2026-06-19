# Repo Bootstrap Contract

This is the canonical contract that each governed repo (`backend`, `frontend`,
and any additional product repos registered in `coord/project.config.js`) must satisfy
before substantive feature work begins in a derived project.

This file is deliberately language-neutral. It defines **what** each repo must
expose, not **which** stack provides it. Derived projects choose their stack
when they fill the contract in.

## Why this exists

`coord/` is the governance control plane. It must invoke each governed repo's
quality gates and trust each repo's environment loading without knowing the
underlying stack. The contract below is the minimum interface that makes that
possible.

## Contract Surface

Each governed repo must satisfy three things:

1. **Environment loading** — a documented, secret-free way to feed
   configuration to the repo at run time.
2. **Quality gate runner** — a uniform shell entry point that runs the lanes
   governance expects.
3. **Initial project layout** — a minimum directory skeleton governance and
   sibling repos can rely on.

## 1. Environment Loading

Each governed repo must:

- Commit a `.env.example` at the repo root listing every environment variable
  the repo reads, with a placeholder value and a one-line comment.
- Gitignore `.env` (and any local-only variants such as `.env.local`).
- Load environment in this precedence:
  1. CI / host-process environment (highest priority)
  2. `.env`
  3. `.env.defaults` (committed, non-secret defaults)
  4. Code-level fallbacks (lowest priority)
- Never commit real secrets, real credentials, real production hostnames, or
  real API tokens to any committed env file.

Loader choice (`dotenv`, `direnv`, framework-native loader, custom shim) is a
per-project decision. The contract is the **precedence and discipline**, not
the loader.

## 2. Quality Gate Runner

Each governed repo must expose a single entry point at `scripts/gate.sh`:

```
scripts/gate.sh <lane>
```

Where `<lane>` is one of:

| Lane      | When governance invokes it                                        |
| --------- | ----------------------------------------------------------------- |
| `default` | Before every `doing -> review` transition (per repo)              |
| `full`    | Before landing, or when `default` is insufficient for the change  |
| `ci`      | In CI pipelines for the same repo                                 |

Dependency/security audit signal (QGATE-002, COORD-076):

- The `full` and `ci` lanes run a dependency/security audit (`npm audit`). It is
  intentionally NOT in `default` (kept fast). The pass/warn/fail policy is
  single-sourced in `coord/scripts/audit-policy.js`; the runner shells out to
  `node coord/scripts/audit-policy.js classify` so the threshold logic is defined
  once, not re-implemented in bash.
- Threshold is config-driven via the `GATE_AUDIT_THRESHOLD` env var (default
  `high`): vulnerabilities at or above the threshold FAIL the gate; lower
  severities WARN (printed, non-blocking).
- The step degrades gracefully: when there is no npm lockfile, no `npm` on PATH,
  or no audit output (offline registry), it prints a SKIP note and does not fail.
  This keeps zero-dependency / minimal repos green while still inheriting the
  step. Derived repos with a non-npm stack swap in their own audit command.
- The audit summary line (`audit: <result> threshold=<sev> total=N (...)`) is a
  governed gate SIGNAL: record it on the repo_gates entry via
  `gov add-repo-gate --audit "<summary>"`.

Runtime contract:

- Exit code 0 = pass. Any non-zero exit code = fail. Governance treats failed
  gates as blocking.
- Output to stdout/stderr must be actionable: name what failed, name how to
  reproduce.
- The runner must be non-interactive: no prompts, no TTY assumptions.
- Optional artifacts (coverage, reports, logs) land under
  `coord/artifacts/gates/<repo>/`. That directory is ephemeral and
  gitignored — the runner creates it on demand.
- Skeleton implementations in this template intentionally exit non-zero with a
  "not implemented" message so derived projects cannot mistake a placeholder
  for a working gate.

## 3. Initial Project Layout

Each governed repo starts with the following directory skeleton:

```
<repo>/
├── AGENTS.md          ← repo-local agent guidance (already present)
├── BOOTSTRAP.md       ← per-repo checklist referencing this contract
├── README.md          ← repo overview
├── .env.example       ← committed env template
├── src/               ← product source
├── tests/             ← test source
├── scripts/           ← repo-local operator scripts (incl. gate.sh)
└── config/            ← non-secret configuration
```

Stack-specific manifests (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`,
etc.) are added by the derived project when it picks its stack. The skeleton
above is what governance and sibling repos rely on regardless of stack.

## Governance Integration

This contract is referenced by:

- `coord/product/LOCAL_AUTOMATION_AND_GATES.md` — for gate runner invocation
  details.
- `coord/product/TESTING_AND_GATES.md` — for the policy-level gate definitions.
- `<repo>/BOOTSTRAP.md` files — for the per-repo checklist that derived
  projects fill in.

When a derived project tailors the scaffold, it should:

1. Replace the skeleton `scripts/gate.sh` in each repo with a real runner.
2. Populate `.env.example` with the real variable list.
3. Add stack-specific manifests and source files under `src/` and `tests/`.
4. Update `<repo>/BOOTSTRAP.md` to record what was filled in versus what
   remains stubbed.
