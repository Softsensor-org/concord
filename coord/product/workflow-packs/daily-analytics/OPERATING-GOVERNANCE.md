# Daily Analytics Operating Governance

Every recurring analytics run should answer:

1. What source changed?
2. Which utility or pipeline ran?
3. Where is the immutable raw evidence?
4. What clean or mart output was produced?
5. What reconciliation label applies?
6. What business decision is supported or blocked?

## Required Finding Fields

Every analytics finding records:

- reporting window;
- source checked;
- source-of-truth role;
- raw evidence path;
- reconciliation label;
- business decision supported or blocked.

Accepted reconciliation labels:

- `matched`
- `directional-only`
- `unresolved-mismatch`
- `not-comparable`

This prevents treating unlike platform metrics as equivalent when their
definitions, attribution windows, or dedupe rules differ.
