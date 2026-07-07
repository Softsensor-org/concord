import Link from 'next/link';
import { loadScreenIndex } from '../../lib/screens';

function refClass(c: string): string {
  return c === 'explicit'
    ? 'trace-pill trace-pill--verified'
    : 'trace-pill trace-pill--gap';
}

export const dynamic = 'force-dynamic';

export default function ScreensPage() {
  const { index, origin } = loadScreenIndex();
  const totalScreens = index.apps.reduce((n, a) => n + a.screens.length, 0);
  const cov = index.requirements.coverage;

  return (
    <>
      <div className="board-meta">
        <span>
          apps: <strong>{index.apps.length}</strong>
        </span>
        <span>
          screens: <strong>{totalScreens}</strong>
        </span>
        <span>
          URS linked: {cov.linked_anchors}/{cov.total_anchors}
        </span>
        <span>unlinked: {cov.unlinked_anchors.length}</span>
        <span>source: {origin === 'artifact' ? 'generated artifact' : 'derived live'}</span>
        {index.source_commit && <span>@ {index.source_commit.slice(0, 8)}</span>}
      </div>

      {index.apps.map((app) => (
        <section key={app.app} className="screens-app">
          <h3 className="urs-h urs-h--l1">
            {app.app} <span className="event__cmd">{app.framework}</span>{' '}
            <span>· {app.screens.length} screens</span>
          </h3>
          {app.screens.length === 0 ? (
            <p className="urs-p">No screens discovered.</p>
          ) : (
            <table className="board-table">
              <thead>
                <tr>
                  <th>Route</th>
                  <th>Title</th>
                  <th>Persona</th>
                  <th>Requirements</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {app.screens.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <code>{s.route ?? '—'}</code>
                    </td>
                    <td>{s.title}</td>
                    <td>{s.persona_hints.join(', ') || '—'}</td>
                    <td>
                      {s.requirement_refs.length === 0 ? (
                        <span className="trace-pill trace-pill--todo">none</span>
                      ) : (
                        s.requirement_refs.map((r) => (
                          <Link
                            key={r.anchor}
                            href={`/urs#${r.anchor}`}
                            className={refClass(r.confidence)}
                            title={`${r.confidence}: ${r.text}`}
                          >
                            {r.text}
                          </Link>
                        ))
                      )}
                    </td>
                    <td>
                      <code>{s.source}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}

      <section className="screens-worklist">
        <h3 className="urs-h urs-h--l1">
          Requirement coverage worklist · {cov.unlinked_anchors.length} unlinked
        </h3>
        <p className="urs-p">
          URS sections (level ≤ 3) with no screen linked. This is the BA&apos;s
          actionable backlog — each is a candidate for a screen, a clarification,
          or a governed URS-improvement ticket.
        </p>
        {cov.unlinked_anchors.length === 0 ? (
          <p className="urs-p">All linkable requirements have at least one screen.</p>
        ) : (
          <ul className="screens-unlinked">
            {cov.unlinked_anchors.map((a) => {
              const h = index.requirements.headings.find((x) => x.anchor === a);
              return (
                <li key={a}>
                  <Link href={`/urs#${a}`} className="event__cmd">
                    {h ? h.text : a}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
