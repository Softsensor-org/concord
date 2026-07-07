import { loadTracks } from '../../lib/tracks';

export const dynamic = 'force-dynamic';

function riskClassLabel(value: string): string {
  return value || 'R4';
}

export default function TracksPage() {
  const model = loadTracks();

  return (
    <>
      <div className="board-meta">
        <span>
          tracks: <strong>{model.tracks.length}</strong>
        </span>
        <span>
          prefixes: <strong>{model.prefixMap.length}</strong>
        </span>
        <span>
          default: <strong>{model.defaultTrack}</strong>
        </span>
        <span>read-only — ticket classification still runs through gov gate-plan</span>
      </div>

      {!model.found ? (
        <section className="action-center">
          <article className="ac-card ac-card--wide">
            <h2 className="ac-card__title">Track registry unavailable</h2>
            <div className="ac-warn">Expected coord/scripts/track-registry.js and coord/gates/track-evidence-policy.json</div>
          </article>
        </section>
      ) : null}

      <section className="action-center">
        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Multi-track governance profile</h2>
          <div className="ac-stat">
            Track selects the default gate procedure and evidence expectations; risk class decides when evidence becomes blocking.
          </div>
          <ul className="ac-rows">
            {model.sourcePaths.map((source) => (
              <li key={source} className="ac-stat ac-muted">
                {source}
              </li>
            ))}
          </ul>
        </article>

        <article className="ac-card">
          <h2 className="ac-card__title">Ticket prefixes</h2>
          {model.prefixMap.length > 0 ? (
            <ul className="ac-rows">
              {model.prefixMap.map((entry) => (
                <li key={entry.prefix} className="ac-stat">
                  <strong>{entry.prefix}</strong> {'->'} {entry.track}
                </li>
              ))}
            </ul>
          ) : (
            <div className="ac-ok">No configured prefixes; all tickets fall back to development.</div>
          )}
        </article>
      </section>

      <section className="action-center">
        {model.tracks.map((track) => (
          <article key={track.name} className="ac-card">
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span className="pill pill--p2">{track.gateProc}</span>
              <strong style={{ fontSize: '0.9rem' }}>{track.name}</strong>
            </div>
            <dl className="ticket-kv">
              <dt>lane</dt>
              <dd>{track.defaultLane}</dd>
              <dt>operator</dt>
              <dd>{track.operator || 'not set'}</dd>
              <dt>approvers</dt>
              <dd>{track.approvers ?? 'not set'}</dd>
            </dl>
            <div className="ac-stat ac-muted">
              prefixes: {track.prefixes.length > 0 ? track.prefixes.join(', ') : 'fallback / override only'}
            </div>
            <div className="ac-stat ac-muted">
              artifacts: {track.requiredArtifacts.length > 0 ? track.requiredArtifacts.join(', ') : 'none declared'}
            </div>
            {track.evidence.length > 0 ? (
              <ul className="ac-rows">
                {track.evidence.map((evidence) => (
                  <li key={evidence.id} className="ac-stat">
                    <strong>{riskClassLabel(evidence.blockingFrom)}+</strong> {evidence.label}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="ac-ok">No extra evidence policy.</div>
            )}
            <div className="ac-stat ac-muted">
              skills: {track.skills.length > 0 ? track.skills.join(', ') : 'none declared'}
            </div>
          </article>
        ))}
      </section>

      <section className="action-center">
        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Data analytics profile</h2>
          <div className="ac-stat">
            Gate procedure: <strong>{model.dataAnalytics.gateProc}</strong>
          </div>
          <div className="ac-stat ac-muted">
            Required artifacts: {model.dataAnalytics.requiredArtifacts.join(', ') || 'not declared'}
          </div>
          <div className="ac-stat">Data quality checks</div>
          <ul className="ac-rows">
            {model.dataAnalytics.qualityChecks.map((check) => (
              <li key={check} className="ac-stat ac-muted">
                {check}
              </li>
            ))}
          </ul>
          <div className="ac-stat">Lifecycle invariants</div>
          <ul className="ac-rows">
            {model.dataAnalytics.lifecycleInvariants.map((invariant) => (
              <li key={invariant} className="ac-stat ac-muted">
                {invariant}
              </li>
            ))}
          </ul>
        </article>

        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Bootstrap/backfill overlay</h2>
          <div className="ac-stat">
            High-risk classes: {model.bootstrapOverlay.highRiskClasses.join(', ') || 'none'}
          </div>
          <ul className="ac-rows">
            {model.bootstrapOverlay.required.map((entry) => (
              <li key={entry.id} className="ac-stat ac-muted">
                {entry.label}
              </li>
            ))}
          </ul>
        </article>
      </section>
    </>
  );
}
