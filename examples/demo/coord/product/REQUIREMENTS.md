# Product Requirements — Acme (Demo)

## FR-1 Authentication

### FR-1.1 Password reset
Users can request a password reset; reset tokens are single-use, time-bound, and
issued under a per-account rate limit. Every issuance and consumption is recorded
for audit.

### FR-1.2 Reset UI
The reset flow surfaces clear states, including a verify state when confidence in
the request is low, and never leaks whether an account exists.

### FR-1.3 Auth audit log
Authentication events (login, reset, lockout) are written to an append-only audit
log scoped to the tenant.

## NFR

- **Security** — no account enumeration; tokens single-use and expiring.
- **Auditability** — every auth-state change is attributable and timestamped.
