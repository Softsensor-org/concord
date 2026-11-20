import { requireRole, redact } from '../../lib/access';
import { loadTestingPolicy } from '../../lib/testing-policy-view';
import ProposalForm from './proposal-form';
import { loadPendingConfigProposals } from '../../lib/config-proposals';

/**
 * COORD-939 — READ-ONLY "Testing policy" view.
 *
 * Shows the versioned testing policy (stages, branch-to-stage aliases, checks,
 * selection settings), the adopter override, recorded ticket exceptions, the
 * scheduled-run and promotion records, and the adopter configuration rows.
 * Read data remains read-only. Operators may submit an inert config proposal
 * through the governed CLI route; this page has no approval or apply control.
 * Approver and recorder identities are redacted for viewer role (SEC-001).
 */
export const dynamic = 'force-dynamic';

export default async function TestingPolicyPage() {
  const role = await requireRole('viewer');
  const view = loadTestingPolicy();
  const policy = view.policy;
  const pendingConfigProposals = loadPendingConfigProposals();

  return (
    <>
      <div className="board-meta">
        <span>
          policy version: <strong>{policy ? policy.policyVersion : 'unavailable'}</strong>
        </span>
        <span>
          landing gates: <strong>{policy ? policy.landingGates : 'unknown'}</strong>
        </span>
        <span>
          mode: <strong>{policy ? policy.pilot : 'unknown'}</strong>
        </span>
        <span>read-only</span>
      </div>

      <div className="banner" role="note">
        {view.governedChangeNote}
      </div>

      {view.warnings.map((w) => (
        <div className="banner" role="alert" key={w}>
          {w}
        </div>
      ))}

      <h3 className="section-h" id="stages">Stages ({view.stages.length})</h3>
      {view.stages.map((s) => (
        <section key={s.name} aria-labelledby={`stage-${s.name}`}>
          <h4 id={`stage-${s.name}`}>{s.name}</h4>
          <p>
            {s.purpose} Coverage: <strong>{s.coverage}</strong>.
          </p>
          {s.fullOn.length > 0 && (
            <p>
              Full run on: <strong>{s.fullOn.join(', ')}</strong>
            </p>
          )}
          <div className="urs-table-wrap">
            <table className="urs-table" aria-label="Test-policy table">
              <thead>
                <tr>
                  <th scope="col">Scope</th>
                  <th scope="col">Checks</th>
                </tr>
              </thead>
              <tbody>
                {s.checks.map((c) => (
                  <tr key={c.scope}>
                    <th scope="row">{c.scope}</th>
                    <td>{c.checks.length ? c.checks.join(', ') : 'none'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {s.details.length > 0 && (
            <ul>
              {s.details.map((d) => (
                <li key={d.key}>
                  <code>{d.key}</code>: {d.value}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <h3 className="section-h" id="aliases">Branch-to-stage mappings ({view.stageAliases.length})</h3>
      {view.stageAliases.length === 0 ? (
        <p>No stage aliases are defined.</p>
      ) : (
        <ul>
          {view.stageAliases.map((a) => (
            <li key={a.alias}>
              <code>{a.alias}</code> maps to <strong>{a.stage}</strong>
            </li>
          ))}
        </ul>
      )}

      <h3 className="section-h" id="checks">Checks ({view.checks.length})</h3>
      <div className="issues">
        {view.checks.map((c) => (
          <div key={c.id} className="issue" style={{ gridTemplateColumns: '260px 1fr' }}>
            <span className="issue-ticket">{c.id}</span>
            <span className="issue-summary">
              {c.description} <span className="agent-seen">({c.kind}, source: {c.source})</span>
            </span>
          </div>
        ))}
      </div>

      <h3 className="section-h" id="selection">Selection settings</h3>
      {policy && policy.selection.length > 0 ? (
        <ul>
          {policy.selection.map((s) => (
            <li key={s.key}>
              <code>{s.key}</code>: {s.value}
            </li>
          ))}
        </ul>
      ) : (
        <p>No selection settings are available.</p>
      )}

      {(role === 'operator' || role === 'admin' || role === 'local') && <ProposalForm />}

      <h3 className="section-h" id="pending-config-proposals">Pending configuration proposals ({pendingConfigProposals.length})</h3>
      {pendingConfigProposals.length === 0 ? <p>No pending configuration proposals.</p> : (
        <div className="issues">
          {pendingConfigProposals.map((proposal) => (
            <section className="issue" key={proposal.proposal_id}>
              <h4><code>{proposal.proposal_id}</code> · {proposal.target}</h4>
              <p>Proposed by {String(redact('identity', proposal.proposer, role) ?? 'unknown')} at {proposal.created_at}</p>
              <p>Base digest: <code>{proposal.base_digest}</code></p>
              <pre>{JSON.stringify(proposal.diff, null, 2)}</pre>
              <p>Pending human-admin approval. Viewing this proposal has no effect.</p>
            </section>
          ))}
        </div>
      )}

      <h3 className="section-h" id="override">Adopter override</h3>
      <p>
        {policy && policy.overrideKeys.length > 0
          ? `Override keys in project.config.js testPolicy: ${policy.overrideKeys.join(', ')}.`
          : 'No adopter override is set in project.config.js testPolicy; engine defaults apply.'}
      </p>

      <h3 className="section-h" id="exceptions">Ticket exceptions ({view.exceptions.length})</h3>
      {view.exceptions.length === 0 ? (
        <p>No ticket exceptions are recorded on the board.</p>
      ) : (
        <div className="urs-table-wrap">
          <table className="urs-table" aria-label="Test-policy table">
            <thead>
              <tr>
                <th scope="col">Ticket</th>
                <th scope="col">Kind and stage</th>
                <th scope="col">Items</th>
                <th scope="col">Reason</th>
                <th scope="col">Authority</th>
                <th scope="col">Lapse</th>
              </tr>
            </thead>
            <tbody>
              {view.exceptions.map((e) => (
                <tr key={`${e.ticket}-${e.id}`}>
                  <td>{e.ticket}</td>
                  <td>
                    {e.kind} / {e.stage}
                    {e.withdrawn && ` (withdrawn ${e.withdrawnAt ?? ''})`}
                  </td>
                  <td>{e.items.join(', ') || 'none'}</td>
                  <td>{e.reason}</td>
                  <td>
                    {e.authorityKind ?? 'unrecorded'}
                    {e.approver ? `, approver ${e.approver}` : ''}
                    {e.recordedBy ? `, recorded by ${String(redact('identity', e.recordedBy, role))}` : ''}
                  </td>
                  <td>{e.lapse}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="event__cmd">
        Request or withdraw an exception: coord/scripts/gov test-policy except (governed; human-admin approval).
      </p>

      <h3 className="section-h" id="scheduled">Scheduled-run decisions</h3>
      {view.runtime.decisions.total === 0 ? (
        <p>No scheduled-run decisions are recorded in this checkout yet.</p>
      ) : (
        <>
          <p>
            {view.runtime.decisions.total} recorded; showing the latest {view.runtime.decisions.tail.length}
            {view.runtime.decisions.unreadable > 0 ? `; ${view.runtime.decisions.unreadable} unreadable line(s) skipped` : ''}.
          </p>
          <ul>
            {view.runtime.decisions.tail.map((d, i) => (
              <li key={`${d.recordedAt ?? i}-${i}`}>
                <strong>{d.decision}</strong>: {d.reason}
                {d.recordedAt ? ` (${d.recordedAt})` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {view.runtime.lastQualified ? (
        <ul>
          {view.runtime.lastQualified.map((k) => (
            <li key={k.key}>
              last qualified <code>{k.key}</code>: {k.value}
            </li>
          ))}
        </ul>
      ) : (
        <p>{view.runtime.lastQualifiedUnreadable ? 'The last-qualified record is unreadable.' : 'No full run has qualified yet.'}</p>
      )}

      <h3 className="section-h" id="promotions">Promotion outcomes</h3>
      {view.runtime.promotions.length === 0 ? (
        <p>No promotion outcomes are recorded in this checkout yet.</p>
      ) : (
        <ul>
          {view.runtime.promotions.map((p) => (
            <li key={p.run}>
              <code>{p.run}</code>: stage {p.stage}, result <strong>{p.result}</strong>
            </li>
          ))}
        </ul>
      )}

      <h3 className="section-h" id="configuration">Adopter configuration</h3>
      <div className="issues">
        {view.settings.map((raw) => {
          const s = raw as { key: string; value: string; description: string; changeCommand: string };
          return (
            <div key={s.key} className="issue" style={{ gridTemplateColumns: '260px 1fr' }}>
              <span className="issue-ticket">{s.key}</span>
              <span className="issue-summary">
                <div>
                  <strong>{s.value}</strong> — {s.description}
                </div>
                <div className="event__cmd" style={{ marginTop: '0.25rem' }}>
                  to change: {s.changeCommand}
                </div>
              </span>
            </div>
          );
        })}
      </div>

      <h3 className="section-h" id="resolve">Resolved policy</h3>
      <p>
        For a ticket, open <code>/testing-policy/resolve/&lt;ticket-id&gt;</code>. It shows the stage commands
        and recorded exceptions; the checks a given diff selects come from the governed resolver.
      </p>
    </>
  );
}
