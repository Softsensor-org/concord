# Utility Governance

Register every recurring analytics utility before relying on it.

Utility classes:

- `read-only`: reads local or platform data and writes no outputs;
- `writes-local`: writes local files such as staged, clean, mart, or reports;
- `writes-platform`: mutates an external platform or production system.

Rules:

1. `writes-platform` utilities require approval, dry-run command, live command,
   side-effect statement, and rollback or reversal note.
2. `writes-local` utilities declare inputs, outputs, raw evidence path, and
   validation command.
3. One-off utilities may be registered as `one-off`, but still need an owner
   ticket and last verified date if their output supports a decision.
4. Deprecated utilities name the successor or the reason no successor exists.
