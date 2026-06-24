import { requireRole } from '../../lib/access';
import {
  loadBootstrapRiskView,
  type BootstrapRiskTicketView,
  type StatusField,
  type EvidenceState
} from '../../lib/bootstrap-risk';

/**
 * COORD-163 — READ-ONLY "/bootstrap-risk" cockpit view (Server bootstrap P5).
 *
 * Surfaces every ticket carrying server-bootstrap / backfill / generated-data
 * risk with: declared work class + runs-at-boot/app-process flags, resource
 * envelope, idempotency/checkpoint strategy, verification signal, rollback/
 * disable, observability requirements, data-access shape (COORD-159), the
 * job-completion receipt status (COORD-161), and unresolved COORD-160/162
 * warnings — all sourced via lib/bootstrap-risk.ts.
 *
 * SERVER READINESS vs JOB COMPLETION are rendered as two clearly-labelled,
 * separate blocks: the design posture is never presented as proof the job ran.
 *
 * ROLE-AWARE (ENT-012): viewer sees redacted summaries (coarse present/absent
 * status only); operator/admin/local see operational detail. STRICTLY READ-ONLY
 * (SEC-001/SEC-002): no form, no button, no input, no onClick/onChange, no
 * fetch/POST, no job execution — this view shows recorded evidence and never
 * runs a bootstrap job or advances a ticket. Asserted by
 * coord/scripts/coord-ui-bootstrap-risk-view.test.js.
 */
export const dynamic = 'force-dynamic';

function stateClass(state: EvidenceState): string {
  if (state === 'present') return 'rl rl--ready';
  if (state === 'absent') return 'rl rl--blocked';
  return 'rl rl--pending'; // unknown — fail-safe, surfaced not hidden
}

function StatusCell({ label, field }: { label: string; field: StatusField }) {
  return (
    <div className="kv-row kv-row--col">
      <span className="kv-row__k">{label}</span>
      <span>
        <span className={stateClass(field.state)}>{field.state}</span>
        {field.detail ? <span style={{ marginLeft: '0.5rem' }}>{field.detail}</span> : null}
      </span>
    </div>
  );
}

function postureClass(posture: BootstrapRiskTicketView['serverReadiness']['posture']): string {
  if (posture === 'declared-safe') return 'rl rl--ready';
  if (posture === 'declared-risky') return 'rl rl--blocked';
  return 'rl rl--pending';
}

function flag(value: boolean | null): string {
  if (value === null) return 'undeclared';
  return value ? 'yes' : 'no';
}

function TicketCard({ t }: { t: BootstrapRiskTicketView }) {
  const sr = t.serverReadiness;
  return (
    <div className="panel" style={{ marginBottom: '0.85rem' }}>
      <div className="ticket-header">
        <span className="pill pill--repo">{t.id}</span>
        <span className="pill">{t.status}</span>
        {sr.workClass ? <span className="pill">{sr.workClass}</span> : null}
        <span className="pill">{t.source === 'plan-field' ? 'declared' : 'advisory-only'}</span>
      </div>

      {/* SERVER READINESS — the job DESIGN posture (NOT proof the job ran). */}
      <div className="side-panel" style={{ marginTop: '0.5rem' }}>
        <div className="card__title">
          Server readiness (job design) ·{' '}
          <span className={postureClass(sr.posture)}>{sr.posture}</span>
        </div>
        <div className="kv-rows">
          <div className="kv-row">
            <span className="kv-row__k">runs at boot</span>
            <span>{flag(sr.runsAtBoot)}</span>
          </div>
          <div className="kv-row">
            <span className="kv-row__k">shares app process</span>
            <span>{flag(sr.sharesAppProcess)}</span>
          </div>
          <div className="kv-row kv-row--col">
            <span className="kv-row__k">resource envelope</span>
            <span>
              <span className={stateClass(t.resourceEnvelope.state)}>
                {t.resourceEnvelope.state}
              </span>
              {t.resourceEnvelope.summary ? (
                <span style={{ marginLeft: '0.5rem' }}>{t.resourceEnvelope.summary}</span>
              ) : null}
            </span>
          </div>
          <StatusCell label="idempotency strategy" field={t.idempotency} />
          <StatusCell label="checkpoint strategy" field={t.checkpoint} />
          <StatusCell label="verification signal" field={t.verificationSignal} />
          <StatusCell label="rollback / disable" field={t.rollbackOrDisable} />
          <StatusCell label="data access shape" field={t.dataAccessShape} />
          <div className="kv-row kv-row--col">
            <span className="kv-row__k">observability requirements</span>
            <span>
              <span className={stateClass(t.observability.state)}>{t.observability.state}</span>
              {t.observability.items ? (
                <span style={{ marginLeft: '0.5rem' }}>{t.observability.items.join(', ')}</span>
              ) : null}
            </span>
          </div>
        </div>
      </div>

      {/* JOB COMPLETION — the COORD-161 receipt. The ONLY proof the job ran. */}
      <div className="side-panel" style={{ marginTop: '0.5rem' }}>
        <div className="card__title">Job completion (receipt — NOT server readiness)</div>
        <div className="kv-row kv-row--col">
          <span className="kv-row__k">bootstrap receipt</span>
          <span>
            <span className={stateClass(t.jobCompletion.state)}>{t.jobCompletion.state}</span>
            {t.jobCompletion.result ? (
              <span style={{ marginLeft: '0.5rem' }}>result={t.jobCompletion.result}</span>
            ) : null}
            {t.jobCompletion.path ? (
              <code className="event__cmd" style={{ marginLeft: '0.5rem' }}>
                {t.jobCompletion.path}
              </code>
            ) : null}
          </span>
        </div>
        {t.jobCompletion.state !== 'present' ? (
          <div className="kv-row kv-row--col">
            <span>
              No completion receipt recorded — the server may be ready, but the job is NOT proven
              to have finished. Record one with{' '}
              <code className="event__cmd">gov bootstrap-record &lt;ticket&gt; ...</code>.
            </span>
          </div>
        ) : null}
      </div>

      {/* UNRESOLVED WARNINGS — COORD-160 missing evidence + COORD-162 query findings. */}
      {t.missingEvidence.length > 0 || t.queryWarnings.length > 0 ? (
        <div className="side-panel" style={{ marginTop: '0.5rem' }}>
          <div className="card__title">
            Unresolved warnings ({t.missingEvidence.length + t.queryWarnings.length})
          </div>
          {t.matchedSignals.length > 0 ? (
            <div className="kv-row">
              <span className="kv-row__k">matched signals</span>
              <span>{t.matchedSignals.join(', ')}</span>
            </div>
          ) : null}
          <ul className="reason-list">
            {t.missingEvidence.map((m) => (
              <li key={m}>
                <strong>missing evidence</strong>: {m}
              </li>
            ))}
            {t.queryWarnings.map((w) => (
              <li key={w.rule}>
                <strong>{w.rule}</strong>: {w.message}
              </li>
            ))}
          </ul>
          {t.advisoryMessage ? <div className="kv-row kv-row--col"><span>{t.advisoryMessage}</span></div> : null}
        </div>
      ) : (
        <div className="card__title" style={{ marginTop: '0.5rem' }}>
          No unresolved bootstrap warnings.
        </div>
      )}
    </div>
  );
}

export default async function BootstrapRiskPage() {
  // SEC-001: gate before reading any bootstrap-risk evidence. viewer+ may read;
  // the role drives redaction (viewer → redacted summaries only).
  const role = await requireRole();
  const v = loadBootstrapRiskView(role);

  return (
    <>
      <div className="board-meta">
        <span>
          bootstrap-risk tickets: <strong>{v.tickets.length}</strong>
        </span>
        <span>
          role: <strong>{v.role}</strong>
        </span>
        <span>{v.redacted ? 'REDACTED (viewer)' : 'operational detail'}</span>
        <span>read-only · never runs a job</span>
      </div>

      <div className="banner" style={{ marginBottom: '0.85rem' }}>
        {v.notice}
      </div>

      {!v.engineAvailable ? null : v.tickets.length === 0 ? (
        <div className="banner">
          No bootstrap/backfill risk tickets. A ticket appears here only when its plan record
          declares a <code>bootstrap_risk</code> object (via{' '}
          <code className="event__cmd">gov update-plan &lt;ticket&gt; ...</code>) or the
          server-bootstrap advisory triggers on its description. There are no startup/backfill risk
          tickets to display.
        </div>
      ) : (
        v.tickets.map((t) => <TicketCard key={t.id} t={t} />)
      )}
    </>
  );
}
