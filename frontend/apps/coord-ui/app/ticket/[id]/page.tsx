import React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadTicketExplain } from '../../../lib/ticket-explain';
import type {
  ExplainSection,
  ReadinessLevel,
  TicketExplain
} from '../../../lib/ticket-explain';
import type { GovEvent } from '../../../lib/types';
import { requireRole, redact, type Role } from '../../../lib/access';

// SEC-001: the ticket detail view discloses lock owner/agent/session/worktree,
// event owner attribution, and PR/commit provenance. operator+ sees it in full;
// a low-privilege (viewer) role gets these identity/path/PR fields redacted.
export const dynamic = 'force-dynamic';

const RESULT_CLASS: Record<string, string> = {
  succeeded: 'event__result--succeeded',
  failed: 'event__result--failed',
  error: 'event__result--error'
};

const LEVEL_CLASS: Record<ReadinessLevel, string> = {
  ready: 'rl rl--ready',
  blocked: 'rl rl--blocked',
  pending: 'rl rl--pending',
  done: 'rl rl--done',
  na: 'rl rl--na'
};

function fmtTs(ts: string): string {
  try {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  } catch {
    return ts;
  }
}

function EventRow({ ev, role }: { ev: GovEvent; role: Role }) {
  const cls = ev.result ? `event__result ${RESULT_CLASS[ev.result] || ''}` : 'event__result';
  return (
    <div className="event">
      <span className="event__ts">{fmtTs(ev.ts)}</span>
      <span className="event__cmd">{ev.command}</span>
      <span className="event__owner">
        {ev.identity?.owner ? String(redact('identity', ev.identity.owner, role)) : ''}
      </span>
      <span className={cls}>{ev.result ?? ''}</span>
    </div>
  );
}

/** Compact section header with a readiness tone dot + headline. */
function SectionHead({ title, section }: { title: string; section: ExplainSection }) {
  return (
    <h3>
      {title} <span className={LEVEL_CLASS[section.level]}>{section.headline}</span>
    </h3>
  );
}

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const role = await requireRole();
  const { id } = await params;
  const x: TicketExplain = loadTicketExplain(id);
  if (!x.found) notFound();

  const { lifecycle: lc, lock } = x;

  return (
    <>
      <div className="ticket-header">
        <Link href="/" className="back">
          ← board
        </Link>
        <h1>{lc.id}</h1>
        <span className={LEVEL_CLASS[x.startReadiness.level]}>{lc.status}</span>
      </div>

      <div className="ticket-grid">
        <div>
          {/* Lifecycle banner */}
          <div className="banner" style={{ marginBottom: '0.85rem' }}>
            <div>
              <b>{lc.repo ?? 'X'}</b> · {lc.type ?? '—'} · {lc.priority ?? '—'} · {lc.status}
              {lc.owner ? (
                <> · owner <code>{String(redact('identity', lc.owner, role))}</code></>
              ) : (
                <> · unassigned</>
              )}
            </div>
            {lc.description ? <div style={{ marginTop: '0.4rem' }}>{lc.description}</div> : null}
            <div style={{ marginTop: '0.4rem' }}>
              prompt coverage:{' '}
              {lc.promptCoverage ? (
                <code>{lc.promptPath}</code>
              ) : (
                <span className="rl rl--blocked">none registered</span>
              )}
            </div>
          </div>

          {/* Operator views — filtered evidence dossier + cost ledger */}
          <section className="panel" style={{ marginBottom: '0.85rem' }}>
            <h3>Operator views</h3>
            <div className="card__title">
              <Link href={`/evidence?ticket=${lc.id}`} className="kv-row__k">
                Evidence dossier →
              </Link>{' '}
              ·{' '}
              <Link href={`/cost?ticket=${lc.id}`} className="kv-row__k">
                Cost ledger →
              </Link>
            </div>
          </section>

          {/* Next safe commands — display only */}
          <section className="panel" style={{ marginBottom: '0.85rem' }}>
            <h3>Next safe commands</h3>
            <pre className="cmd-list">{x.nextCommands.join('\n')}</pre>
            <div className="card__title">Copy/paste only — this panel never executes commands.</div>
          </section>

          {/* Dependency blockers */}
          <section className="panel" style={{ marginBottom: '0.85rem' }}>
            <SectionHead title="Dependencies" section={x.dependencies} />
            {x.dependencies.detail && x.dependencies.detail.length > 0 ? (
              <div className="kv-rows">
                {x.dependencies.detail.map((d) => (
                  <div className="kv-row" key={d.id}>
                    <Link href={`/ticket/${d.id}`} className="kv-row__k">
                      {d.id}
                    </Link>
                    <span className={d.blocking ? 'rl rl--blocked' : 'rl rl--ready'}>
                      {d.status}
                      {d.blocking ? ' · blocking' : ' · clear'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="card__title">No dependencies declared.</div>
            )}
          </section>

          {/* Self-review cycles */}
          <section className="panel" style={{ marginBottom: '0.85rem' }}>
            <SectionHead title="Self-review cycles" section={x.reviewReadiness} />
            {x.reviewCycles.length === 0 ? (
              <div className="card__title">No self-review cycles recorded yet.</div>
            ) : (
              <div className="kv-rows">
                {x.reviewCycles.map((c, i) => (
                  <div className="kv-row kv-row--col" key={`${c.cycle ?? i}`}>
                    <div>
                      <b>
                        cycle {c.cycle ?? i + 1}
                        {c.total ? `/${c.total}` : ''}
                      </b>{' '}
                      <span className={c.verdict === 'pass' ? 'rl rl--ready' : 'rl rl--pending'}>
                        {c.verdict ?? '—'}
                      </span>{' '}
                      {c.lens ? <code>{c.lens}</code> : null}
                    </div>
                    {c.risks.length > 0 ? (
                      <div className="card__title">risks: {c.risks.join('; ')}</div>
                    ) : null}
                    {c.findings ? <div className="card__title">findings: {c.findings}</div> : null}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Recent events */}
          <section className="panel">
            <h3>Recent events ({x.events.length})</h3>
            <div className="timeline">
              {x.events.length === 0 ? (
                <div className="card__title">No events for this ticket yet.</div>
              ) : (
                x.events.map((ev, i) => <EventRow key={`${ev.ts}-${i}`} ev={ev} role={role} />)
              )}
            </div>
          </section>
        </div>

        <aside className="side-panel">
          {/* Status / owner / lock / worktree */}
          <section className="panel">
            <SectionHead title="Start readiness" section={x.startReadiness} />
            {x.startReadiness.detail && x.startReadiness.detail.length > 0 ? (
              <ul className="reason-list">
                {x.startReadiness.detail.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : (
              <div className="card__title">{x.startReadiness.headline}.</div>
            )}
          </section>

          <section className="panel">
            <h3>Lock / worktree</h3>
            {lock.present ? (
              <dl>
                <dt>owner</dt>
                <dd>{String(redact('identity', lock.owner, role) ?? '—')}</dd>
                <dt>agent</dt>
                <dd>{String(redact('identity', lock.agentId, role) ?? '—')}</dd>
                <dt>branch</dt>
                <dd>{lock.branch ?? '—'}</dd>
                <dt>worktree</dt>
                <dd>{lock.worktree ? String(redact('path', lock.worktree, role)) : '—'}</dd>
                <dt>session</dt>
                <dd>{String(redact('identity', lock.sessionId, role) ?? '—')}</dd>
                <dt>started</dt>
                <dd>{lock.startedAt ?? '—'}</dd>
                <dt>heartbeat</dt>
                <dd>{lock.heartbeatAt ?? '—'}</dd>
              </dl>
            ) : (
              <div className="card__title">No active lock.</div>
            )}
          </section>

          <section className="panel">
            <SectionHead title="Requirement closure" section={x.requirementClosure} />
            {x.requirementClosure.detail?.recorded ? (
              <ul className="reason-list">
                {x.requirementClosure.detail.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            ) : (
              <div className="card__title">{x.requirementClosure.headline}.</div>
            )}
          </section>

          <section className="panel">
            <SectionHead title="Feature proof" section={x.featureProof} />
            {x.featureProof.detail && x.featureProof.detail.some((f) => !f.placeholder) ? (
              <ul className="reason-list">
                {x.featureProof.detail
                  .filter((f) => !f.placeholder)
                  .map((f, i) => (
                    <li key={i}>
                      <code>{f.raw}</code>
                    </li>
                  ))}
              </ul>
            ) : (
              <div className="card__title">{x.featureProof.headline}.</div>
            )}
          </section>

          <section className="panel">
            <SectionHead title="Repo gates" section={x.repoGates} />
            {x.repoGates.detail && x.repoGates.detail.some((g) => !g.placeholder) ? (
              <ul className="reason-list">
                {x.repoGates.detail
                  .filter((g) => !g.placeholder)
                  .map((g, i) => (
                    <li key={i}>{g.raw}</li>
                  ))}
              </ul>
            ) : (
              <div className="card__title">{x.repoGates.headline}.</div>
            )}
          </section>

          <section className="panel">
            <h3>Review findings ({x.findings.length})</h3>
            {x.findings.length === 0 ? (
              <div className="card__title">No review findings filed.</div>
            ) : (
              <div className="kv-rows">
                {x.findings.map((f) => (
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

          <section className="panel">
            <h3>PR / landing evidence</h3>
            {x.prRefs.length === 0 && !x.landing.present ? (
              <div className="card__title">
                {x.lifecycle.status === 'done'
                  ? 'Done, but no PR/landing record found.'
                  : 'No landing record yet.'}
              </div>
            ) : (
              <dl>
                {x.prRefs.length > 0 ? (
                  <>
                    <dt>pr refs</dt>
                    <dd>{String(redact('pr', x.prRefs.join(', '), role))}</dd>
                  </>
                ) : null}
                {x.landing.present ? (
                  <>
                    <dt>method</dt>
                    <dd>{x.landing.method ?? '—'}</dd>
                    <dt>base</dt>
                    <dd>{x.landing.baseRef ?? '—'}</dd>
                    <dt>commit</dt>
                    <dd>{String(redact('identity', x.landing.commitSha, role) ?? '—')}</dd>
                    <dt>provenance</dt>
                    <dd>{x.landing.provenanceStatus ?? '—'}</dd>
                    <dt>landed</dt>
                    <dd>{x.landing.recordedAt ? fmtTs(x.landing.recordedAt) : '—'}</dd>
                  </>
                ) : null}
              </dl>
            )}
            {x.landing.evidence.length > 0 ? (
              <ul className="reason-list" style={{ marginTop: '0.5rem' }}>
                {x.landing.evidence.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="panel">
            <h3>Waivers / follow-up exceptions</h3>
            {x.waivers.length === 0 && !x.followupException ? (
              <div className="card__title">No waivers or follow-up exceptions.</div>
            ) : (
              <>
                {x.waivers.map((w, i) => (
                  <div className="kv-row kv-row--col" key={i}>
                    <div>
                      <span className="rl rl--pending">waiver</span> <code>{w.code}</code>
                      {w.recordedBy ? <> · {String(redact('identity', w.recordedBy, role))}</> : null}
                    </div>
                    <div className="card__title">{w.reason}</div>
                  </div>
                ))}
                {x.followupException ? (
                  <div className="kv-row kv-row--col">
                    <div>
                      <span className="rl rl--pending">follow-up</span>{' '}
                      <code>{x.followupException.type ?? 'exception'}</code>
                      {x.followupException.parent ? <> · parent {x.followupException.parent}</> : null}
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
