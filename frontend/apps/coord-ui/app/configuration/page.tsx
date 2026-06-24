import { loadConfigView } from '../../lib/config-view';

/**
 * COORD-150 — READ-ONLY "Configuration" cockpit view.
 *
 * Surfaces the current config-as-code (coord/project.config.js) and, for each
 * setting, the governed command/file to change it. STRICTLY READ-ONLY: there is
 * no form, no toggle, no button, no POST — changing config is config-as-code on
 * the governed lane (edit the file + commit). Preserves the SEC-001/SEC-002
 * read-only / fail-closed cockpit invariant.
 */
export default function ConfigurationPage() {
  const cfg = loadConfigView();

  if (!cfg.found) {
    return (
      <div className="banner">
        Configuration file not found. Expected {cfg.sourcePath}. Run{' '}
        <code className="event__cmd">coord init --wizard</code> to generate it
        (config-as-code you then commit).
      </div>
    );
  }

  return (
    <>
      <div className="board-meta">
        <span>
          source: <strong>{cfg.sourcePath}</strong>
        </span>
        <span>
          coord prefix: <strong>{cfg.coordTicketPrefix}</strong>
        </span>
        <span>
          repos: <strong>{cfg.repos.length}</strong>
        </span>
        <span>read-only mirror</span>
      </div>

      <div className="banner" role="note">
        {cfg.governedChangeNote}
      </div>

      <h3 className="section-h">Repos ({cfg.repos.length})</h3>
      <div className="issues">
        {cfg.repos.map((r) => (
          <div
            key={r.code}
            className="issue"
            style={{ gridTemplateColumns: '60px 1fr 160px' }}
          >
            <span className="trace-pill">{r.code}</span>
            <span className="issue-summary">{r.path}</span>
            <span className="agent-seen">{r.integrationBranch}</span>
          </div>
        ))}
      </div>

      <h3 className="section-h">Settings ({cfg.settings.length})</h3>
      <div className="issues">
        {cfg.settings.map((s) => (
          <div
            key={s.key}
            className="issue"
            style={{ gridTemplateColumns: '260px 1fr' }}
          >
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
        ))}
      </div>
    </>
  );
}
