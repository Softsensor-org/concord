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
4. **Validate locally** before opening a PR:
   ```bash
   # Board + governance artifacts stay self-consistent
   node coord/board/board.js validate

   # Run the governance test suite
   node --test coord/scripts/*.test.js coord/board/*.test.js
   ```
5. **Sign off** your commits (see [Developer Certificate of Origin](#developer-certificate-of-origin-dco) below):
   ```bash
   git commit -s -m "Describe your change"
   ```
6. **Open a pull request** against `main`. Describe what changed and why, and
   link any related issue.

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
- Automated checks (governance suite, board validation, the publish-hygiene
  gates) run on every PR and must pass before merge.
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
