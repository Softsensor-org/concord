import { notFound } from 'next/navigation';
import { requireRole, redact } from '../../../../lib/access';
import { loadResolvedPolicy } from '../../../../lib/testing-policy-view';

/**
 * COORD-939 — READ-ONLY resolved-policy view for one ticket or branch.
 *
 * Shows the stages, the checks each names, recorded exceptions, and the governed
 * resolver command that computes what a diff selects. The reference is validated
 * (ticket id or branch name) and is never used to build a path or to run git.
 */
export const dynamic = 'force-dynamic';

export default async function ResolvedPolicyPage({ params }: { params: Promise<{ ref: string }> }) {
  const role = await requireRole('viewer');
  const { ref: raw } = await params;
  const view = loadResolvedPolicy(decodeURIComponent(raw));
  if (!view) notFound();

  return (
    <>
      <div className="board-meta">
        <span>
          {view.kind}: <strong>{view.ref}</strong>
        </span>
        <span>
          repo: <strong>{view.repo ?? 'unknown'}</strong>
        </span>
        <span>status: <strong>{view.status ?? 'not on board'}</strong></span>
        <span>read-only</span>
      </div>

      <div className="banner" role="note">
        {view.note}
      </div>

      <h3 className="section-h">Commands</h3>
      <ul>
        {view.commands.map((c) => (
          <li key={c.stage}>
            <code className="event__cmd">{c.command}</code> <span className="agent-seen">({c.stage})</span>
          </li>
        ))}
      </ul>

      <h3 className="section-h">Stages and named checks</h3>
      {view.stages.map((s) => (
        <section key={s.name} aria-labelledby={`resolved-${s.name}`}>
          <h4 id={`resolved-${s.name}`}>{s.name}</h4>
          <p>{s.purpose}</p>
          <ul>
            {s.checks.map((c) => (
              <li key={c.scope}>
                <strong>{c.scope}</strong>: {c.checks.length ? c.checks.join(', ') : 'none'}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <h3 className="section-h">Exceptions for this ticket ({view.exceptions.length})</h3>
      {view.exceptions.length === 0 ? (
        <p>No exceptions are recorded for this ticket.</p>
      ) : (
        <ul>
          {view.exceptions.map((e) => (
            <li key={e.id}>
              {e.kind} / {e.stage}: {e.items.join(', ') || 'none'}; {e.reason}
              {e.withdrawn ? ' (withdrawn)' : ''}
              {e.recordedBy ? `; recorded by ${String(redact('identity', e.recordedBy, role))}` : ''}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
