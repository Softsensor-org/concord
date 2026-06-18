# Security Policy

## Project status

This project is **alpha** open-source software. It is provided as a reusable
governance/coordination template and is evolving quickly. Treat it as
pre-1.0: interfaces, file layouts, and behavior may change between releases.

## Supported versions

Only the latest release on the default branch (`main`) receives security
fixes. There are no long-term-support branches at this stage. Always update to
the most recent release before reporting an issue, in case it is already fixed.

| Version            | Supported          |
| ------------------ | ------------------ |
| Latest `main`      | :white_check_mark: |
| Older tags/commits | :x:                |

## Reporting a vulnerability

Please report security issues **privately** so they can be triaged before
public disclosure:

1. **Preferred:** open a private advisory via GitHub Security Advisories
   ("Report a vulnerability" under the repository's **Security** tab). This
   keeps the report confidential until a fix is available.
2. If private advisories are unavailable to you, email
   **opensource@softsensor.com** with the details, or open a regular GitHub issue
   that describes the problem **without** including exploit details or
   sensitive data and request a private channel for the specifics.

Please do **not** disclose the details publicly until a fix has been released.

### What to include

- A description of the issue and its impact.
- Steps to reproduce or a minimal proof of concept.
- Affected version/commit and environment (OS, runtime versions).

### What to expect

As an alpha community project, response is best-effort and not bound by a
formal SLA. You can generally expect an initial acknowledgement within a few
business days. We will keep you informed as we investigate, and we credit
reporters in the release notes for the fix unless you ask us not to.

## Scope

In scope: the template's code, scripts, governance tooling, and configuration
shipped in this repository. Out of scope: third-party dependencies (report
those upstream), and any private deployment or fork-specific configuration you
add on top of the template.
