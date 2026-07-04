import { loadKnowledge } from '../../lib/knowledge';

export const dynamic = 'force-dynamic';

function stat(model: Record<string, number>, key: string): number {
  return model[key] ?? 0;
}

function ChipList({ items, tone = 'warn' }: { items: string[]; tone?: 'warn' | 'crit' | 'p2' }) {
  if (items.length === 0) return <span className="ac-muted">—</span>;
  const cls = tone === 'p2' ? 'pill pill--p2' : `ac-chip ac-chip--${tone}`;
  return (
    <>
      {items.map((item) => (
        <span key={item} className={cls} style={{ marginRight: '0.3rem', marginBottom: '0.25rem' }}>
          {item}
        </span>
      ))}
    </>
  );
}

export default function KnowledgePage() {
  const k = loadKnowledge();

  return (
    <>
      <div className="board-meta">
        <span>
          board facts: <strong>{stat(k.counts, 'boardRows')}</strong>
        </span>
        <span>
          plan records: <strong>{stat(k.counts, 'planRecords')}</strong>
        </span>
        <span>
          journal events: <strong>{stat(k.counts, 'journalEvents')}</strong>
        </span>
        <span>
          context refs: <strong>{stat(k.counts, 'contextRefs')}</strong>
        </span>
        <span>read-only — memory recommends, governance decides</span>
      </div>

      {!k.found ? (
        <section className="action-center">
          <article className="ac-card ac-card--wide">
            <h2 className="ac-card__title">Knowledge engine unavailable</h2>
            <div className="ac-ok">The memory engine modules could not be loaded from coord/scripts.</div>
          </article>
        </section>
      ) : (
        <>
          <section className="action-center">
            <article className="ac-card ac-card--wide">
              <h2 className="ac-card__title">{k.contract.name}</h2>
              <div className="ac-stat">{k.contract.purpose}</div>
              <div className="ac-stat ac-muted">{k.contract.guardrail}</div>
            </article>

            <article className="ac-card">
              <h2 className="ac-card__title">Continuity ladder</h2>
              <div className="ac-stat">
                <ChipList items={k.ladder.states} />
              </div>
              <div className="ac-stat">
                context packs: <strong>{k.ladder.contextPackStates.join(', ') || '—'}</strong>
              </div>
            </article>

            <article className="ac-card">
              <h2 className="ac-card__title">Current knowledge base</h2>
              <div className="ac-stat">
                <strong>{stat(k.counts, 'requirementClosures')}</strong> closures ·{' '}
                <strong>{stat(k.counts, 'selfReviewCycles')}</strong> review cycles
              </div>
              <div className="ac-stat">
                <strong>{stat(k.counts, 'adrs')}</strong> ADRs · <strong>{stat(k.counts, 'questions')}</strong>{' '}
                questions
              </div>
              {k.sparseMemoryWarning ? <div className="ac-warn">Sparse derived recall cache.</div> : null}
            </article>

            <article className="ac-card">
              <h2 className="ac-card__title">Classification</h2>
              <div className="ac-stat">
                <ChipList items={k.classification.classes} tone="p2" />
              </div>
              <div className="ac-stat ac-muted">scopes: {k.classification.scopes.join(', ') || '—'}</div>
            </article>

            <article className="ac-card">
              <h2 className="ac-card__title">Retrieval views</h2>
              <div className="ac-stat">
                vector role: <strong>{k.vector.role}</strong>
              </div>
              <div className="ac-stat">
                local dim: <strong>{k.vector.defaultDim || '—'}</strong> · default:{' '}
                <strong>{k.vector.enabledByDefault ? 'on' : 'off'}</strong>
              </div>
              <div className="ac-stat ac-muted">vectors are retrieval views, never evidence.</div>
            </article>

            <article className="ac-card">
              <h2 className="ac-card__title">Eval harness</h2>
              <div className="ac-stat">
                <strong>{k.eval.cases}</strong> benchmark cases
              </div>
              <div className="ac-stat">
                <code>{k.eval.command}</code>
              </div>
            </article>
          </section>

          {k.derivedIndexes.warnings.length > 0 || k.missingContext.length > 0 ? (
            <section className="action-center">
              <article className="ac-card ac-card--wide">
                <h2 className="ac-card__title">Missing or stale knowledge inputs</h2>
                <ul className="ac-rows">
                  {k.missingContext.map((m) => (
                    <li key={`${m.item}:${m.reason}`} className="ac-stat">
                      <span className="ac-row__id">{m.priority}</span> {m.item}{' '}
                      <span className="ac-muted">({m.sourceType}) — {m.reason}</span>
                    </li>
                  ))}
                  {k.derivedIndexes.warnings.map((w) => (
                    <li key={`${w.code}:${w.source}`} className="ac-stat">
                      <span className="ac-row__id">{w.code}</span> {w.message}{' '}
                      {w.action ? <span className="ac-muted">— {w.action}</span> : null}
                    </li>
                  ))}
                </ul>
              </article>
            </section>
          ) : null}

          <section className="action-center">
            <article className="ac-card ac-card--wide">
              <h2 className="ac-card__title">What feeds context packs</h2>
              <ul className="ac-rows">
                {k.sampleFacts.map((f) => (
                  <li key={f.id} className="ac-stat">
                    <span className="pill pill--repo">{f.type}</span>{' '}
                    <span className={f.status === 'robust' ? 'pill pill--p2' : 'pill pill--p1'}>{f.status}</span>{' '}
                    {f.statement}
                    {f.ticketId ? <span className="ac-muted"> [{f.ticketId}]</span> : null}
                  </li>
                ))}
              </ul>
            </article>
          </section>
        </>
      )}
    </>
  );
}
