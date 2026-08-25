# Concord Demo — the cockpit in 2 minutes

This is a guided tour of the **Concord cockpit** running against a bundled demo
board: a healthy multi-agent project mid-flight, where five AI agents (Claude,
Codex, and Gemini) coordinate across a backend and a frontend repo through
**one owner per in-flight ticket** — and every governed lifecycle transition is
on a hash-chained journal.

Nothing here touches your own repos. The demo runs entirely against a read-only
fixture under `examples/demo/coord`.

## Prerequisites

- Node.js 18+ and npm.
- That's it. No database, no API keys, no accounts.

## Run it

```bash
npm --prefix frontend/apps/coord-ui install && npm --prefix frontend/apps/coord-ui run demo
```

Then open **http://localhost:3002**.

This points the cockpit at the bundled demo board (`examples/demo/coord`) and
starts the dev server on port 3002. On localhost the cockpit grants full local
access automatically — no login.

## The 2-minute tour

Visit the views in this order.

### 1. Board — a fleet coordinating, one owner per ticket
Open **`/`** (the board). You'll see ~14 tickets spread across **todo → doing →
review → done**, each owned by a distinct agent (`claudea11/12/13`, `codexa01/02`,
`geminia21`). Notice that every *in-flight* ticket has exactly one owner: no two
agents are on the same ticket, and no work is sitting half-finished with nobody's
name on it. That is the point of the board: a shared queue the fleet pulls from,
where ownership of governed work is explicit instead of assumed. It is a
coordination surface, not an access control — an agent that edits files outside
its ticket can still create a conflict, which the journal and the gates are there
to surface.

### 2. Dispatch & Runtime — active lanes and live ownership
Open **`/dispatch`**. This is the scheduler's view: which queued tickets are ready
to spawn, which are blocked on dependencies, and which would be *skipped* because a
precheck already shows them satisfied.

Open **`/runtime`**. Here you can see the live ownership locks for the tickets
currently in `doing` (account lockout, the audit-log viewer, invoice generation),
the active session presence, and gate-run health. Locks are how Concord enforces
one-owner-per-ticket for lifecycle verbs: the lane is held until the agent
finalizes or releases, and a second session's `gov` mutation on the same ticket
is refused. Work done outside `gov` is not covered by the lock.

### 3. Timeline — the audit journal
Open **`/timeline`**. This is the heart of governance: an append-only,
hash-chained journal of the supported Concord lifecycle operations — `start`,
`commit`, `submit`, `open-finding`, `resolve-finding`, `land`, `heartbeat` —
stamped with the agent, the ticket, and the time. Scroll it and filter by command
or owner. This answers *"which agent took which governed step, and when?"*

It is deliberately not a record of everything an agent did: provider tool calls,
ad-hoc shell commands, file reads and network requests happen outside `gov` and
do not appear here.

### 4. Evidence & Gates — recorded proofs
Open **`/evidence`**. For each landed ticket you get a dossier: the requirement
closure, the feature-proof anchors, the recorded repo-gate results, and the
self-review cycles the agent ran before submitting. Open **`/gates`** to see the
per-repo, per-lane gate artifacts — each marked **authoritative** (recorded on a
clean worktree at a known commit), so a green check is something you can trust.

Also worth a look: **`/traceability`** (requirement-closure coverage per ticket),
**`/cost`** (token spend per agent / model / ticket), and **`/issues`** (open and
resolved review findings).

### 5. The trust property
Everything you just saw is backed by a **tamper-evident journal**: each event
records the hash of the previous one, so reordering, dropping, or editing any
event breaks the chain and is detected. The same property is enforced on a real
board by:

```bash
coord/scripts/gov conform
```

`gov conform` walks the journal end-to-end and reports the chain head — a single
attestation of the project's governed history. On a real project this is what lets
you stand behind *"this work was coordinated, owned, reviewed, and recorded."*

## What's next

- Read [QUICKSTART.md](QUICKSTART.md) to stand up Concord on your own repos.
- The cockpit you just explored lives in `frontend/apps/coord-ui`; the governance
  engine and the `gov` CLI live in `coord/scripts`.
