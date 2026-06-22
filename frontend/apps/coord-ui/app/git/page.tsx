import { loadGitStatus } from '../../lib/git';
import { requireRole, redact } from '../../lib/access';

// SEC-001: sensitive route — exposes branch/worktree paths and dirty-file lists.
// operator+ sees full detail; a viewer gets absolute worktree paths redacted.
export const dynamic = 'force-dynamic';

function codeClass(code: string): string {
  if (code === '??') return 'gitcode gitcode--untracked';
  if (code.includes('M')) return 'gitcode gitcode--modified';
  if (code.includes('D')) return 'gitcode gitcode--deleted';
  if (code.includes('A')) return 'gitcode gitcode--added';
  return 'gitcode';
}

export default async function GitPage() {
  const role = await requireRole();
  const repos = loadGitStatus();
  return (
    <>
      <div className="board-meta">
        <span>sibling repos: {repos.map((r) => r.name).join(' · ')}</span>
        <span>git status --porcelain</span>
      </div>

      <div className="git-grid">
        {repos.map((r) => (
          <section key={r.name} className="panel">
            <h3>
              {r.name}
              {r.exists && r.branch ? (
                <span className="git-branch"> @ {r.branch}</span>
              ) : (
                <span className="git-branch"> (not a git repo)</span>
              )}
            </h3>

            {r.error ? <div className="card__title">error: {r.error}</div> : null}

            {r.exists ? (
              <>
                <dl className="git-meta">
                  <dt>head</dt>
                  <dd>{r.head ?? '—'}</dd>
                  <dt>ahead/behind</dt>
                  <dd>
                    {r.ahead ?? 0} / {r.behind ?? 0}
                  </dd>
                  <dt>changes</dt>
                  <dd>{r.changes.length}</dd>
                  <dt>worktrees</dt>
                  <dd>{r.worktrees.length}</dd>
                </dl>

                {r.changes.length === 0 ? (
                  <div className="git-clean">working tree clean</div>
                ) : (
                  <div className="git-changes">
                    {r.changes.slice(0, 60).map((c) => (
                      <div key={c.file} className="git-change">
                        <span className={codeClass(c.code)}>{c.code || '??'}</span>
                        <span className="git-file">{c.file}</span>
                      </div>
                    ))}
                    {r.changes.length > 60 ? (
                      <div className="card__title">+{r.changes.length - 60} more</div>
                    ) : null}
                  </div>
                )}

                {r.worktrees.length > 0 ? (
                  <div className="git-worktrees">
                    <h4>worktrees</h4>
                    {r.worktrees.slice(0, 20).map((w) => (
                      <div key={w} className="git-file">
                        {String(redact('path', w, role))}
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
        ))}
      </div>
    </>
  );
}
