import Link from 'next/link';
import { loadReadinessView } from '../../lib/readiness';
import { productRepos } from '../../lib/project-config';
import { loadBoard } from '../../lib/board';

export const dynamic = 'force-dynamic';

// COORD_UI_CONTRACT onboarding cockpit — GUIDED, READ-ONLY.
//
// Answers "is this workspace ready for governed work, and if not, what do I run
// next?" It composes the canonical readiness model (lib/readiness.ts, itself the
// gov `coord doctor` readout), the mapped product repos, and the board ticket
// count into a checklist. It NEVER mutates: every action is shown as a copyable
// gov command for a human/agent to run via CLI/MCP.

type Step = { label: string; done: boolean; detail: string; command?: string };

function StepRow({ step }: { step: Step }) {
  return (
    <article className="ac-card">
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
        <span className={step.done ? 'pill pill--p2' : 'pill pill--p1'}>{step.done ? 'done' : 'todo'}</span>
        <strong style={{ fontSize: '0.88rem' }}>{step.label}</strong>
      </div>
      <div className="ac-stat ac-muted">{step.detail}</div>
      {step.command ? (
        <div className="ac-stat">
          <code>{step.command}</code>
        </div>
      ) : null}
    </article>
  );
}

export default function OnboardingPage() {
  const readiness = loadReadinessView();
  const repos = productRepos();
  const board = loadBoard();
  const ticketCount = board.rows.length;

  const ready = readiness.found && readiness.pilotBlockers.length === 0;

  const steps: Step[] = [
    {
      label: 'Initialize coord workspace',
      done: true,
      detail: 'coord/ governance workspace present'
    },
    {
      label: 'Map product repos',
      done: repos.length > 0,
      detail: repos.length > 0 ? repos.map((r) => `${r.name} (${r.code})`).join(' · ') : 'no product repos mapped',
      command: repos.length > 0 ? undefined : 'edit coord/project.config.js → repos'
    },
    {
      label: 'Generate setup decisions',
      done: readiness.setupDecisions.present && readiness.setupDecisions.valid,
      detail: readiness.setupDecisions.present
        ? `profile ${readiness.setupDecisions.profile} · phase ${readiness.setupDecisions.phase}` +
          (readiness.setupDecisions.tracks.length ? ` · tracks: ${readiness.setupDecisions.tracks.join(', ')}` : '')
        : 'setup decisions not recorded'
    },
    {
      label: 'Run the readiness check',
      done: readiness.found,
      detail: readiness.found ? `detected shape: ${readiness.detectedShape} · lane: ${readiness.defaultLane}` : 'readiness report not generated',
      command: readiness.found ? undefined : readiness.generatedCommand
    },
    {
      label: 'File the first governed tickets',
      done: ticketCount > 0,
      detail: `${ticketCount} ticket${ticketCount === 1 ? '' : 's'} on the board`,
      command:
        ticketCount > 0
          ? undefined
          : 'coord/scripts/gov file-ticket --repo <code> --type <type> --pri <P#> --description "..."'
    }
  ];

  const coordSetup = Object.entries(readiness.coordSetup ?? {});

  return (
    <>
      <div className="board-meta">
        <span>
          status: <strong>{ready ? 'READY' : readiness.found ? 'NOT READY' : 'NOT INITIALIZED'}</strong>
        </span>
        <span>
          profile <strong>{readiness.recommendedProfile}</strong> · phase <strong>{readiness.recommendedPhase}</strong>
        </span>
        <span>
          repos: <strong>{repos.length}</strong>
        </span>
        <span>
          tickets: <strong>{ticketCount}</strong>
        </span>
        <span>read-only — commands are copyable text</span>
      </div>

      <section className="action-center">
        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Ready for governed work?</h2>
          {ready ? (
            <div className="ac-ok">
              ✓ Ready — readiness generated and no pilot blockers. Profile{' '}
              <strong>{readiness.recommendedProfile}</strong>, phase <strong>{readiness.recommendedPhase}</strong>.
            </div>
          ) : !readiness.found ? (
            <div className="ac-ok">
              Not initialized — generate the readiness report: <code>{readiness.generatedCommand}</code>
            </div>
          ) : (
            <div className="ac-ok">
              Not yet ready — {readiness.pilotBlockers.length} pilot blocker
              {readiness.pilotBlockers.length === 1 ? '' : 's'} to clear (below).
            </div>
          )}
        </article>
      </section>

      <section className="action-center">
        {steps.map((s) => (
          <StepRow key={s.label} step={s} />
        ))}
      </section>

      {coordSetup.length > 0 ? (
        <section className="action-center">
          <article className="ac-card ac-card--wide">
            <h2 className="ac-card__title">Coord setup checks</h2>
            <ul className="ac-chips">
              {coordSetup.map(([name, ok]) => (
                <li key={name}>
                  <span className={`ac-chip ${ok ? 'ac-chip--warn' : 'ac-chip--crit'}`}>
                    {ok ? '✓' : '✗'} {name}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        </section>
      ) : null}

      {(readiness.pilotBlockers.length > 0 || readiness.suggestedTickets.length > 0) ? (
        <section className="action-center">
          {readiness.pilotBlockers.length > 0 ? (
            <article className="ac-card">
              <h2 className="ac-card__title">Pilot blockers</h2>
              <ul className="ac-rows">
                {readiness.pilotBlockers.slice(0, 8).map((b, i) => (
                  <li key={i} className="ac-stat ac-warn">
                    {b}
                  </li>
                ))}
              </ul>
            </article>
          ) : null}
          {readiness.suggestedTickets.length > 0 ? (
            <article className="ac-card">
              <h2 className="ac-card__title">Suggested first tickets</h2>
              <ul className="ac-rows">
                {readiness.suggestedTickets.slice(0, 8).map((t) => (
                  <li key={t.id}>
                    <Link href={`/ticket/${t.id}`} className="ac-row">
                      <span className="ac-row__id">{t.id}</span>
                      <span className="ac-row__desc">{t.open ? 'open' : t.status}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </article>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
