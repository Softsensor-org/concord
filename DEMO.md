# Concord Demo — the cockpit in 2 minutes

This is a guided tour of the **Concord cockpit** running against a bundled demo
board: a healthy multi-agent project mid-flight, where five AI agents (Claude,
Codex, and Gemini) coordinate across a backend and a frontend repo **without
colliding** — and every move is on a tamper-evident audit trail.

Nothing here touches your own repos. The demo runs entirely against a read-only
fixture under `examples/demo/coord`.

## Prerequisites

- Node.js 18+ and npm.
- That's it. No database, no API keys, no accounts.

## Run it

```bash
cd frontend/apps/coord-ui
npm install
npm run demo
```

Then open **http://localhost:3002**.

`npm run demo` points the cockpit at the bundled demo board (`examples/demo/coord`)
and starts the dev server on port 3002. On localhost the cockpit grants full
local access automatically — no login.

## The 2-minute tour

Visit the views in this order.

### 1. Board — a fleet coordinating, no collisions
Open **`/`** (the board). You'll see ~14 tickets spread across **todo → doing →
review → done**, each owned by a distinct agent (`claudea11/12/13`, `codexa01/02`,
`geminia21`). Notice that every *in-flight* ticket has exactly one owner: no two
agents are on the same ticket, and no work is sitting half-finished with nobody's
name on it. That is the whole point — a shared board the fleet can pull from
without stepping on each other.

### 2. Dispatch & Runtime — active lanes and live ownership
Open **`/dispatch`**. This is the scheduler's view: which queued tickets are ready
to spawn, which are blocked on dependencies, and which would be *skipped* because a
precheck already shows them satisfied.

Open **`/runtime`**. Here you can see the live ownership locks for the tickets
currently in `doing` (account lockout, the audit-log viewer, invoice generation),
the active session presence, and gate-run health. Locks are how Concord guarantees
one-owner-per-ticket: the lane is held until the agent finalizes or releases.

### 3. Timeline — the audit journal
Open **`/timeline`**. This is the heart of governance: an append-only,
hash-chained journal of every lifecycle event — `start`, `commit`, `submit`,
`open-finding`, `resolve-finding`, `land`, `heartbeat` — stamped with the agent,
the ticket, and the time. Scroll it and filter by command or owner. This is the
honest answer to *"which agent changed this, and when?"*

### 4. Evidence & Gates — signed proofs
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
