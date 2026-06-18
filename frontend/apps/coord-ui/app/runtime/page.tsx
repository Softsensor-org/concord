import Link from 'next/link';
import { loadRuntimeHealth } from '../../lib/runtime-health';
import type { GateRunView, ProcView } from '../../lib/runtime-health';
import { requireRole, redact, type Role } from '../../lib/access';

// Reads the live gate-proc registry + locks/session artifacts at request time;
// strictly read-only fs (no mutation, no kill, no spawn). Render dynamically.
// SEC-001: sensitive route — operator+ for unredacted PIDs/cmdlines/paths;
// viewer/low-privilege views are redacted.
export const dynamic = 'force-dynamic';

function guardClass(g: ProcView['guard']): string {
  if (g === 'guarded') return 'rl rl--ready';
  if (g === 'reused') return 'rl rl--blocked';
  if (g === 'gone') return 'rl rl--na';
  return 'rl rl--pending'; // unguarded — fail-safe, surfaced not hidden
}

function guardLabel(g: ProcView['guard']): string {
  if (g === 'guarded') return 'guarded (start-time match)';
  if (g === 'reused') return 'PID REUSED (start-time differs — reaper refuses)';
  if (g === 'gone') return 'gone (no live process)';
  return 'unguarded (no recorded start-time — reaper fail-safe)';
}

function ageLabel(mins: number | null): string {
  if (mins == null) return 'unknown age';
  if (mins < 60) return `${mins}m old`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m old`;
}

function ProcRows({ procs, role }: { procs: ProcView[]; role: Role }) {
  if (procs.length === 0) {
    return <div className="card__title">No PIDs recorded for this gate-run.</div>;
  }
  return (
    <div className="kv-rows">
      {procs.map((p) => (
        <div className="kv-row kv-row--col" key={p.pid}>
          <div>
            <span className="kv-row__k">pid {String(redact('pid', p.pid, role))}</span>{' '}
            <span className={guardClass(p.guard)}>{guardLabel(p.guard)}</span>
          </div>
          <div className="card__title">
            start-time:{' '}
            <code>{p.startTime ?? '(none — non-Linux / unrecorded)'}</code>
          </div>
          {p.cmdline ? (
            <div className="card__title">
              cmdline (advisory, never authoritative):{' '}
              <code>{String(redact('cmdline', p.cmdline, role))}</code>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function GateRunCard({ run, scary, role }: { run: GateRunView; scary: boolean; role: Role }) {
  return (
    <section className="panel" style={{ marginBottom: '0.85rem' }}>
      <h3>
        <code>{run.gateRunId}</code>{' '}
        {run.orphan ? (
          <span className="hc hc--warn">ORPHAN</span>
        ) : (
          <span className="hc hc--ok">owner live</span>
        )}{' '}
        {run.heavyLane ? <span className="pill pill--p1">heavy lane</span> : null}
      </h3>

      <div className="kv-rows">
        <div className="kv-row">
          <span className="kv-row__k">ticket</span>
          <span>
            {run.ticket ? (
              <Link href={`/ticket/${run.ticket}`} className="kv-row__k">
                {run.ticket}
              </Link>
            ) : (
              <span className="card__title">(none recorded)</span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__k">repo</span>
          <span>{run.repo ? <code>{run.repo}</code> : <span className="card__title">(none)</span>}</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__k">lane</span>
          <span>
            {run.lane ? <code>{run.lane}</code> : <span className="card__title">(none)</span>}{' '}
            {run.heavyLane ? <span className="rl rl--na">full/ci — resource-heavy</span> : null}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__k">pgid</span>
          <span>
            {run.pgid != null ? (
              <code>{String(redact('pid', run.pgid, role))}</code>
            ) : (
              <span className="card__title">(none recorded)</span>
            )}{' '}
            <span className="card__title">· diagnostics only — never group-signaled from here</span>
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__k">recorded</span>
          <span>
            {run.createdAt ?? 'unknown'} · {ageLabel(run.ageMinutes)} · {run.matchedCount}/
            {run.procs.length} PID(s) still pass the reuse guard
          </span>
        </div>
        <div className="kv-row kv-row--col">
          <span className="kv-row__k">classification</span>
          <span className="card__title">
            coord verdict: <em>{run.reason}</em>
          </span>
        </div>
      </div>

      <div style={{ marginTop: '0.6rem' }}>
        <div className="card__title">
          <b>Recorded child processes</b> — provenance is the recorded pid + start-time fingerprint.
          PID-reuse / unguarded status is shown per-PID (never hidden).
        </div>
        <div style={{ marginTop: '0.3rem' }}>
          <ProcRows procs={run.procs} role={role} />
        </div>
      </div>

      {scary && run.orphan ? (
        <div style={{ marginTop: '0.6rem' }}>
          <div className="card__title">
            <b>Recovery (run on the CLI — this view never executes it):</b>
          </div>
          <pre className="cmd-list">
            {[
              'coord/scripts/gov reap-gate-procs',
              run.ticket
                ? `coord/scripts/gov doctor --fix --ticket ${run.ticket}`
                : 'coord/scripts/gov doctor --fix',
              'coord/scripts/gov doctor'
            ].join('\n')}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

export default async function RuntimePage() {
  // SEC-001: gate before reading any runtime/process internals. operator+ for
  // unredacted PIDs/cmdlines/paths; viewer gets a redacted view.
  const role = await requireRole();
  const v = loadRuntimeHealth();

  if (!v.ok) {
    return (
      <>
        <div className="board-meta">
          <span>
            runtime health: <strong>error</strong>
          </span>
        </div>
        <div className="banner">
          The gate-process registry module could not be loaded: {v.error ?? 'unknown error'}. No
          process-health view to display. This page never mutates state — run{' '}
          <code>coord/scripts/gov doctor</code> for authoritative diagnostics.
        </div>
      </>
    );
  }

  const cleanZero =
    v.orphans.length === 0 && v.activeRuns.length === 0 && v.cleanResidue.length === 0;

  return (
    <>
      <div className="board-meta">
        <span>
          posture:{' '}
          <strong className={v.level === 'warn' ? 'hc hc--warn' : 'hc hc--ok'}>
            {v.level === 'warn' ? 'ORPHAN RISK' : 'CLEAN'}
          </strong>
        </span>
        <span>
          orphans: <strong>{v.orphans.length}</strong>
        </span>
        <span>active gate-runs: {v.activeRuns.length}</span>
        <span>registry entries: {v.totalEntries}</span>
        <span>locks: {v.locks.count}</span>
        <span>read-only · never kills / spawns / reaps</span>
      </div>

      {/* Read-only contract — stated up front. */}
      <div className="banner" style={{ marginBottom: '0.85rem' }}>
        <b>Read-only operator view.</b> This page reads coord-recorded process provenance only
        (the gate-proc registry under <code>coord/.runtime/gate-procs/</code>). It NEVER kills,
        signals, spawns, or reaps a process, and never infers ownership from a process name —
        orphans are classified strictly from the recorded pid + start-time fingerprint. Reaping is
        the <code>gov reap-gate-procs</code> / <code>gov doctor --fix</code> path, run by an
        operator on the CLI.
      </div>

      {/* Lane discipline — REQUIRED by the ticket, repeated for full/ci. */}
      <div className="banner" style={{ marginBottom: '0.85rem' }}>
        <b>Lane discipline:</b> the default gate lane is the lean local check. The <code>full</code>{' '}
        and <code>ci</code> lanes carry the resource-heavy children (dev-servers, browser/test
        workers) and must NOT be run concurrently across parallel agents on a memory-constrained
        host unless a human coordinates capacity. Orphaned heavy-lane processes are the OOM-cascade
        risk this page exists to surface.
      </div>

      {cleanZero ? (
        <section className="panel" style={{ marginBottom: '0.85rem' }}>
          <h3>
            Gate-process health <span className="hc hc--ok">CLEAN</span>
          </h3>
          <div className="card__title">
            {v.registryDirPresent
              ? 'The gate-proc registry is empty — zero active gate-runs, zero orphans, no clean-exit residue. Nothing to reap. This is the expected steady state when no heavy gate is mid-flight.'
              : `No gate-proc registry directory yet (${v.registryDir}). No gate has recorded a containment entry — zero orphans. Nothing to reap.`}
          </div>
        </section>
      ) : null}

      <div className="ticket-grid">
        <div>
          {/* Orphans — the DIAGNOSTIC. */}
          {v.orphans.length > 0 ? (
            <>
              <div className="board-meta" style={{ marginBottom: '0.4rem' }}>
                <span>
                  <strong className="hc hc--warn">Detected orphans</strong>
                </span>
                <span>{v.orphans.length} gate-run(s) whose owner is gone</span>
                <span>diagnostic only — reap from the CLI</span>
              </div>
              {v.orphans.map((run) => (
                <GateRunCard key={run.gateRunId} run={run} scary role={role} />
              ))}
            </>
          ) : null}

          {/* Active gate-runs. */}
          {v.activeRuns.length > 0 ? (
            <>
              <div className="board-meta" style={{ marginBottom: '0.4rem', marginTop: '0.4rem' }}>
                <span>
                  <strong>Active gate-runs</strong>
                </span>
                <span>{v.activeRuns.length} run(s) with a live owner</span>
              </div>
              {v.activeRuns.map((run) => (
                <GateRunCard key={run.gateRunId} run={run} scary={false} role={role} />
              ))}
            </>
          ) : null}

          {/* Clean-exit residue — informational, not scary. */}
          {v.cleanResidue.length > 0 ? (
            <section className="panel" style={{ marginBottom: '0.85rem' }}>
              <h3>
                Clean-exit residue <span className="rl rl--na">{v.cleanResidue.length}</span>
              </h3>
              <div className="card__title" style={{ marginBottom: '0.4rem' }}>
                Registry files whose recorded processes are all gone but which are NOT orphans (the
                gate exited; the cleanup trap left the file behind). Harmless — a routine{' '}
                <code>coord/scripts/gov doctor</code> tidies them. Listed so nothing is silent.
              </div>
              <div className="kv-rows">
                {v.cleanResidue.map((run) => (
                  <div className="kv-row" key={run.gateRunId}>
                    <span className="kv-row__k">
                      <code>{run.gateRunId}</code>
                    </span>
                    <span className="card__title">
                      {run.lane ?? '?'} · {run.ticket ?? 'no ticket'} · {ageLabel(run.ageMinutes)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <aside className="side-panel">
          {/* Runtime / lock / session health. */}
          <section className="panel">
            <h3>Lock health</h3>
            <div className="kv-rows">
              <div className="kv-row">
                <span className="kv-row__k">active locks</span>
                <span className="pill">{v.locks.count}</span>
              </div>
              <div className="kv-row">
                <span className="kv-row__k">stalled (&gt;24h)</span>
                <span className={v.locks.stalled > 0 ? 'hc hc--warn' : 'hc hc--ok'}>
                  {v.locks.stalled}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-row__k">malformed</span>
                <span className={v.locks.malformed > 0 ? 'hc hc--fail' : 'hc hc--ok'}>
                  {v.locks.malformed}
                </span>
              </div>
            </div>
          </section>

          <section className="panel">
            <h3>Runtime artifacts</h3>
            <div className="kv-rows">
              <div className="kv-row">
                <span className="kv-row__k">agent_sessions.json</span>
                <span className={v.sessions.agentSessionsPresent ? 'hc hc--ok' : 'hc hc--warn'}>
                  {v.sessions.agentSessionsPresent ? 'present' : 'missing'}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-row__k">session-instances.json</span>
                <span className={v.sessions.sessionInstancesPresent ? 'hc hc--ok' : 'hc hc--warn'}>
                  {v.sessions.sessionInstancesPresent ? 'present' : 'missing'}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-row__k">event log</span>
                <span className={v.sessions.eventLogPresent ? 'hc hc--ok' : 'hc hc--fail'}>
                  {v.sessions.eventLogPresent ? 'present' : 'missing'}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-row__k">latest snapshot</span>
                <span className={v.sessions.snapshotPresent ? 'hc hc--ok' : 'hc hc--warn'}>
                  {v.sessions.snapshotPresent ? 'present' : 'missing'}
                </span>
              </div>
            </div>
          </section>

          {/* Provenance source. */}
          <section className="panel">
            <h3>Provenance source</h3>
            <div className="card__title" style={{ marginBottom: '0.4rem' }}>
              Gate-process entries are read from this registry dir (read-only):
            </div>
            <pre className="cmd-list">{String(redact('path', v.registryDir, role))}</pre>
            <div className="card__title" style={{ marginTop: '0.4rem' }}>
              schema <code>{v.registrySchema}</code>. Same classification logic as{' '}
              <code>gov doctor</code> / the reaper — no re-implemented payloads.
            </div>
          </section>

          {/* Guard legend. */}
          <section className="panel">
            <h3>PID guard legend</h3>
            <div className="kv-rows">
              <div className="kv-row kv-row--col">
                <span className="rl rl--ready">guarded</span>
                <span className="card__title">
                  live PID and its start-time byte-matches the recorded fingerprint.
                </span>
              </div>
              <div className="kv-row kv-row--col">
                <span className="rl rl--blocked">PID REUSED</span>
                <span className="card__title">
                  a live process holds the recorded PID but its start-time differs — the reaper
                  REFUSES to signal it. Never hidden.
                </span>
              </div>
              <div className="kv-row kv-row--col">
                <span className="rl rl--na">gone</span>
                <span className="card__title">no live process at the recorded PID.</span>
              </div>
              <div className="kv-row kv-row--col">
                <span className="rl rl--pending">unguarded</span>
                <span className="card__title">
                  no recorded start-time (non-Linux host); the reaper fails safe and would not
                  signal it.
                </span>
              </div>
            </div>
          </section>

          {/* Doctor commands — never executed here. */}
          <section className="panel">
            <h3>Operator commands</h3>
            <div className="card__title" style={{ marginBottom: '0.4rem' }}>
              Copyable — this view NEVER runs them (no generic <code>kill</code> is ever shown):
            </div>
            <pre className="cmd-list">
              {['coord/scripts/gov doctor', 'coord/scripts/gov reap-gate-procs'].join('\n')}
            </pre>
          </section>
        </aside>
      </div>
    </>
  );
}
