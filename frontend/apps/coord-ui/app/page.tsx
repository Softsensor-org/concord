import Link from 'next/link';
import { loadBoard } from '../lib/board';
import { loadAgents } from '../lib/agents';
import { loadFindings } from '../lib/findings';
import { loadGitStatus } from '../lib/git';
import { loadGates } from '../lib/gates';
import { loadHealth } from '../lib/health';
import { loadTests } from '../lib/tests';
import { loadReadinessView } from '../lib/readiness';
import type { BoardRow, Status } from '../lib/types';

type Attention = { label: string; href: string; tone: 'crit' | 'warn' };

const VISIBLE_COLUMNS: Status[] = ['todo', 'doing', 'review', 'done', 'blocked'];

const COLUMN_LABEL: Record<Status, string> = {
  todo: 'todo',
  doing: 'doing',
  review: 'review',
  done: 'done',
  blocked: 'blocked',
  superseded: 'superseded',
  unknown: 'unknown'
};

const DONE_LIMIT = 12;

function priorityClass(p?: string): string {
  if (!p) return '';
  const norm = p.toUpperCase();
  if (norm === 'P0') return 'pill pill--p0';
  if (norm === 'P1') return 'pill pill--p1';
  if (norm === 'P2') return 'pill pill--p2';
  return 'pill';
}

function Card({ row }: { row: BoardRow }) {
  return (
    <Link href={`/ticket/${row.id}`} className="card">
      <div className="card__id">{row.id}</div>
      {row.description ? <div className="card__title">{row.description}</div> : null}
      <div className="card__meta">
        {row.priority ? <span className={priorityClass(row.priority)}>{row.priority}</span> : null}
        {row.repo ? <span className="pill pill--repo">{row.repo}</span> : null}
        {row.owner ? <span>{row.owner}</span> : null}
      </div>
    </Link>
  );
}

function Column({
  status,
  rows,
  truncate
}: {
  status: Status;
  rows: BoardRow[];
  truncate?: number;
}) {
  const visible = truncate ? rows.slice(0, truncate) : rows;
  const more = truncate && rows.length > truncate ? rows.length - truncate : 0;
  return (
    <section className="column">
      <header className="column__header">
        <span>{COLUMN_LABEL[status]}</span>
        <span className="column__count">{rows.length}</span>
      </header>
      <div className="column__body">
        {visible.length === 0 ? (
          <div className="card__title" style={{ padding: '0.5rem' }}>
            empty
          </div>
        ) : (
          visible.map((r) => <Card key={r.id} row={r} />)
        )}
        {more > 0 ? (
          <div className="card__title" style={{ padding: '0.5rem', textAlign: 'center' }}>
            +{more} more
          </div>
        ) : null}
      </div>
    </section>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export const dynamic = 'force-dynamic';

export default function BoardPage() {
  const board = loadBoard();
  const agents = loadAgents();
  const findings = loadFindings();
  const git = loadGitStatus();
  const dirtyRepos = git.filter((r) => r.exists && r.changes.length > 0).length;
  const gates = loadGates();
  const health = loadHealth();
  const tests = loadTests();
  const readiness = loadReadinessView();
  const summary = VISIBLE_COLUMNS.map((s) => `${s}: ${board.byStatus[s].length}`).join(' · ');

  const blocked = board.byStatus.blocked;
  const inReview = board.byStatus.review;
  const todo = board.byStatus.todo;
  const doing = board.byStatus.doing;

  // "What needs attention now" — prioritized signals, each linking to its view.
  const attention: Attention[] = [];
  if (blocked.length) attention.push({ label: `${plural(blocked.length, 'ticket')} blocked`, href: '/', tone: 'crit' });
  if (gates.failing) attention.push({ label: `${plural(gates.failing, 'gate failure')}`, href: '/gates', tone: 'crit' });
  if (tests.failingLaneSteps) attention.push({ label: `${plural(tests.failingLaneSteps, 'test-lane failure')}`, href: '/tests', tone: 'crit' });
  if (findings.open) attention.push({ label: `${plural(findings.open, 'open issue')}`, href: '/issues', tone: 'warn' });
  if (agents.stale) attention.push({ label: `${plural(agents.stale, 'stale agent')}`, href: '/runtime', tone: 'warn' });
  if (dirtyRepos) attention.push({ label: `${plural(dirtyRepos, 'dirty repo')}`, href: '/git', tone: 'warn' });
  if (health.overall !== 'ok') attention.push({ label: `health: ${health.overall}`, href: '/health', tone: 'warn' });

  return (
    <>
      <section className="action-center" aria-label="action center">
        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Needs attention now</h2>
          {attention.length === 0 ? (
            <div className="ac-ok">All clear — nothing blocked, no gate failures, no stale agents.</div>
          ) : (
            <ul className="ac-chips">
              {attention.map((a) => (
                <li key={a.label}>
                  <Link href={a.href} className={`ac-chip ac-chip--${a.tone}`}>
                    {a.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="ac-card">
          <h2 className="ac-card__title">Blocked &amp; at risk</h2>
          {blocked.length === 0 ? (
            <div className="ac-ok">Nothing blocked.</div>
          ) : (
            <ul className="ac-rows">
              {blocked.slice(0, 6).map((r) => (
                <li key={r.id}>
                  <Link href={`/ticket/${r.id}`} className="ac-row">
                    <span className="ac-row__id">{r.id}</span>
                    <span className="ac-row__desc">{r.description ?? ''}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="ac-card">
          <h2 className="ac-card__title">Fleet</h2>
          <div className="ac-stat">
            <strong>{agents.live}</strong> running
            {agents.stale > 0 ? <span className="ac-warn"> · {agents.stale} stale</span> : null}
            {agents.offline > 0 ? <span className="ac-muted"> · {agents.offline} offline</span> : null}
          </div>
          <div className="ac-stat">
            <strong>{doing.length}</strong> in progress · <strong>{board.locks.size}</strong> locks
          </div>
          <Link href="/runtime" className="ac-link">runtime →</Link>
        </article>

        <article className="ac-card">
          <h2 className="ac-card__title">Proof &amp; release</h2>
          <div className="ac-stat">
            <strong>{gates.passing}</strong> gates pass
            {gates.failing > 0 ? <span className="ac-warn"> · {gates.failing} fail</span> : null}
          </div>
          <div className="ac-stat">
            <strong>{inReview.length}</strong> in review (ready to land)
          </div>
          <Link href="/pipeline" className="ac-link">pipeline →</Link>
        </article>

        <article className="ac-card">
          <h2 className="ac-card__title">Next safe work</h2>
          <div className="ac-stat">
            <strong>{inReview.length}</strong> in review → <code>gov land</code>
          </div>
          <div className="ac-stat">
            <strong>{todo.length}</strong> todo → <code>gov start</code>
          </div>
          <Link href="/dispatch" className="ac-link">dispatch →</Link>
        </article>

        <article className="ac-card">
          <h2 className="ac-card__title">Onboarding</h2>
          {readiness.found ? (
            <>
              <div className="ac-stat">
                profile <strong>{readiness.recommendedProfile}</strong> · phase{' '}
                <strong>{readiness.recommendedPhase}</strong>
              </div>
              <div className="ac-stat">
                shape {readiness.detectedShape} · lane {readiness.defaultLane}
              </div>
            </>
          ) : (
            <div className="ac-ok">
              No readiness report — run <code>{readiness.generatedCommand}</code>
            </div>
          )}
          <Link href="/readiness" className="ac-link">readiness →</Link>
        </article>
      </section>

      <div className="board-meta">
        <span>
          tickets: <strong>{board.rows.length}</strong>
        </span>
        <span>{summary}</span>
        <span>
          locks: <strong>{board.locks.size}</strong>
        </span>
        <span>
          agents running: <strong>{agents.live}</strong>
          {agents.stale > 0 ? ` (+${agents.stale} stale)` : ''}
        </span>
        <span>
          open issues: <strong>{findings.open}</strong>
          {findings.total > 0 ? ` / ${findings.total}` : ''}
        </span>
        <span>
          dirty repos: <strong>{dirtyRepos}</strong>/{git.length}
        </span>
        <span>
          gates: <strong>{gates.passing}</strong> pass
          {gates.failing > 0 ? ` · ${gates.failing} fail` : ''}
        </span>
        <span>
          health: <strong>{health.overall.toUpperCase()}</strong>
        </span>
        <span>
          test files: <strong>{tests.totalTestFiles}</strong>
          {tests.failingLaneSteps > 0 ? ` · ${tests.failingLaneSteps} lane fails` : ''}
        </span>
      </div>
      <div className="board">
        {VISIBLE_COLUMNS.map((s) => (
          <Column
            key={s}
            status={s}
            rows={board.byStatus[s]}
            truncate={s === 'done' ? DONE_LIMIT : undefined}
          />
        ))}
      </div>
    </>
  );
}
