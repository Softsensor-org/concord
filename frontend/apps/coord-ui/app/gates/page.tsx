import { loadGates } from '../../lib/gates';

function statusClass(s?: string): string {
  if (s === 'pass') return 'gate-status gate-status--pass';
  if (!s) return 'gate-status';
  return 'gate-status gate-status--fail';
}

function fmtMs(ms?: number): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function GatesPage() {
  const g = loadGates();
  const repoNames = [...new Set(g.results.map((r) => r.repo))];
  const laneNames = [...new Set(g.results.map((r) => r.lane))];
  return (
    <>
      <div className="board-meta">
        <span>
          passing: <strong>{g.passing}</strong>
        </span>
        <span>
          failing: <strong>{g.failing}</strong>
        </span>
        <span>missing: {g.missing}</span>
        <span>non-authoritative: {g.nonAuthoritative}</span>
        <span>{repoNames.join(' + ') || 'no repos'} × {laneNames.join('/')}</span>
      </div>

      <div className="git-grid">
        {g.results.map((r) => (
          <section key={`${r.repo}-${r.lane}`} className="panel">
            <h3>
              {r.repo} · gate:{r.lane}{' '}
              <span className={statusClass(r.status)}>
                {r.found ? (r.status ?? 'unknown') : 'no artifact'}
              </span>
            </h3>
            {!r.found ? (
              <div className="card__title">No {r.lane}.latest.json under {r.repo}/artifacts/gates/</div>
            ) : (
              <>
                <dl className="git-meta">
                  <dt>branch</dt>
                  <dd>{r.branch ?? '—'} @ {r.commit ?? '—'}</dd>
                  <dt>source</dt>
                  <dd>{r.source ?? '—'}</dd>
                  <dt>duration</dt>
                  <dd>
                    {fmtMs(r.durationMs)}
                    {r.budgetTargetMs ? ` / ${fmtMs(r.budgetTargetMs)} budget (${r.budgetStatus})` : ''}
                  </dd>
                  <dt>authority</dt>
                  <dd
                    className={
                      r.authorityStatus && r.authorityStatus !== 'authoritative'
                        ? 'gate-status--fail'
                        : ''
                    }
                  >
                    {r.authorityStatus ?? '—'}
                  </dd>
                  <dt>age</dt>
                  <dd>{r.ageHours != null ? `${r.ageHours}h ago` : '—'}</dd>
                </dl>
                {r.authorityReason ? (
                  <div className="card__title" style={{ marginBottom: '0.5rem' }}>
                    {r.authorityReason}
                  </div>
                ) : null}
                {r.steps.length > 0 ? (
                  <div className="git-changes">
                    {r.steps.map((s) => (
                      <div key={s.name} className="git-change">
                        <span className={statusClass(s.status)}>{s.status}</span>
                        <span className="git-file">{s.name}</span>
                        <span className="agent-seen">{fmtMs(s.duration_ms)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
