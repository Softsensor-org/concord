import Link from 'next/link';
import { loadBoard } from '../lib/board';
import { loadAgents } from '../lib/agents';
import { loadFindings } from '../lib/findings';
import { summarizeGitStatus } from '../lib/git';
import { loadGates } from '../lib/gates';
import { loadHealth } from '../lib/health';
import { loadTests } from '../lib/tests';
import { loadReadinessView } from '../lib/readiness';
import type { BoardRow, Status } from '../lib/types';
import { nonRunnableStatusGuidance } from '../lib/board-state.js';
import { BlockedReason } from '../components/blocked-reason';
import { deriveBoardCounts, VISIBLE_BOARD_STATUSES } from '../lib/board-counts.js';

type Attention = { label: string; href: string; tone: 'crit' | 'warn'; detail?: string };

const VISIBLE_COLUMNS: readonly Status[] = VISIBLE_BOARD_STATUSES;

const COLUMN_LABEL: Record<Status, string> = {
  proposed: 'awaiting acceptance',
  todo: 'not started',
  doing: 'in progress',
  review: 'in review',
  done: 'complete',
  blocked: 'waiting on resolution',
  superseded: 'superseded',
  unknown: 'needs investigation'
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
  const unknownGuidance = row.status === 'unknown'
    ? nonRunnableStatusGuidance(row.id, row.status)?.[1]
    : null;
  return (
    <Link href={`/ticket/${row.id}`} className="card" title={row.description || `Open ticket ${row.id}`}>
      <div className="card__id">{row.id}</div>
      {row.description ? <div className="card__title card__title--ticket">{row.description}</div> : null}
      {row.status === 'blocked' && row.blockedReason ? <BlockedReason reason={row.blockedReason} /> : null}
      {unknownGuidance ? <div className="card__title rl rl--blocked">{unknownGuidance}</div> : null}
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
  const emptyGuidance: Record<Status, string> = {
    proposed: 'New tickets appear here while they await acceptance.',
    todo: 'Accepted tickets awaiting a start appear here; dependencies or other readiness checks may still apply.',
    doing: 'Tickets move here when someone starts the work.',
    review: 'Implemented work appears here while review and landing checks are pending.',
    done: 'Accepted and completed tickets appear here.',
    blocked: 'Tickets appear here when work is waiting on a decision or dependency.',
    superseded: 'Replaced tickets appear here.',
    unknown: 'Tickets with an unrecognized status appear here for investigation.'
  };
  return (
    <section className="column">
      <header className="column__header">
        <span>{COLUMN_LABEL[status]}</span>
        <span className="column__count">{rows.length}</span>
      </header>
      <div className="column__body">
        {visible.length === 0 ? (
          <p className="column__empty">{emptyGuidance[status]}</p>
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
  const boardCounts = deriveBoardCounts(board, VISIBLE_COLUMNS);
  const agents = loadAgents();
  const findings = loadFindings();
  const git = summarizeGitStatus();
  // COORD-543: dirty count is over the repos actually INSPECTED; repos that
  // could not be resolved are reported separately, never counted as clean.
  const dirtyRepos = git.dirty;
  const gates = loadGates();
  const health = loadHealth();
  const tests = loadTests();
  const readiness = loadReadinessView();
  const summary = VISIBLE_COLUMNS.map((s) => `${COLUMN_LABEL[s]}: ${board.byStatus[s].length}`).join(' · ');

  const blocked = board.byStatus.blocked;
  const inReview = board.byStatus.review;
  const todo = board.byStatus.todo;
  const doing = board.byStatus.doing;

  // "What needs attention now" — prioritized signals, each linking to its view.
  const attention: Attention[] = [];
  if (blocked.length) attention.push({ label: `${plural(blocked.length, 'ticket')} waiting`, detail: 'These tickets cannot move forward until a dependency or decision is resolved.', href: '/', tone: 'crit' });
  if (gates.failing) attention.push({ label: `${plural(gates.failing, 'automated check')} failing`, detail: 'Open the check results to see what failed or is missing.', href: '/gates', tone: 'crit' });
  if (tests.failingLaneSteps) attention.push({ label: `${plural(tests.failingLaneSteps, 'test check')} failed`, detail: 'Open test results for the failing steps.', href: '/tests', tone: 'crit' });
  if (findings.open) attention.push({ label: `${plural(findings.open, 'open issue')}`, detail: 'Review issues recorded for this workspace.', href: '/issues', tone: 'warn' });
  if (agents.stale) attention.push({ label: `${plural(agents.stale, 'agent')} inactive for 4+ hours`, detail: 'The latest session activity is at least four hours old. Open agent status for its last-seen time.', href: '/runtime', tone: 'warn' });
  if (dirtyRepos) attention.push({ label: `${plural(dirtyRepos, 'repository')} with uncommitted changes`, detail: 'Changes are present in the repository working copy.', href: '/git', tone: 'warn' });
  if (git.unresolved)
    attention.push({
      label: `${plural(git.unresolved, 'repository')} could not be checked`,
      detail: 'Review repository access and configuration before treating its status as clean.',
      href: '/git',
      tone: 'crit'
    });
  if (health.overall !== 'ok') {
    const causes = health.checks
      .filter((check) => check.level !== 'ok')
      .map((check) => `${check.name}: ${check.detail}`)
      .join(' ');
    attention.push({
      label: `Workspace health: ${health.overall}`,
      detail: causes || 'Open the health page to inspect the underlying checks.',
      href: '/health',
      tone: health.overall === 'fail' ? 'crit' : 'warn'
    });
  }

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
                  <Link href={a.href} className={`ac-chip ac-chip--${a.tone}`} title={a.detail} aria-label={a.detail ? `${a.label}. ${a.detail}` : a.label}>
                    <span>{a.label}</span>{a.detail ? <span className="ac-chip__detail">{a.detail}</span> : null}
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
            <strong>{agents.live}</strong> recently active agents
            {agents.stale > 0 ? <span className="ac-warn"> · {agents.stale} inactive for 4+ hours</span> : null}
            {agents.offline > 0 ? <span className="ac-muted"> · {agents.offline} with no active session</span> : null}
          </div>
          <div className="ac-stat">
            <strong>{doing.length}</strong> tickets in progress · <strong>{board.locks.size}</strong> recorded work reservations
          </div>
          <Link href="/runtime" className="ac-link">runtime →</Link>
        </article>

        <article className="ac-card">
          <h2 className="ac-card__title">Automated checks &amp; release</h2>
          <div className="ac-stat">
            <strong>{gates.passing}</strong> automated checks pass
            {gates.failing > 0 ? <span className="ac-warn"> · {gates.failing} fail</span> : null}
          </div>
          <div className="ac-stat">
            <strong>{inReview.length}</strong> changes awaiting review
          </div>
          <Link href="/pipeline" className="ac-link">pipeline →</Link>
        </article>

        <article className="ac-card">
          <h2 className="ac-card__title">Work queue</h2>
          <div className="ac-stat">
            <strong>{inReview.length}</strong> changes awaiting review
          </div>
          <div className="ac-stat">
            <strong>{todo.length}</strong> accepted tasks awaiting a start
          </div>
          <Link href="/dispatch" className="ac-link">view work queue →</Link>
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
              Setup guidance is not available yet. Open the readiness page to learn how to prepare this workspace.
            </div>
          )}
          <Link href="/readiness" className="ac-link">readiness →</Link>
        </article>
      </section>

      <div className="board-meta">
        <span aria-label="Board row reconciliation">
          tickets: <strong>{boardCounts.totalCount}</strong> total = <strong>{boardCounts.visibleCount}</strong> in visible lanes +{' '}
          <strong>{boardCounts.omittedCount}</strong> not shown
          {boardCounts.omittedByStatus.length > 0 ? ` (${boardCounts.omittedByStatus.map(({ status, count }) => `${status} ${count}`).join(', ')})` : ''}
          {boardCounts.unclassifiedCount > 0
            ? ` · unclassified: ${boardCounts.unclassifiedCount} visible in the needs-investigation lane (0 omitted)`
            : ''}
        </span>
        <span>{summary}</span>
        <span>
          recorded work reservations: <strong>{board.locks.size}</strong>
        </span>
        <span>
          recently active agents: <strong>{agents.live}</strong>
          {agents.stale > 0 ? ` · inactive for 4+ hours: ${agents.stale}` : ''}
        </span>
        <span>
          open issues: <strong>{findings.open}</strong>
          {findings.total > 0 ? ` / ${findings.total}` : ''}
        </span>
        <span>
          repositories with uncommitted changes: <strong>{dirtyRepos}</strong>/{git.inspected}
          {git.unresolved > 0 ? ` · ${git.unresolved} not inspected` : ''}
        </span>
        <span>
          automated checks: <strong>{gates.passing}</strong> pass
          {gates.failing > 0 ? ` · ${gates.failing} fail` : ''}
        </span>
        <span>
          workspace health: <strong>{health.overall.toUpperCase()}</strong>
        </span>
        <span>
          test files: <strong>{tests.totalTestFiles}</strong>
          {tests.failingLaneSteps > 0 ? ` · ${tests.failingLaneSteps} lane fails` : ''}
          {tests.unresolvedRepos > 0 ? ` · ${tests.unresolvedRepos} repo not inspected` : ''}
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
