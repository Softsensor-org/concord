import { loadHumanAgentPlatform } from '../../lib/human-agent';

export const dynamic = 'force-dynamic';

export default function HumanAgentPage() {
  const model = loadHumanAgentPlatform();

  return (
    <>
      <div className="board-meta">
        <span>
          tranches: <strong>{model.tranches.length}</strong>
        </span>
        <span>
          authoring states: <strong>{model.authoring.statuses.length}</strong>
        </span>
        <span>{model.read_only_policy.coord_ui_may_write ? 'write-capable' : 'read-only mirror'}</span>
      </div>

      <section className="action-center">
        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Human-agent loop</h2>
          <div className="ac-stat">{model.read_only_policy.mutation_path}</div>
        </article>

        {model.tranches.map((tranche) => (
          <article key={tranche.id} className="ac-card">
            <h2 className="ac-card__title">
              {tranche.id} · {tranche.name}
            </h2>
            <div className="ac-stat">
              status <strong>{tranche.status}</strong>
            </div>
            <ul className="ac-rows">
              {tranche.capabilities.map((capability) => (
                <li key={capability} className="ac-stat">
                  {capability}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className="action-center">
        <article className="ac-card">
          <h2 className="ac-card__title">Requirement draft intent</h2>
          {model.authoring.draft_intent ? (
            <>
              <div className="ac-stat">
                verb <strong>{model.authoring.draft_intent.verb}</strong>
              </div>
              <div className="ac-stat">action {model.authoring.draft_intent.action}</div>
              <div className="ac-muted">writer {model.authoring.draft_intent.writer?.queue_key || 'not configured'}</div>
            </>
          ) : (
            <div className="ac-ok">Draft intent unavailable.</div>
          )}
        </article>

        <article className="ac-card">
          <h2 className="ac-card__title">Feedback intent</h2>
          {model.authoring.feedback_intent ? (
            <>
              <div className="ac-stat">
                verb <strong>{model.authoring.feedback_intent.verb}</strong>
              </div>
              <div className="ac-stat">action {model.authoring.feedback_intent.action}</div>
              <div className="ac-muted">writer {model.authoring.feedback_intent.writer?.queue_key || 'not configured'}</div>
            </>
          ) : (
            <div className="ac-ok">Feedback intent unavailable.</div>
          )}
        </article>

        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Grooming pipeline</h2>
          <ul className="ac-rows">
            {model.authoring.grooming_pipeline.map((step) => (
              <li key={step} className="ac-stat">
                {step}
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className="action-center">
        <article className="ac-card">
          <h2 className="ac-card__title">Product-screen bridge</h2>
          <div className="ac-stat">
            status <strong>{model.screen_bridge.status}</strong>
          </div>
          <div className="ac-stat">
            <strong>{model.screen_bridge.summary.mapped}</strong> mapped ·{' '}
            <strong>{model.screen_bridge.summary.unmapped}</strong> unmapped
          </div>
        </article>

        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Screen feedback targets</h2>
          {model.screen_bridge.screens.length === 0 ? (
            <div className="ac-ok">No screen index available.</div>
          ) : (
            <ul className="ac-rows">
              {model.screen_bridge.screens.slice(0, 8).map((screen) => (
                <li key={screen.id} className="ac-stat">
                  <span className="ac-row__id">{screen.title || screen.id}</span>{' '}
                  {screen.route ? <span>{screen.route}</span> : null}
                  <div className="ac-muted">
                    {screen.mapped
                      ? `${screen.requirement_refs.length} requirement ref(s), feedback verb ${screen.feedback_intent?.verb || 'unavailable'}`
                      : screen.gap}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      <section className="action-center">
        <article className="ac-card">
          <h2 className="ac-card__title">Loop orchestration</h2>
          <div className="ac-stat">
            status <strong>{model.loop.status}</strong>
          </div>
          <div className="ac-stat">
            blockers <strong>{model.loop.blockers.length}</strong>
          </div>
        </article>

        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Run stages</h2>
          <ul className="ac-rows">
            {model.loop.stages.map((stage) => (
              <li key={stage.id} className="ac-stat">
                <span className="ac-row__id">{stage.name}</span> {stage.actor} · {stage.mode}
                <div className="ac-muted">
                  {stage.input} → {stage.output}
                </div>
              </li>
            ))}
          </ul>
        </article>

        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Evidence return</h2>
          <div className="ac-stat">
            returned to <strong>{model.loop.evidence_return.returned_to || 'unavailable'}</strong>
          </div>
          <div className="ac-muted">{model.loop.evidence_return.required.join(' · ')}</div>
        </article>
      </section>

      <section className="action-center">
        <article className="ac-card">
          <h2 className="ac-card__title">Hosted control plane</h2>
          <div className="ac-stat">
            status <strong>{model.deployment.status}</strong>
          </div>
          <div className="ac-stat">
            data-light <strong>{model.deployment.data_light_contract.valid ? 'valid' : 'blocked'}</strong>
          </div>
          <div className="ac-muted">{model.deployment.data_light_contract.canonical_authority}</div>
        </article>

        <article className="ac-card">
          <h2 className="ac-card__title">Deployment readiness</h2>
          <div className="ac-stat">
            blockers <strong>{model.deployment.readiness.blockers}</strong> · warnings{' '}
            <strong>{model.deployment.readiness.warnings}</strong>
          </div>
          <div className="ac-stat">
            tenants <strong>{model.deployment.isolation.tenants}</strong> · teams{' '}
            <strong>{model.deployment.isolation.teams}</strong> · data repos{' '}
            <strong>{model.deployment.isolation.coord_data_repos}</strong>
          </div>
        </article>

        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Deployment gaps</h2>
          {model.deployment.readiness.gaps.length === 0 ? (
            <div className="ac-ok">No hosted-plane readiness gaps in the sample topology.</div>
          ) : (
            <ul className="ac-rows">
              {model.deployment.readiness.gaps.map((gap) => (
                <li key={`${gap.code}:${gap.scope}`} className="ac-stat">
                  <span className="ac-row__id">{gap.code}</span> {gap.message}
                  <div className="ac-muted">
                    {gap.severity} · {gap.scope}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>
    </>
  );
}
