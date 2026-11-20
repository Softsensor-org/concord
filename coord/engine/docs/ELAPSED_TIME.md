# Elapsed time and persisted timestamps

Lock acquisition budgets, the lock retry sleep, and UI readiness waits measure
physical elapsed time with `performance.now()`. Moving the wall clock forward
must not consume a wait budget; moving it backward must not prolong a retry or
prevent a released lock from being acquired.

The existing limits are unchanged: agent and coordination state locks wait five
seconds, the governance runtime lock waits thirty seconds, and UI readiness uses
its existing caller-supplied budget and retry interval. Live-holder exclusion,
lock reclamation, lock ordering, request error handling and signal forwarding
keep their existing behavior.

The authoritative test runner publishes each module's parent-observed child
process duration in `results[].duration_ms`, measured with the same monotonic
clock. This includes process startup and shutdown. TAP counts retain their
existing parser semantics; the TAP trailer's duration no longer overwrites the
parent measurement. The report field remains a finite, nonnegative number of
milliseconds, with no schema or count-field change.

UTC audit timestamps and persisted ages remain wall-clock values. Session idle
expiry, file modification-time freshness, recorded lock age, recovery age and
historical audit dates are not converted to a process-local monotonic clock.
Those values must remain comparable across processes and restarts. Binding order
is separately recorded by the session binding sequence; it is not inferred from
an elapsed-time clock.

Regression tests exercise the actual lock consumers with an independently
released temporary lock, live-holder timeout preservation, a real local HTTP
readiness server, and the actual runner with an independently timed child
process. They inject forward and backward wall-clock jumps while measuring
physical elapsed time independently.
