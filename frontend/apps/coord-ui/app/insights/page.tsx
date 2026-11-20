import { loadInsights, claimLabel, claimMetrics } from '../../lib/insights';

export const dynamic = 'force-dynamic';

const SECTION_TITLE: Record<string, string> = {
  repeated_failure_themes: 'Repeated failure themes',
  architectural_debt_by_subsystem: 'Architectural debt by subsystem',
  churn_instead_of_value: 'Churn instead of value',
  gate_review_recovery_health_by_repo: 'Gate / review / recovery health by repo'
};

export default function InsightsPage() {
  const m = loadInsights();

  return (
    <>
      <div className="board-meta">
        <span>
          history: <strong>{m.historyScope.journal_events}</strong> events
        </span>
        <span>
          <strong>{m.historyScope.board_tickets}</strong> tickets · <strong>{m.historyScope.plan_records}</strong> plans
        </span>
        <span>
          sections: <strong>{m.sections.length}</strong>
        </span>
        <span>recommends-only — mined from real history, never authority</span>
      </div>

      {!m.found ? (
        <section className="action-center">
          <article className="ac-card ac-card--wide">
            <h2 className="ac-card__title">Insights unavailable</h2>
            <div className="ac-ok">
              Generate the report: <code>coord/scripts/gov insights --json</code>
            </div>
          </article>
        </section>
      ) : (
        <section className="action-center">
          {m.sections.map((s) => (
            <article key={s.section} className="ac-card ac-card--wide">
              <h2 className="ac-card__title">{SECTION_TITLE[s.section] ?? s.section}</h2>
              {s.thinSignal ? (
                <div className="ac-ok">Thin signal — not enough history yet to be confident.</div>
              ) : s.claims.length === 0 ? (
                <div className="ac-ok">No findings.</div>
              ) : (
                <ul className="ac-rows">
                  {s.claims.slice(0, 8).map((c, i) => (
                    <li key={i} className="ac-stat">
                      <span className="ac-row__id">{claimLabel(c)}</span>{' '}
                      <span className="ac-muted">{claimMetrics(c)}</span>
                    </li>
                  ))}
                  {s.claims.length > 8 ? (
                    <li className="ac-stat ac-muted">+{s.claims.length - 8} more</li>
                  ) : null}
                </ul>
              )}
            </article>
          ))}
        </section>
      )}
    </>
  );
}
