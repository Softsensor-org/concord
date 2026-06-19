import Link from 'next/link';
import { loadEvidenceIndex, loadTicketDossier } from '../../lib/evidence';
import type { EvidenceState, MatrixRow, TicketDossier } from '../../lib/evidence';
import { requireRole, redact, type Role } from '../../lib/access';

// Reads board/plan/journal at request time — render dynamically (read-only fs).
// SEC-001: sensitive route — PR refs and commit/landing provenance are redacted
// for low-privilege (viewer) roles; operator+ sees the full dossier.
export const dynamic = 'force-dynamic';

const STATE_CLASS: Record<EvidenceState, string> = {
  present: 'rl rl--ready',
  absent: 'rl rl--blocked',
  not_applicable: 'rl rl--na'
};

const STATE_LABEL: Record<EvidenceState, string> = {
  present: 'present',
  absent: 'gap',
  not_applicable: 'n/a'
};

function fmtTs(ts?: string): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  } catch {
    return ts;
  }
}

function MatrixRowView({ m }: { m: MatrixRow }) {
  return (
    <div className="kv-row kv-row--col">
      <div>
        <span className={STATE_CLASS[m.state]}>{STATE_LABEL[m.state]}</span> <b>{m.label}</b>
      </div>
      <div className="card__title">{m.detail}</div>
    </div>
  );
}

function Dossier({ d, role }: { d: TicketDossier; role: Role }) {
  return (
    <>
      <div className="ticket-header">
        <Link href="/evidence" className="back">
          ← evidence
        </Link>
        <h1>{d.id}</h1>
        <span className={d.complete ? 'rl rl--ready' : 'rl rl--blocked'}>
          {d.complete ? 'complete dossier' : `${d.gaps.length} evidence gap(s)`}
        </span>
      </div>

      <div className="ticket-grid">
        <div>
          {/* Completeness matrix — the headline of the dossier. */}
          <section className="panel" style={{ marginBottom: '0.85rem' }}>
            <h3>
              Evidence completeness matrix{' '}
              <span className="rl rl--na">
                {d.matrix.filter((m) => m.state === 'present').length}/{d.matrix.length} present
              </span>
            </h3>
            <div className="kv-rows">
              {d.matrix.map((m) => (
                <MatrixRowView key={m.key} m={m} />
              ))}
            </div>
          </section>

          {/* Requirement closure. */}
          <section className="panel" style={{ marginBottom: '0.85rem' }}>
            <h3>
              Requirement closure{' '}
              <span className={d.closeoutVerdict ? 'rl rl--ready' : 'rl rl--pending'}>
                {d.closeoutVerdict ?? 'no verdict'}
              </span>
            </h3>
            {d.requirementClosure.lines.length === 0 ? (
              <div className="card__title">No requirement-closure record yet.</div>
            ) : (
              <dl>
                <dt>ask</dt>
                <dd>{d.requirementClosure.ticketAsk ?? '—'}</dd>
                <dt>implemented</dt>
                <dd>{d.requirementClosure.implemented ?? '—'}</dd>
                <dt>not implemented</dt>
                <dd>{d.requirementClosure.notImplemented ?? '—'}</dd>
                <dt>deferred to</dt>
                <dd>{d.requirementClosure.deferredTo ?? '—'}</dd>
                <dt>verdict</dt>
                <dd>{d.requirementClosure.verdict ?? '—'}</dd>
              </dl>
            )}
          </section>

          {/* Feature proof. */}
          <section className="panel" style={{ marginBottom: '0.85rem' }}>
            <h3>Feature proof ({d.featureProof.length})</h3>
            {d.featureProof.length === 0 ? (
              <div className="card__title">
                {d.repo === 'X'
                  ? 'Coordination ticket (repo X) — feature proof not required.'
                  : 'No feature-proof anchors recorded — gap on a code ticket.'}
              </div>
            ) : (
              <ul className="reason-list">
                {d.featureProof.map((f, i) => (
                  <li key={i}>
                    <code>{f}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Self-review cycles. */}
          <section className="panel" style={{ marginBottom: '0.85rem' }}>
            <h3>
              Self-review cycles{' '}
              <span className={d.reviewCycleCount >= d.requiredCycles ? 'rl rl--ready' : 'rl rl--blocked'}>
                {d.reviewCycleCount}/{d.requiredCycles} required
              </span>
            </h3>
            {d.reviewCycles.length === 0 ? (
              <div className="card__title">No self-review cycles recorded.</div>
            ) : (
              <div className="kv-rows">
                {d.reviewCycles.map((c, i) => (
                  <div className="kv-row" key={`${c.cycle ?? i}`}>
                    <span className="kv-row__k">
                      cycle {c.cycle ?? i + 1} {c.lens ? <code>{c.lens}</code> : null}
                    </span>
                    <span className={c.verdict === 'pass' ? 'rl rl--ready' : 'rl rl--pending'}>
                      {c.verdict ?? '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Review findings. */}
          <section className="panel">
            <h3>Review findings ({d.findings.length})</h3>
            {d.findings.length === 0 ? (
              <div className="card__title">No review findings filed.</div>
            ) : (
              <div className="kv-rows">
                {d.findings.map((f) => (
                  <div className="kv-row kv-row--col" key={f.id}>
                    <div>
                      <span className={`sev sev--${f.severity.toLowerCase()}`}>{f.severity}</span>{' '}
                      <span className={f.open ? 'rl rl--blocked' : 'rl rl--ready'}>{f.status}</span>{' '}
                      <code>{f.id}</code>
                    </div>
                    <div className="card__title">{f.summary}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="side-panel">
          {/* Gaps callout — actionable, never a blank card. */}
          <section className="panel">
            <h3>
              Evidence gaps{' '}
              <span className={d.complete ? 'rl rl--ready' : 'rl rl--blocked'}>
                {d.complete ? 'none' : d.gaps.length}
              </span>
            </h3>
            {d.complete ? (
              <div className="card__title">All required evidence dimensions present.</div>
            ) : (
              <ul className="reason-list">
                {d.gaps.map((g) => (
                  <li key={g}>{d.matrix.find((m) => m.key === g)?.detail ?? g}</li>
                ))}
              </ul>
            )}
          </section>

          {/* Repo gates. */}
          <section className="panel">
            <h3>Repo gates ({d.repoGates.length})</h3>
            {d.repoGates.length === 0 ? (
              <div className="card__title">No repo gate result recorded.</div>
            ) : (
              <ul className="reason-list">
                {d.repoGates.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            )}
          </section>

          {/* PR + landing proof, with recorded landing-audit evidence. */}
          <section className="panel">
            <h3>PR / landing proof</h3>
            {!d.landing.present && d.prRefs.length === 0 ? (
              <div className="card__title">No landing or PR provenance recorded.</div>
            ) : (
              <dl>
                {d.prRefs.length > 0 ? (
                  <>
                    <dt>pr refs</dt>
                    <dd>{String(redact('pr', d.prRefs.join(', '), role))}</dd>
                  </>
                ) : null}
                {d.landing.present ? (
                  <>
                    <dt>method</dt>
                    <dd>{d.landing.method ?? '—'}</dd>
                    <dt>base</dt>
                    <dd>{d.landing.baseRef ?? '—'}</dd>
                    <dt>commit</dt>
                    <dd>{String(redact('identity', d.landing.commitSha, role) ?? '—')}</dd>
                    <dt>provenance</dt>
                    <dd>{d.landing.provenanceStatus ?? '—'}</dd>
                    <dt>landed</dt>
                    <dd>{fmtTs(d.landing.recordedAt)}</dd>
                  </>
                ) : null}
              </dl>
            )}
            <div className="card__title" style={{ marginTop: '0.5rem' }}>
              Landing audits (testing-infra / feature-proof):
            </div>
            {d.landing.evidence.length > 0 ? (
              <ul className="reason-list">
                {d.landing.evidence.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            ) : (
              <div className="card__title">
                {d.landing.present
                  ? 'No explicit audit evidence lines recorded with the landing.'
                  : 'No landing record to audit.'}
              </div>
            )}
          </section>

          {/* Cost link for this ticket. */}
          <section className="panel">
            <h3>Operating cost</h3>
            <div className="card__title">
              <Link href={`/cost?ticket=${d.id}`} className="kv-row__k">
                View this ticket&apos;s cost ledger →
              </Link>
            </div>
          </section>

          {/* Waivers. */}
          <section className="panel">
            <h3>Waivers / follow-up exceptions</h3>
            {!d.waivers && !d.followupException ? (
              <div className="card__title">No waivers or follow-up exceptions.</div>
            ) : (
              <>
                {d.waivers ? (
                  <div className="kv-row kv-row--col">
                    <div>
                      <span className="rl rl--pending">waiver</span> <code>{d.waivers.code}</code>
                    </div>
                    <div className="card__title">{d.waivers.reason}</div>
                  </div>
                ) : null}
                {d.followupException ? (
                  <div className="kv-row kv-row--col">
                    <div>
                      <span className="rl rl--pending">follow-up</span>{' '}
                      <code>{d.followupException.type ?? 'exception'}</code>
                      {d.followupException.parent ? <> · parent {d.followupException.parent}</> : null}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

export default async function EvidencePage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const role = await requireRole();
  const sp = await searchParams;
  const pick = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const ticket = pick('ticket');

  // Single-ticket dossier view.
  if (ticket) {
    const d = loadTicketDossier(ticket);
    if (!d) {
      return (
        <>
          <div className="ticket-header">
            <Link href="/evidence" className="back">
              ← evidence
            </Link>
            <h1>{ticket}</h1>
            <span className="rl rl--na">unknown</span>
          </div>
          <div className="banner">
            No governed record found for <code>{ticket}</code>. It has no plan record, board row, or
            journal — nothing to build a dossier from.
          </div>
        </>
      );
    }
    return <Dossier d={d} role={role} />;
  }

  // Index view: closed tickets, the dossier candidates.
  const index = loadEvidenceIndex();

  return (
    <>
      <div className="board-meta">
        <span>
          closed tickets: <strong>{index.doneCount}</strong>
        </span>
        <span>
          with evidence gaps: <strong>{index.withGaps}</strong>
        </span>
        <span>source: board + plan records + journal</span>
      </div>

      <section className="panel">
        <h3>Evidence dossiers</h3>
        <div className="card__title" style={{ marginBottom: '0.5rem' }}>
          Per-ticket completeness matrix over requirement closure, feature proof, repo gates,
          self-review cycles, review findings, waivers, PR refs, landing proof, landing audits, and
          closeout verdict. Read-only — derived from governed state, never recomputed by mutating.
        </div>
        {index.empty ? (
          <div className="card__title">
            No closed (done/superseded) tickets yet — no dossiers to show. Land a ticket and its
            evidence dossier appears here.
          </div>
        ) : (
          <div className="kv-rows">
            {index.rows.map((r) => (
              <div className="kv-row kv-row--col" key={r.id}>
                <div>
                  <Link href={`/evidence?ticket=${r.id}`} className="kv-row__k">
                    {r.id}
                  </Link>{' '}
                  <span className="pill pill--repo">{r.repo}</span>{' '}
                  {r.priority ? <span className="pill">{r.priority}</span> : null}{' '}
                  <span className={r.complete ? 'rl rl--ready' : 'rl rl--blocked'}>
                    {r.complete ? 'complete' : `${r.gapCount} gap(s)`}
                  </span>
                </div>
                <div className="card__title">
                  verdict: {r.closeoutVerdict ?? '—'} · review {r.reviewCycleCount}/{r.requiredCycles}{' '}
                  · {r.landed ? 'landed' : 'no landing record'}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
