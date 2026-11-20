import Link from 'next/link';
import { loadDispatchPlan } from '../../lib/dispatch';
import type {
  DispatchFilters,
  DispatchPlanView,
  DispatchTicket,
  PrecheckVerdict
} from '../../lib/dispatch';

// The plan reads the live board + prompts + the RECORDED precheck verdicts from
// the governance journal at request time (read-only fs, no mutation, no probe,
// no agent spawn), so it must render dynamically.
export const dynamic = 'force-dynamic';

// Verdict pill coloring. unknown is NEUTRAL (never styled like a clean skip) so
// it can never read as a false "already-satisfied".
function verdictClass(v: PrecheckVerdict): string {
  if (v === 'already-satisfied') return 'rl rl--done';
  if (v === 'partial') return 'rl rl--pending';
  if (v === 'not-started') return 'rl rl--blocked';
  return 'rl rl--na'; // unknown — neutral, explicitly NOT a skip signal
}

// Action pill. skip is the only "green-ish" terminal; spawn is the active call.
function actionClass(action: string): string {
  if (action === 'skip') return 'gate-status gate-status--pass';
  return 'gate-status'; // spawn — neutral active state
}

function parallelClass(parallel: boolean): string {
  return parallel ? 'rl rl--ready' : 'rl rl--blocked';
}

/** Build a /dispatch URL with a filter set/cleared (toggle semantics). */
function filterHref(active: DispatchFilters, next: Partial<DispatchFilters>): string {
  const merged: DispatchFilters = { ...active, ...next };
  const params = new URLSearchParams();
  if (merged.status) params.set('status', merged.status);
  if (merged.repo) params.set('repo', merged.repo);
  if (merged.wave != null) params.set('wave', String(merged.wave));
  const qs = params.toString();
  return qs ? `/dispatch?${qs}` : '/dispatch';
}

function CommandBlock({ t }: { t: DispatchTicket }) {
  return (
    <div className="kv-rows">
      {t.commands.map((c) => (
        <div className="kv-row kv-row--col" key={c.label}>
          <div className="card__title">{c.label}</div>
          <pre className="cmd-list">{c.cmd}</pre>
        </div>
      ))}
    </div>
  );
}

function TicketCard({ t, view }: { t: DispatchTicket; view: DispatchPlanView }) {
  const pc = t.precheck;
  return (
    <section className="panel" style={{ marginBottom: '0.85rem' }}>
      <h3>
        <Link href={`/ticket/${t.ticket}`} className="kv-row__k">
          {t.ticket}
        </Link>{' '}
        <span className={actionClass(t.action)}>{t.action}</span>{' '}
        <span className={parallelClass(t.parallelizable)}>
          {t.parallelizable ? 'parallel' : 'sequential'}
        </span>{' '}
        {t.repo ? <span className="pill pill--repo">repo {t.repo}</span> : null}
      </h3>

      <div className="card__title" style={{ marginBottom: '0.5rem' }}>
        {t.reason}
      </div>

      {t.waveNote ? (
        <div className="banner" style={{ marginBottom: '0.5rem' }}>
          {t.waveNote}
        </div>
      ) : null}

      <div className="kv-rows">
        <div className="kv-row">
          <span className="kv-row__k">precheck</span>
          <span>
            {pc.recorded ? (
              <>
                <span className={verdictClass(pc.verdict)}>{pc.verdict}</span>{' '}
                {pc.probeCount} probe(s) · recorded
                {pc.recordedAt ? (
                  <>
                    {' '}
                    · <code>{pc.recordedAt}</code>
                  </>
                ) : null}
              </>
            ) : (
              <span className="rl rl--na">precheck not recorded</span>
            )}
          </span>
        </div>
        {!pc.recorded ? (
          <div className="kv-row kv-row--col">
            <span className="kv-row__k">record precheck</span>
            <span className="card__title">
              No <code>precheck.observed</code> verdict recorded — held at <code>unknown</code> →{' '}
              <b>spawn</b> (never a false skip). Record it on the CLI (this view never runs probes):
              {pc.recordCommand ? <pre className="cmd-list">{pc.recordCommand}</pre> : null}
            </span>
          </div>
        ) : null}
        <div className="kv-row">
          <span className="kv-row__k">tier</span>
          <span>
            {t.tier} <span className="rl rl--na">{t.tierSource}</span> → model class{' '}
            <code>{t.suggestedModelClass}</code>
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__k">evidence depth</span>
          <span>
            {t.evidenceDepth.reviewCycles} review cycle(s) · {t.evidenceDepth.featureProofs}{' '}
            feature-proof(s) · {t.evidenceDepth.criticalInvariants} invariant(s)
          </span>
        </div>
        <div className="kv-row kv-row--col">
          <span className="kv-row__k">files considered</span>
          {t.files.length === 0 ? (
            <span className="card__title">
              (none declared — treated as potentially-conflicting, scheduled alone)
            </span>
          ) : (
            <span>
              {t.files.map((f) => (
                <code key={f} style={{ marginRight: '0.4rem' }}>
                  {f}
                </code>
              ))}
            </span>
          )}
        </div>
        <div className="kv-row kv-row--col">
          <span className="kv-row__k">dependency blockers</span>
          {Object.keys(t.satisfiedDeps).length === 0 ? (
            <span className="card__title">no declared dependencies</span>
          ) : (
            <span>
              {Object.entries(t.satisfiedDeps).map(([dep, where]) => (
                <span
                  key={dep}
                  className={where === 'pending' ? 'trace-pill trace-pill--gap' : 'trace-pill'}
                  style={{ marginRight: '0.3rem' }}
                >
                  {dep} @ {where}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>

      {/* Context-pack readiness pointer. */}
      {t.contextPack ? (
        <div style={{ marginTop: '0.6rem' }}>
          <div className="card__title">
            <b>Context-pack readiness</b> · shared cache prefix:{' '}
            <code>{view.cachePrefix.id}</code> ({t.contextPack.sharedReferences.length} shared
            reference(s))
          </div>
          <div className="kv-rows" style={{ marginTop: '0.3rem' }}>
            <div className="kv-row">
              <span className="kv-row__k">acceptance criteria</span>
              <span className="pill">{t.contextPack.acceptanceCriteria.length}</span>
            </div>
            <div className="kv-row">
              <span className="kv-row__k">linked spec sections</span>
              <span className="pill">{t.contextPack.specSections.length}</span>
            </div>
            <div className="kv-row">
              <span className="kv-row__k">prior feature-proofs (file-overlap)</span>
              <span className="pill">{t.contextPack.priorFeatureProofs.length}</span>
            </div>
            <div className="kv-row">
              <span className="kv-row__k">prior invariants</span>
              <span className="pill">{t.contextPack.priorInvariants.length}</span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Copyable governed commands (display only — never executed). */}
      <div style={{ marginTop: '0.6rem' }}>
        <div className="card__title">Copyable commands (advisory — this view never runs them)</div>
        <CommandBlock t={t} />
      </div>
    </section>
  );
}

const STATUS_CHOICES = ['todo', 'doing', 'review', 'done', 'deferred', 'blocked'];

export default async function DispatchPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const pick = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const filters: DispatchFilters = {};
  const status = pick('status');
  const repo = pick('repo');
  const wave = pick('wave');
  if (status) filters.status = status;
  if (repo) filters.repo = repo;
  if (wave && /^\d+$/.test(wave)) filters.wave = Number(wave);

  const view = loadDispatchPlan(filters);

  if (!view.ok) {
    return (
      <>
        <div className="board-meta">
          <span>
            dispatch plan: <strong>error</strong>
          </span>
        </div>
        <div className="banner">
          The dispatch schedule could not be built: {view.error ?? 'unknown error'}. No plan to
          display.
        </div>
      </>
    );
  }

  const statusChoices = [
    ...STATUS_CHOICES.filter((s) => view.statuses.includes(s)),
    ...view.statuses.filter((s) => !STATUS_CHOICES.includes(s))
  ];
  const filterActive = Boolean(filters.repo || filters.wave != null);

  return (
    <>
      <div className="board-meta">
        <span>
          status: <strong>{view.statusFilter}</strong>
        </span>
        <span>
          repo: <strong>{view.repoFilter ?? 'all'}</strong>
        </span>
        <span>
          waves: <strong>{view.waveCount}</strong>
          {view.waveFilter != null ? ` (filtered to wave ${view.waveFilter})` : ''}
        </span>
        <span>
          scheduled: <strong>{view.scheduledCount}</strong>
        </span>
        <span>excluded: {view.excluded.length}</span>
        <span>read-only · advisory</span>
      </div>

      {/* Lane discipline — REQUIRED by the ticket. */}
      <div className="banner" style={{ marginBottom: '0.85rem' }}>
        <b>Lane discipline:</b> the default gate lane is <code>lean/default</code>. The{' '}
        <code>full</code> and <code>ci</code> lanes are heavy and must NOT be run concurrently
        across parallel agents on memory-constrained hosts unless a human coordinates capacity.
        This view is advisory and read-only: it never spawns an agent, never runs a gate, and never
        mutates the board.
      </div>

      <div className="ticket-grid">
        <div>
          {/* Filters: status switcher + repo/wave clear. */}
          <section className="panel" style={{ marginBottom: '0.85rem' }}>
            <h3>Schedule filters</h3>
            <div className="card__title" style={{ marginBottom: '0.4rem' }}>
              status:{' '}
              {statusChoices.map((s) => (
                <Link
                  key={s}
                  href={filterHref(filters, { status: s, wave: undefined })}
                  className={
                    view.statusFilter === s ? 'trace-pill trace-pill--verified' : 'trace-pill'
                  }
                >
                  {s}
                </Link>
              ))}
            </div>
            {view.repos.length > 0 ? (
              <div className="card__title" style={{ marginBottom: '0.4rem' }}>
                repo:{' '}
                {view.repos.map((r) => (
                  <Link
                    key={r}
                    href={filterHref(filters, {
                      repo: filters.repo === r ? undefined : r,
                      wave: undefined
                    })}
                    className={filters.repo === r ? 'trace-pill trace-pill--verified' : 'trace-pill'}
                  >
                    {r}
                  </Link>
                ))}
              </div>
            ) : null}
            {filterActive ? (
              <Link href={filterHref({ status: filters.status }, {})} className="trace-pill trace-pill--todo">
                clear repo/wave filters
              </Link>
            ) : null}
          </section>

          {/* Waves. */}
          {view.waveCount === 0 ? (
            <section className="panel" style={{ marginBottom: '0.85rem' }}>
              <h3>Wave schedule</h3>
              <div className="card__title">
                {view.scheduledCount === 0 && view.excluded.length > 0
                  ? `No tickets are schedulable at status "${view.statusFilter}" — all candidates were excluded (see below). Nothing to dispatch.`
                  : view.waveFilter != null
                    ? `No wave ${view.waveFilter} in the current schedule.`
                    : `No tickets at status "${view.statusFilter}"${
                        view.repoFilter ? ` for repo ${view.repoFilter}` : ''
                      }. Nothing to dispatch.`}
              </div>
            </section>
          ) : (
            view.waves.map((w) => (
              <div key={w.wave} style={{ marginBottom: '0.4rem' }}>
                <div className="board-meta" style={{ marginBottom: '0.4rem' }}>
                  <span>
                    <strong>Wave {w.wave}</strong>
                  </span>
                  <span>{w.tickets.length} ticket(s)</span>
                  <span>
                    {w.tickets.every((t) => t.parallelizable)
                      ? 'fully parallelizable'
                      : 'contains sequential (non-parallelizable) tickets'}
                  </span>
                  <Link href={filterHref(filters, { wave: w.wave })} className="trace-pill">
                    focus wave {w.wave}
                  </Link>
                </div>
                {w.tickets.map((t) => (
                  <TicketCard key={t.ticket} t={t} view={view} />
                ))}
              </div>
            ))
          )}
        </div>

        <aside className="side-panel">
          {/* Cache prefix — the shared cacheable prompt prefix. */}
          <section className="panel">
            <h3>Shared cache prefix</h3>
            <div className="card__title" style={{ marginBottom: '0.4rem' }}>
              <code>{view.cachePrefix.id}</code> — stable across the wave; cache once so N agents
              share one preamble.
            </div>
            {view.cachePrefix.sharedReferences.length === 0 ? (
              <div className="card__title">No shared references.</div>
            ) : (
              <div className="kv-rows">
                {view.cachePrefix.sharedReferences.map((r) => (
                  <div className="kv-row" key={r}>
                    <code>{r}</code>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Dispatch manifest command. */}
          <section className="panel">
            <h3>Dispatch manifest</h3>
            <div className="card__title" style={{ marginBottom: '0.4rem' }}>
              This page mirrors the deterministic <code>gov dispatch-plan</code> manifest. Copy to
              regenerate it on the CLI (JSON is byte-stable for the same board):
            </div>
            <pre className="cmd-list">
              {[
                `coord/scripts/gov dispatch-plan --status ${view.statusFilter}${
                  view.repoFilter ? ` --repo ${view.repoFilter}` : ''
                }`,
                `coord/scripts/gov dispatch-plan --status ${view.statusFilter} --md`,
                'coord/scripts/gov plan-waves --status ' + view.statusFilter
              ].join('\n')}
            </pre>
          </section>

          {/* Excluded — no silent drops. */}
          <section className="panel">
            <h3>
              Excluded{' '}
              <span className="rl rl--na">{view.excluded.length}</span>
            </h3>
            <div className="card__title" style={{ marginBottom: '0.4rem' }}>
              Tickets that could not be scheduled — surfaced explicitly (no silent drops). Reasons
              are inspectable below.
            </div>
            {view.excluded.length === 0 ? (
              <div className="card__title">No tickets excluded.</div>
            ) : (
              <div className="kv-rows">
                {view.excluded.map((e) => (
                  <div className="kv-row kv-row--col" key={e.ticket}>
                    <div>
                      <Link href={`/ticket/${e.ticket}`} className="kv-row__k">
                        {e.ticket}
                      </Link>{' '}
                      <span className="rl rl--blocked">excluded</span>
                    </div>
                    <div className="card__title">{e.reason}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Legend. */}
          <section className="panel">
            <h3>Action legend</h3>
            <div className="kv-rows">
              <div className="kv-row">
                <span className="kv-row__k">spawn</span>
                <span className="card__title">precheck not already-satisfied → start an agent</span>
              </div>
              <div className="kv-row">
                <span className="kv-row__k">skip</span>
                <span className="card__title">
                  precheck already-satisfied → finalize, no agent needed
                </span>
              </div>
              <div className="kv-row kv-row--col">
                <span className="kv-row__k">unknown / not recorded</span>
                <span className="card__title">
                  Verdicts are read from RECORDED <code>precheck.observed</code> journal events
                  (written by <code>gov precheck --record</code>) — this view never runs probes.
                  Unknown or not-yet-recorded → always spawn. A missing precheck NEVER becomes a
                  false skip.
                </span>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
