import { loadHealth } from '../../lib/health';
import type { CheckLevel } from '../../lib/health';

const LEVEL_CLASS: Record<CheckLevel, string> = {
  ok: 'hc hc--ok',
  warn: 'hc hc--warn',
  fail: 'hc hc--fail'
};

const LEVEL_LABEL: Record<CheckLevel, string> = {
  ok: 'OK',
  warn: 'WARN',
  fail: 'FAIL'
};

export const dynamic = 'force-dynamic';

export default function HealthPage() {
  const h = loadHealth();
  return (
    <>
      <div className="board-meta">
        <span>
          overall:{' '}
          <strong className={LEVEL_CLASS[h.overall]}>{LEVEL_LABEL[h.overall]}</strong>
        </span>
        <span>{h.checks.length} checks</span>
        <span>derived from locks · snapshot · QUESTIONS.md · gate artifacts</span>
      </div>

      <div className="issues">
        {h.checks.map((c) => (
          <div key={c.name} className="issue" style={{ gridTemplateColumns: '70px 220px 1fr' }}>
            <span className={LEVEL_CLASS[c.level]}>{LEVEL_LABEL[c.level]}</span>
            <span className="issue-summary" style={{ fontWeight: 600 }}>
              {c.name}
            </span>
            <span className="issue-summary">{c.detail}</span>
          </div>
        ))}
      </div>

      <div className="banner" style={{ marginTop: '1rem' }}>
        This is a read-only re-derivation of common <code>gov doctor</code> signals. It does
        not mutate state or run recovery. For authoritative diagnostics run{' '}
        <code>coord/scripts/gov doctor</code>.
      </div>
    </>
  );
}
