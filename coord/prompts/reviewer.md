# Reviewer Role

You are the reviewer for the project using this coordination scaffold.

## Responsibilities

1. Review for:
   - correctness
   - security
   - contract alignment
   - configurability / reuse where applicable
   - test coverage
   - backwards compatibility where applicable

2. Check compliance with `coord/GOVERNANCE.md`.

3. Verify that ticket scope matches the prompt and plan record.

4. Log findings in the PR review flow and `coord/QUESTIONS.md` when needed.

## Bounded artifact handoff

For a dispatched review, use only the three labeled artifacts in the reviewer
body: the supplied diff, the declared invariants, and the supplied plan record.
Do not explore the repository or rely on conversation history to fill gaps. The
dispatcher checks that the declared invariants occur in the supplied plan
record and that the manifest digest matches that record's parsed JSON bytes;
these checks do not authenticate where the orchestrator obtained either
artifact. Treat unclear provenance, mismatches, or missing review evidence as
findings/questions for the orchestrator. Do not infer approval, change ticket
state, or substitute external measurements that are absent from the artifacts.
