# Contributing to Concord

Thanks for your interest in improving **Concord** — governed multi-agent
coordination for multi-repo teams. Concord is open source under the
[Apache License 2.0](./LICENSE), and contributions are welcome from anyone.

Contribution is **voluntary**. You are never obligated to contribute your
changes upstream, and the project does not require you to. If you *do* choose to
send a change, this document explains how, and the lightweight terms that apply.

## Ground rules

- Be respectful. All participation is governed by our
  [Code of Conduct](./CODE_OF_CONDUCT.md).
- Discuss large or breaking changes in an issue before opening a pull request,
  so we can agree on direction before you invest time.
- Keep changes focused. One logical change per pull request makes review faster.

## How to contribute

We use the standard GitHub fork-and-pull-request flow.

1. **Fork** the repository to your own account.
2. **Branch** from `main` for your change:
   ```bash
   git checkout -b my-improvement
   ```
3. **Make your change.** Keep commits focused and write a clear commit message.
4. **Validate locally** using the focused checks below. You do not need a
   maintainer machine, private credentials, access to private Vector tooling, or
   a full release gate to prepare a PR.
5. **Sign off** your commits (see [Developer Certificate of Origin](#developer-certificate-of-origin-dco) below):
   ```bash
   git commit -s -m "Describe your change"
   ```
6. **Open a pull request** against `main`. Describe what changed and why, and
   link any related issue.

## Fast local testing

Run commands from the checkout root. Use Node 22.8.0 or later; when available,
repeat the focused tests on both Node 22.8.0 and Node 24. Record the actual patch
versions. A missing second lane is something to disclose, not a reason to obtain
access to maintainer infrastructure.

First reproduce the bug (or demonstrate the feature), then run the changed tests
and the suites of their affected callers. Choose those suites from the change's
blast radius: a shared helper needs its consumers tested too. For prose-only
changes, check the documentation and its links/examples; no full engine suite is
needed for this contributor preparation step. Policy or executable examples in
documentation can require behavioural tests.

The following is a runnable small-suite example. Replace `TEST_FILE` with the
suite relevant to your change; repeat `--file` for additional suites. Passing
this example alone does not validate an unrelated change.

<!-- contributor-check: focused -->
```bash
TEST_FILE=coord/engine/scripts/affected-targets.test.js
RUN_DIR=$(mktemp -d)
node --version
git --version
node coord/scripts/test-runner.js --file "$TEST_FILE" --report "$RUN_DIR/report.json"
```

Use the runner rather than invoking test files directly: it scrubs agent/session
identity from test subprocesses while preserving credentials, proxy settings and
the toolchain. Do not empty your entire environment. Reports go outside the
checkout; retain the report and record elapsed time in your PR.

Run these cheap consistency checks as well:

<!-- contributor-check: consistency -->
```bash
git diff --check
bash coord/scripts/check-template-sync.sh
```

For each changed JavaScript file, use `node --check path/to/file.js`; for shell
files, use `bash -n path/to/file.sh`. Run a component's documented lint command
when that component changes. There is no universal engine `npm run lint` command.
Template sync can report expected manifest drift after engine edits. Include its
exact output and affected paths in the handoff; do not silence failures or reset
coverage baselines to make a check green. Maintainers reconcile generated
artifacts against the integrated change.

Small focused suites should normally fit a **1–5 minute local budget**, with
syntax and whitespace checks taking seconds. This is a planning target, not a
measured guarantee for every laptop or suite. If a suite exceeds it, report the
actual duration and remaining checks. Large suites and release qualification
remain maintainer work; never describe an interrupted run as a pass.

### New test titles and source-only tools

List every added or renamed test title and its file in the PR. The public
Community artifact does not contain `release/` tooling. Contributors working
there should not try to install or fetch private tools to register titles.
Maintainers register them in both edition inventories when integrating.

In a maintainer source checkout that includes the title helper, run the following
against the actual PR base. The default below is only an example; set `BASE` to
the commit your change started from, especially for a multi-commit PR.

<!-- contributor-check: titles -->
```bash
BASE=${BASE:-HEAD~1}
if test -f release/suite-titles.js; then
  node release/suite-titles.js check --changed "$BASE"
else
  printf '%s\n' 'Title helper absent: list new titles in the PR for maintainer registration.'
fi
```

### What to include in the PR

- Base commit, head commit, tree (`git rev-parse HEAD^{tree}`), and commit list.
- Reproduction and changed scope, including affected consumers.
- Exact test/lint commands, Node and Git versions, OS, results and durations;
  attach reports and identify failed, skipped, unavailable or interrupted checks.
- New or renamed test titles and paths, plus template-sync output.

Maintainers integrate, gate and land the contribution under the current policy.
Contributor local results help review; they are **not landing evidence**.
Public PR evidence identifies the exact public tree tested. When a change is
ported to the maintainer source tree, that evidence does not transfer to the
integrated tree. Maintainers run its required checks there. The maintainer
workflow uses fresh blast-radius-selected checks and mandatory guards for
ordinary developer and PR changes; high-risk, unknown, incomplete, policy, and
suspended changes fall back to the full gate. Scheduled full qualification is
conditional on accumulated change significance. Promotion always requires the
full suite and passing coverage ratchet on the exact candidate. These policy
stages are maintainer responsibilities. Only eligible T0/T1 selection receipts
that the verifier confirms against the exact tree, base, and required checks can
serve as landing evidence. Exception-bearing receipts fail closed pending
governed, ticket-bound revalidation. This guide's focused local commands do not
replace maintainer checks or qualify a release.

## Developer Certificate of Origin (DCO)

This project does **not** use a Contributor License Agreement (CLA). Instead, we
use the [Developer Certificate of Origin](./DCO) (DCO) 1.1 — the same lightweight
mechanism used by the Linux kernel and many other projects.

The DCO is your statement that you wrote the contribution (or otherwise have the
right to submit it under the project's license). You certify it simply by adding
a `Signed-off-by` line to each commit:

```
Signed-off-by: Your Name <your.email@example.com>
```

Git adds this line for you automatically when you commit with the `-s` flag:

```bash
git commit -s -m "Your message"
```

The name and email must match your real identity (a pseudonym you consistently
use is acceptable). Pull requests whose commits are not signed off cannot be
merged. The full text of the certificate you are agreeing to is in the [DCO](./DCO)
file.

## License of contributions — inbound = outbound

Concord is licensed under the **Apache License 2.0**. By contributing, you agree
that your contribution is provided under the **same Apache-2.0 license** as the
project ("inbound = outbound"). No additional or different terms apply, and you
do not assign copyright — you retain ownership of your contribution and simply
license it under Apache-2.0, exactly as the rest of the project is licensed.

Note that Apache-2.0 licenses the *code*; it does **not** grant rights to the
project's trademarks. See [TRADEMARK.md](./TRADEMARK.md) for what the "Concord"
and "Softsensor Concord" names and logos cover.

## How pull requests are reviewed

- A maintainer (see [MAINTAINERS.md](./MAINTAINERS.md)) will review your PR. We
  aim to give initial feedback within a few business days; this is a best-effort
  community process, not a contractual SLA.
- Run the public CI checks configured for the repository, when available. This
  guide does not promise a public CI workflow; automated public CI expansion is
  separate work. Maintainers perform the required integration and release checks.
- Review focuses on correctness, test coverage, consistency with the existing
  governance model, and clarity. Expect a round or two of feedback — that is
  normal and not a reflection on the contribution.
- Once a maintainer approves and checks are green, a maintainer merges the PR.
  How decisions are made and how maintainers are added is described in
  [GOVERNANCE.md](./GOVERNANCE.md).

## Reporting bugs and requesting features

- **Bugs:** open an issue with steps to reproduce, expected vs. actual behavior,
  and your environment (OS, Node.js version).
- **Security issues:** do **not** open a public issue. Follow the private
  reporting process in [SECURITY.md](./SECURITY.md).
- **Features / ideas:** open an issue describing the problem you want to solve.
  Proposals that fit the project's direction are easier to land — see
  [GOVERNANCE.md](./GOVERNANCE.md) for how scope decisions are made.

Thank you for helping make Concord better.
