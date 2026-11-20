import Link from 'next/link';
import { loadContinuity } from '../../lib/continuity';

export const dynamic = 'force-dynamic';

export default function ContinuityPage() {
  const model = loadContinuity();
  const { summary, shapes, records, recent_events: events } = model;

  return (
    <>
      <div className="board-meta">
        <span>
          defined shapes: <strong>{summary.defined_shapes}</strong>
        </span>
        <span>
          records with continuity: <strong>{summary.with_any_continuity}</strong> / {summary.plan_records_scanned}
        </span>
        <span>
          warm-start: <strong>{summary.with_warm_start}</strong> · cold-finish:{' '}
          <strong>{summary.with_cold_finish}</strong>
        </span>
        <span>
          recent events: <strong>{summary.recent_events}</strong>
        </span>
      </div>

      {model.adoption_note ? (
        <section className="action-center">
          <article className="ac-card ac-card--wide">
            <h2 className="ac-card__title">Adoption state</h2>
            <div className="ac-ok">{model.adoption_note}</div>
          </article>
        </section>
      ) : null}

      <section className="action-center">
        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Defined continuity object shapes</h2>
          <div className="ac-stat ac-muted">
            What a warm-start / cold-finish handoff record looks like, by scope (from the engine contract).
          </div>
        </article>
        {shapes.map((s) => (
          <article key={s.shape} className="ac-card">
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
              <span className="pill pill--repo">{s.shape}</span>
            </div>
            <div className="ac-stat ac-muted">{s.scope}</div>
            {s.warm_start_fields.length > 0 ? (
              <div className="ac-stat">
                <span className="ac-muted">warm-start:</span> {s.warm_start_fields.join(', ')}
              </div>
            ) : null}
            {s.cold_finish_fields.length > 0 ? (
              <div className="ac-stat">
                <span className="ac-muted">cold-finish:</span> {s.cold_finish_fields.join(', ')}
              </div>
            ) : null}
          </article>
        ))}
      </section>

      {records.length > 0 ? (
        <section className="action-center">
          <article className="ac-card ac-card--wide">
            <h2 className="ac-card__title">Tickets with continuity records</h2>
            <ul className="ac-rows">
              {records.slice(0, 20).map((r) => (
                <li key={r.ticket}>
                  <Link href={`/ticket/${r.ticket}`} className="ac-row">
                    <span className="ac-row__id">{r.ticket}</span>
                    <span className="ac-row__desc">
                      {r.warm_start ? 'warm-start' : ''}
                      {r.warm_start && r.cold_finish ? ' · ' : ''}
                      {r.cold_finish ? 'cold-finish' : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </article>
        </section>
      ) : null}

      {events.length > 0 ? (
        <section className="action-center">
          <article className="ac-card ac-card--wide">
            <h2 className="ac-card__title">Recent continuity events</h2>
            <ul className="ac-rows">
              {events.map((e, i) => (
                <li key={i} className="ac-stat">
                  <code>{e.command}</code> {e.ticket ?? ''} <span className="ac-muted">{e.recorded_at ?? ''}</span>
                </li>
              ))}
            </ul>
          </article>
        </section>
      ) : null}
    </>
  );
}
