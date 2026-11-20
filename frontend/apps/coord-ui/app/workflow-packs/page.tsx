import { loadWorkflowPacks } from '../../lib/workflow-packs';

export const dynamic = 'force-dynamic';

export default function WorkflowPacksPage() {
  const packs = loadWorkflowPacks();
  const installed = packs.filter((pack) => pack.installed).length;
  const missingFiles = packs.reduce((sum, pack) => sum + pack.missing, 0);

  return (
    <>
      <div className="board-meta">
        <span>
          packs with local files: <strong>{installed}</strong>/{packs.length}
        </span>
        <span>
          missing register files: <strong>{missingFiles}</strong>
        </span>
        <span>read-only</span>
      </div>

      <div className="trace-table">
        <div className="trace-row trace-row--head" style={{ gridTemplateColumns: '180px 110px 110px 1fr' }}>
          <span>pack</span>
          <span>templates</span>
          <span>installed</span>
          <span>registers / operating files</span>
        </div>
        {packs.map((pack) => (
          <div
            key={pack.id}
            className="trace-row"
            style={{ gridTemplateColumns: '180px 110px 110px 1fr', alignItems: 'start' }}
          >
            <span>
              <strong>{pack.title}</strong>
              <br />
              <span className="agent-seen">{pack.id}</span>
            </span>
            <span>
              {pack.templatePresent ? (
                <span className="trace-pill trace-pill--verified">present</span>
              ) : (
                <span className="trace-pill trace-pill--missing">missing</span>
              )}
            </span>
            <span>
              {pack.installed ? (
                <span className="trace-pill trace-pill--verified">yes</span>
              ) : (
                <span className="trace-pill trace-pill--exempt">not yet</span>
              )}
            </span>
            <span className="trace-detail" style={{ display: 'grid', gap: '0.35rem' }}>
              {pack.files.map((file) => (
                <span key={file.path}>
                  {file.present ? (
                    <span className="trace-pill trace-pill--verified">found</span>
                  ) : (
                    <span className="trace-pill trace-pill--missing">missing</span>
                  )}{' '}
                  <code>{file.path}</code>
                  {typeof file.rows === 'number' ? ` · ${file.rows} rows` : ''}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
