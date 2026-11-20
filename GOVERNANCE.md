# Project Governance

This document describes how the Concord project is run: who makes decisions, how
they are made, and how those roles change over time.

## Stewardship

Concord is an open-source project stewarded by **Softsensor**. Softsensor funds
the core team and maintains the project in the open, in the same spirit as other
company-backed open-source projects. Stewardship means Softsensor is responsible
for the project's long-term direction and health — it does **not** mean
contributions are owned or controlled by any single party beyond the terms of
the [Apache-2.0 license](./LICENSE).

Softsensor participates in the project on the same terms as any other
contributor: changes land through the public pull-request process described in
[CONTRIBUTING.md](./CONTRIBUTING.md), and there is no obligation — on anyone,
including Softsensor — to contribute private work back upstream.

## Roles

- **Contributors** — anyone who opens an issue or pull request. No special
  status required; see [CONTRIBUTING.md](./CONTRIBUTING.md).
- **Maintainers** — trusted contributors with merge rights, listed in
  [MAINTAINERS.md](./MAINTAINERS.md). Maintainers review and merge pull requests,
  triage issues, and shepherd releases.
- **Stewards (Softsensor)** — hold final responsibility for direction, the
  roadmap, releases, and the project's trademarks (see [TRADEMARK.md](./TRADEMARK.md)).

## How decisions are made

- **Everyday changes** (bug fixes, docs, well-scoped features) are decided by
  maintainer review on the pull request. One maintainer approval plus green
  checks is enough to merge.
- **Significant changes** (new subsystems, breaking changes, changes to the
  governance model itself) should start as an issue describing the problem and
  proposed direction, so the community and maintainers can weigh in before code
  is written.
- We work by **lazy consensus**: if no maintainer objects within a reasonable
  window, a proposal is considered accepted. When maintainers disagree and
  cannot reach consensus, the stewards make the final call, publicly and with
  reasoning.

## Becoming a maintainer

Maintainers are added by invitation from the existing maintainers, based on a
sustained track record of high-quality contributions, good review judgment, and
constructive participation in the community. If that describes you, it will
usually be noticed — but you are also welcome to express interest in an issue.

## License stability — our commitment

The Concord **Community edition** (the contents of this repository) will remain
licensed under the **Apache License 2.0**. We will not retroactively relicense
the open-source core to a more restrictive or "source-available" license.

This commitment exists so that adopters and contributors can build on Concord
without fear of a future rug-pull. Softsensor may offer separate commercial
products and services for organizations adopting multi-agent development at
scale; those are distinct offerings and do not change the license of this
open-source project.
