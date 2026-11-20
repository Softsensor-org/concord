import Link from 'next/link';
import { loadAdrs } from '../../lib/adrs';
import type { AdrEntry } from '../../lib/adrs';

export const dynamic = 'force-dynamic';

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'accepted') return 'pill pill--p2';
  if (s === 'superseded') return 'pill';
  if (s === 'rejected') return 'pill pill--p0';
  if (s === 'deferred' || s === 'proposed') return 'pill pill--p1';
  return 'pill';
}

function ticketLinks(ids: string[]) {
  if (!ids || ids.length === 0) return <span className="ac-muted">—</span>;
  return (
    <>
      {ids.map((t) => (
        <Link key={t} href={`/ticket/${t}`} className="ac-row__id" style={{ marginRight: '0.4rem' }}>
          {t}
        </Link>
      ))}
    </>
  );
}

function AdrRow({ adr }: { adr: AdrEntry }) {
  return (
    <article className="ac-card">
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="ac-row__id">{adr.id}</span>
        <span className={statusClass(adr.status)}>{adr.status}</span>
        <strong style={{ fontSize: '0.9rem' }}>{adr.title}</strong>
      </div>
      <div className="ac-stat">
        tickets: {ticketLinks(adr.linked_tickets)}
      </div>
      {adr.linked_requirements && adr.linked_requirements.length > 0 ? (
        <div className="ac-stat">requirements: {adr.linked_requirements.join(', ')}</div>
      ) : null}
      {adr.affected_repos && adr.affected_repos.length > 0 ? (
        <div className="ac-stat ac-muted">scope: {adr.affected_repos.join(', ')}
          {adr.affected_modules && adr.affected_modules.length > 0 ? ` · ${adr.affected_modules.join(', ')}` : ''}
        </div>
      ) : null}
      {adr.superseded_by ? (
        <div className="ac-stat ac-warn">superseded by {adr.superseded_by}</div>
      ) : null}
      {adr.supersedes && adr.supersedes.length > 0 ? (
        <div className="ac-stat ac-muted">supersedes {adr.supersedes.join(', ')}</div>
      ) : null}
      {adr.revisit_trigger ? (
        <div className="ac-stat ac-muted">revisit when: {adr.revisit_trigger}</div>
      ) : null}
    </article>
  );
}

export default function AdrsPage() {
  const model = loadAdrs();
  const { summary, adrs, decision_required_missing_adrs: missing, supersession_chains } = model;

  return (
    <>
      <div className="board-meta">
        <span>
          ADRs: <strong>{summary.adrs}</strong>
        </span>
        <span>
          accepted: <strong>{summary.accepted}</strong> · deferred: <strong>{summary.deferred}</strong> ·
          superseded: <strong>{summary.superseded}</strong>
        </span>
        <span>
          decision-required missing ADR: <strong>{summary.missing_adr_tickets}</strong>
        </span>
        <span>
          findings: <strong>{summary.findings}</strong>
        </span>
      </div>

      {!model.found ? (
        <section className="action-center">
          <article className="ac-card ac-card--wide">
            <h2 className="ac-card__title">No decision records yet</h2>
            <div className="ac-ok">
              Create the first ADR with <code>{model.commands.create_adr}</code>
            </div>
          </article>
        </section>
      ) : null}

      {missing.length > 0 ? (
        <section className="action-center">
          <article className="ac-card ac-card--wide">
            <h2 className="ac-card__title">Decision-required tickets missing an accepted ADR</h2>
            <ul className="ac-rows">
              {missing.slice(0, 12).map((m, i) => {
                const id = m.ticket ?? m.id ?? `row-${i}`;
                return (
                  <li key={String(id)}>
                    <Link href={`/ticket/${id}`} className="ac-row">
                      <span className="ac-row__id">{String(id)}</span>
                      <span className="ac-row__desc">{m.title ?? ''}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </article>
        </section>
      ) : null}

      <section className="action-center">
        {adrs.map((adr) => (
          <AdrRow key={adr.id} adr={adr} />
        ))}
      </section>

      {supersession_chains.length > 0 ? (
        <section className="action-center">
          <article className="ac-card ac-card--wide">
            <h2 className="ac-card__title">Supersession chains</h2>
            <ul className="ac-rows">
              {supersession_chains.map((chain) => (
                <li key={chain.current} className="ac-stat">
                  {chain.history.join(' → ')} <strong>(current: {chain.current})</strong>
                </li>
              ))}
            </ul>
          </article>
        </section>
      ) : null}
    </>
  );
}
