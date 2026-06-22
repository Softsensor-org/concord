import { loadTests } from '../../lib/tests';

function stepClass(s?: string): string {
  if (s === 'pass') return 'gate-status gate-status--pass';
  if (!s) return 'gate-status';
  return 'gate-status gate-status--fail';
}

export default function TestsPage() {
  const t = loadTests();
  return (
    <>
      <div className="board-meta">
        <span>
          test files: <strong>{t.totalTestFiles}</strong>
        </span>
        <span>
          failing lane steps: <strong>{t.failingLaneSteps}</strong>
        </span>
        <span>maturity: {t.maturity.notRun ? 'not yet run' : 'tracked'}</span>
        <span>sources: gate steps · file walk · TEST_MATURITY.md</span>
      </div>

      <h3 className="section-h">Test-file inventory</h3>
      <div className="git-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
        {t.inventory.map((inv) => (
          <section key={inv.repo} className="panel">
            <h3>
              {inv.repo}{' '}
              <span className="git-branch">
                {inv.exists ? `${inv.totalTestFiles} test files` : '(repo not found)'}
              </span>
            </h3>
            <dl className="git-meta">
              {Object.entries(inv.byExt)
                .sort()
                .map(([ext, n]) => (
                  <FragmentRow key={ext} k={ext} v={String(n)} />
                ))}
              {Object.keys(inv.byExt).length === 0 ? (
                <FragmentRow k="—" v="no test files" />
              ) : null}
            </dl>
          </section>
        ))}
      </div>

      <h3 className="section-h">Gate test lanes</h3>
      <div className="git-grid">
        {t.laneStatuses.map((l) => (
          <section key={`${l.repo}-${l.lane}`} className="panel">
            <h3>
              {l.repo} · {l.lane}{' '}
              <span className={stepClass(l.found ? l.status : undefined)}>
                {l.found ? (l.status ?? 'unknown') : 'no artifact'}
              </span>
            </h3>
            {l.steps.length === 0 ? (
              <div className="card__title">No recorded steps.</div>
            ) : (
              <div className="git-changes">
                {l.steps.map((s) => (
                  <div key={s.name} className="git-change">
                    <span className={stepClass(s.status)}>{s.status}</span>
                    <span className="git-file">{s.name}</span>
                    <span className="agent-seen">
                      {s.duration_ms != null
                        ? s.duration_ms < 1000
                          ? `${s.duration_ms}ms`
                          : `${(s.duration_ms / 1000).toFixed(1)}s`
                        : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      <h3 className="section-h">Maturity tracker (coord/TEST_MATURITY.md)</h3>
      {t.maturity.found ? (
        <div className="ticket-spec">
          {t.maturity.notRun ? (
            <div className="banner" style={{ marginBottom: '0.75rem' }}>
              Maturity tracker has not been generated yet. Run <code>/test-strategy</code> to
              populate dimension coverage and the gap backlog.
            </div>
          ) : null}
          <pre>{t.maturity.raw}</pre>
        </div>
      ) : (
        <div className="banner">TEST_MATURITY.md not found in coord/.</div>
      )}

      <div className="banner" style={{ marginTop: '1rem' }}>
        Coverage percentages are not persisted in the workspace — they are computed
        transiently inside <code>gate:full</code> and not written to an artifact. This view
        reports lane pass/fail and file inventory, not line/branch coverage %.
      </div>
    </>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
