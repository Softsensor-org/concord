import Link from 'next/link';
import { loadBoard } from '../lib/board';
import { loadAgents } from '../lib/agents';
import { loadFindings } from '../lib/findings';
import { loadGitStatus } from '../lib/git';
import { loadGates } from '../lib/gates';
import { loadHealth } from '../lib/health';
import { loadTests } from '../lib/tests';
import type { BoardRow, Status } from '../lib/types';

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

export default function BoardPage() {
  const board = loadBoard();
  const agents = loadAgents();
  const findings = loadFindings();
  const git = loadGitStatus();
  const dirtyRepos = git.filter((r) => r.exists && r.changes.length > 0).length;
  const gates = loadGates();
  const health = loadHealth();
  const tests = loadTests();
  const summary = VISIBLE_COLUMNS.map((s) => `${s}: ${board.byStatus[s].length}`).join(' · ');

  return (
    <>
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
