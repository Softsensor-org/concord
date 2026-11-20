import { loadTriage, triageCliHint } from '../../lib/triage';
import type { TriageItem } from '../../lib/triage';

// The view reads board/tasks.json at request time (read-only fs), so it must
// render dynamically rather than be statically cached at build.
export const dynamic = 'force-dynamic';

// Priority pill. Only p0/p1/p2 have a styled variant in globals.css; lower
// priorities (P3) degrade to the neutral base pill.
function priClass(pri: string | null): string {
  const p = (pri ?? '').toLowerCase();
  if (p === 'p0' || p === 'p1' || p === 'p2') return `pill pill--${p}`;
  return 'pill';
}

function TriageCard({ item }: { item: TriageItem }) {
  const hint = triageCliHint(item.id);
  return (
    <div className="kv-row kv-row--col">
      <div>
        <span className={priClass(item.priority)}>{item.priority ?? 'P?'}</span>{' '}
        <strong>{item.id}</strong>
        {item.type ? (
          <>
            {' '}
            · <code>{item.type}</code>
          </>
        ) : null}
        {item.repo ? <span className="card__title"> · repo {item.repo}</span> : null}
      </div>
      <div className="card__title">{item.title}</div>
      <div>
        finding:{' '}
        {item.finding ? (
          <code>{item.finding}</code>
        ) : (
          <span className="card__title">— (no structured evidence on this proposal)</span>
        )}
      </div>
      <div>
        qkey:{' '}
        {item.qkey ? (
          <code>{item.qkey}</code>
        ) : (
          <span className="card__title">— (hand-filed proposal, no dedup marker)</span>
        )}
      </div>
      <div>
        suggested fix:{' '}
        {item.suggestedFix ? (
          item.suggestedFix
        ) : (
          <span className="card__title">— (none recorded; see description)</span>
        )}
      </div>
      {/* Copyable governed CLI hints — DISPLAY ONLY. This view never approves,
          rejects, or writes anything; the action happens in the gov CLI. */}
      <pre className="cmd-list">
        {hint.approve}
        {'\n'}
        {hint.reject}
      </pre>
    </div>
  );
}

export default function TriagePage() {
  const { items, total } = loadTriage();

  return (
    <>
      <div className="board-meta">
        <span>
          triage queue (status <code>proposed</code>):{' '}
          <strong>{total}</strong>
        </span>
        <span className="card__title">read-only mirror — approve/reject happen via the CLI</span>
      </div>

      <div className="banner">
        These are machine-<strong>proposed</strong> tickets quarantined for human review (e.g. from{' '}
        <code>gov quality-scan --propose</code>). This view only <strong>displays</strong> the queue.
        To act, copy a governed command: <code>gov approve &lt;id&gt;</code> promotes a proposal to
        open work; <code>gov reject &lt;id&gt; --reason &quot;…&quot;</code> supersedes it. The
        cockpit never mutates governance state (SEC-001/002).
      </div>

      {total === 0 ? (
        <div className="banner">
          No <code>proposed</code> tickets awaiting review — the approval queue is empty. Run{' '}
          <code>gov quality-scan --severity-floor warn --cap N --apply --propose</code> to populate
          it from current code-quality debt.
        </div>
      ) : (
        <section className="panel">
          <h3>Proposed tickets awaiting approval</h3>
          <div className="kv-rows">
            {items.map((item) => (
              <TriageCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
