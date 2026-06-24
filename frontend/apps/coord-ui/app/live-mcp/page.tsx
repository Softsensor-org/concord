import { requireRole } from '../../lib/access';
import {
  loadLiveMcpView,
  type LiveMcpTicketView,
  type StatusField,
  type EvidenceState
} from '../../lib/live-mcp';

/**
 * COORD-156 — READ-ONLY "/live-mcp" cockpit view (Production MCP P5).
 *
 * Surfaces every live-MCP ticket (a plan record declaring a `live_mcp` object)
 * with: adapter, environment, operation class, approval / redaction / receipt /
 * cleanup / promotion status, and unresolved closeout blockers — all sourced
 * from the COORD-153 lifecycle gate + COORD-152 receipts via lib/live-mcp.ts.
 *
 * ROLE-AWARE (ENT-012): viewer sees redacted summaries (coarse present/absent
 * status only); operator/admin/local see operational detail. STRICTLY READ-ONLY
 * (SEC-001/SEC-002): no form, no button, no input, no onClick/onChange, no
 * fetch/POST — this view shows recorded evidence and never executes a tool or
 * advances a ticket. Asserted by coord/scripts/coord-ui-live-mcp-view.test.js.
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

function TicketCard({ t }: { t: LiveMcpTicketView }) {
  return (
    <div className="panel" style={{ marginBottom: '0.85rem' }}>
      <div className="ticket-header">
        <span className="pill pill--repo">{t.id}</span>
        <span className="pill">{t.status}</span>
        {t.operationClass ? <span className="pill">{t.operationClass}</span> : null}
        {t.environment ? <span className="pill">{t.environment}</span> : null}
      </div>
      <div className="kv-rows">
        <div className="kv-row">
          <span className="kv-row__k">adapter</span>
          <span>{t.adapter ?? '—'}</span>
        </div>
        {t.operation !== null ? (
          <div className="kv-row">
            <span className="kv-row__k">operation</span>
            <span>{t.operation}</span>
          </div>
        ) : null}
        <StatusCell label="scope" field={t.scope} />
        <StatusCell label="approval" field={t.approval} />
        <StatusCell label="redaction" field={t.redaction} />
        <StatusCell label="cleanup" field={t.cleanup} />
        <StatusCell label="promotion" field={t.promotion} />
        <div className="kv-row kv-row--col">
          <span className="kv-row__k">receipt / evidence</span>
          <span>
            <span className={stateClass(t.receipt.state)}>{t.receipt.state}</span>
            {t.receipt.result ? (
              <span style={{ marginLeft: '0.5rem' }}>result={t.receipt.result}</span>
            ) : null}
            {t.receipt.path ? (
              <code className="event__cmd" style={{ marginLeft: '0.5rem' }}>
                {t.receipt.path}
              </code>
            ) : null}
          </span>
        </div>
        {t.linkedDevelopmentTicket ? (
          <div className="kv-row">
            <span className="kv-row__k">development ticket</span>
            <span>{t.linkedDevelopmentTicket}</span>
          </div>
        ) : null}
        {t.deployedVerificationReceipt ? (
          <div className="kv-row">
            <span className="kv-row__k">deployed verification</span>
            <span>{t.deployedVerificationReceipt}</span>
          </div>
        ) : null}
      </div>

      {t.blockers.length > 0 ? (
        <div className="side-panel" style={{ marginTop: '0.5rem' }}>
          <div className="card__title">Unresolved closeout blockers ({t.blockers.length})</div>
          <ul className="reason-list">
            {t.blockers.map((b) => (
              <li key={b.code}>
                <strong>{b.code}</strong>: {b.message}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="card__title" style={{ marginTop: '0.5rem' }}>
          No unresolved closeout blockers.
        </div>
      )}
    </div>
  );
}

export default async function LiveMcpPage() {
  // SEC-001: gate before reading any live-MCP evidence. viewer+ may read; the
  // role drives redaction (viewer → redacted summaries only).
  const role = await requireRole();
  const v = loadLiveMcpView(role);

  return (
    <>
      <div className="board-meta">
        <span>
          live-MCP tickets: <strong>{v.tickets.length}</strong>
        </span>
        <span>
          role: <strong>{v.role}</strong>
        </span>
        <span>{v.redacted ? 'REDACTED (viewer)' : 'operational detail'}</span>
        <span>read-only · never executes a live tool</span>
      </div>

      <div className="banner" style={{ marginBottom: '0.85rem' }}>
        {v.notice}
      </div>

      {!v.engineAvailable ? null : v.tickets.length === 0 ? (
        <div className="banner">
          No live-MCP tickets declared. A ticket appears here only when its plan record declares a{' '}
          <code>live_mcp</code> object (via{' '}
          <code className="event__cmd">gov update-plan &lt;ticket&gt; --live-mcp &apos;...&apos;</code>
          ). There are no recorded live-MCP operations to display.
        </div>
      ) : (
        v.tickets.map((t) => <TicketCard key={t.id} t={t} />)
      )}
    </>
  );
}
