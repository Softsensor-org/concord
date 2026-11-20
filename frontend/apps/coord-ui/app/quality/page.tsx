import Link from 'next/link';
import { loadQualityCockpit, planCommands, DEFAULT_SCOPE_ID } from '../../lib/quality';
import type {
  ArchFinding,
  DuplicationGroup,
  QualityCockpit,
  QualityScope,
  ScanFilters
} from '../../lib/quality';

// The cockpit reads source files at request time, so it must not be statically
// cached at build — render dynamically (read-only fs, no mutation).
export const dynamic = 'force-dynamic';

// Documented check order (mirrors arch-checks.js CHECKS).
const CHECK_ORDER = [
  'size',
  'complexity',
  'imports',
  'duplication',
  'monolith',
  'hardcoding',
  'deadcode'
];

function resultClass(result: string): string {
  if (result === 'pass') return 'gate-status gate-status--pass';
  if (result === 'fail') return 'gate-status gate-status--fail';
  return 'gate-status'; // warn / unknown — neutral, NOT hidden
}

function sevClass(sev: string): string {
  if (sev === 'fail') return 'sev sev--high';
  if (sev === 'warn') return 'sev sev--med';
  return 'sev';
}

// Priority pill. Only p0/p1/p2 have a styled variant in globals.css; lower
// priorities (P3) degrade to the neutral base pill rather than borrowing a
// higher-severity color.
function priClass(pri: string): string {
  const p = pri.toLowerCase();
  if (p === 'p0' || p === 'p1' || p === 'p2') return `pill pill--${p}`;
  return 'pill';
}

/** Serialize scope + filters into a /quality URL. The default scope (coord) is
 * omitted for a clean canonical URL; any other scope is pinned so toggling a
 * filter stays within the active scope. */
function buildHref(scopeId: string, filters: ScanFilters): string {
  const params = new URLSearchParams();
  if (scopeId && scopeId !== DEFAULT_SCOPE_ID) params.set('scope', scopeId);
  if (filters.check) params.set('check', filters.check);
  if (filters.file) params.set('file', filters.file);
  const qs = params.toString();
  return qs ? `/quality?${qs}` : '/quality';
}

/** Build a /quality URL with a check/file filter toggled within the active
 * scope. Passing the same active value clears it (toggle-off), so a chip both
 * sets and removes. */
function filterHref(
  scopeId: string,
  active: ScanFilters,
  key: 'check' | 'file',
  value: string
): string {
  const next: ScanFilters = { ...active };
  if (next[key] === value) delete next[key];
  else next[key] = value;
  return buildHref(scopeId, next);
}

/** Switching scope drops the check/file filters (they reference paths of the
 * previous root). */
function scopeHref(scopeId: string): string {
  return buildHref(scopeId, {});
}

function FindingRow({ f }: { f: ArchFinding }) {
  const where = f.line != null ? `${f.file}:${f.line}` : f.file;
  return (
    <div className="kv-row kv-row--col">
      <div>
        <span className={sevClass(f.severity)}>{f.severity}</span>{' '}
        <code>{f.check}</code> · <code>{where}</code>
      </div>
      <div className="card__title">{f.message}</div>
    </div>
  );
}

function DupRow({ d }: { d: DuplicationGroup }) {
  const where = d.line != null ? `${d.file}:${d.line}` : d.file;
  return (
    <div className="kv-row kv-row--col">
      <div>
        <span className={sevClass(d.severity)}>{d.severity}</span>{' '}
        <code>{where}</code> · {d.span} lines · <code>#{d.hash}</code>
      </div>
      <div className="card__title">
        canonical source: {d.canonical ? <code>{d.canonical}</code> : 'self / not attributed'}
      </div>
    </div>
  );
}

export default async function QualityPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const pick = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const filters: ScanFilters = {};
  const checkFilter = pick('check');
  const fileFilter = pick('file');
  if (checkFilter) filters.check = checkFilter;
  if (fileFilter) filters.file = fileFilter;
  const scopeReq = pick('scope');

  const q: QualityCockpit = loadQualityCockpit(filters, scopeReq);
  const cmds = planCommands(q);
  const filterActive = Boolean(filters.check || filters.file);
  const activeScopeId = q.scope.id;

  // Server-rendered scope toggle (no client JS): one link per scannable root.
  // EXACTLY ONE root is scanned per request — switching is just a new request.
  const scopeSelector = (
    <div className="board-meta" style={{ marginBottom: '0.6rem' }}>
      <span>scan scope:</span>
      {q.scopes.map((s: QualityScope) => (
        <Link
          key={s.id}
          href={scopeHref(s.id)}
          className={
            s.id === activeScopeId ? 'trace-pill trace-pill--verified' : 'trace-pill'
          }
        >
          {s.label}
          {s.missing ? ' · (no root)' : ''}
        </Link>
      ))}
    </div>
  );

  if (!q.ok) {
    return (
      <>
        {scopeSelector}
        <div className="board-meta">
          <span>
            quality scan: <strong>error</strong>
          </span>
          <span>scope: {q.scope.label}</span>
          <span>root: {q.scanRoot}/</span>
        </div>
        <div className="banner">
          The arch-checks scan could not run: {q.error ?? 'unknown error'}. No quality data to
          display.
        </div>
      </>
    );
  }

  if (q.missingRoot) {
    return (
      <>
        {scopeSelector}
        <div className="board-meta">
          <span>
            scope: <strong>{q.scope.label}</strong>
          </span>
          <span>root: {q.scanRoot}/</span>
        </div>
        <div className="banner">
          Scope <code>{q.scope.id}</code> has no directory at <code>{q.scanRoot}/</code> on this
          checkout — nothing to scan. (Downstream product repos vary; the template stubs are
          small.) Pick another scope above.
        </div>
      </>
    );
  }

  const orderedChecks = [
    ...CHECK_ORDER.filter((c) => c in q.summary.byCheck),
    ...q.checks.filter((c) => !CHECK_ORDER.includes(c))
  ];

  return (
    <>
      {scopeSelector}
      <div className="board-meta">
        <span>
          arch result:{' '}
          <span className={resultClass(q.summary.result)}>{q.summary.result}</span>
        </span>
        <span>
          files scanned: <strong>{q.fileCount}</strong>
        </span>
        <span>
          findings: <strong>{q.summary.findings}</strong>
        </span>
        <span>fail: {q.summary.failCount}</span>
        <span>warn: {q.summary.warnCount}</span>
        <span>
          scope: <strong>{q.scope.label}</strong> ({q.scanRoot}/)
        </span>
      </div>

      <div className="ticket-grid">
        <div>
          {/* Summary by check — the headline architecture picture. */}
          <section className="panel" style={{ marginBottom: '0.85rem' }}>
            <h3>Findings by check</h3>
            {q.summary.findings === 0 ? (
              <div className="card__title">
                Clean scan — no architecture findings across {q.fileCount} files. Nothing to file.
              </div>
            ) : (
              <div className="kv-rows">
                {orderedChecks.map((c) => {
                  const n = q.summary.byCheck[c] ?? 0;
                  const isActive = filters.check === c;
                  return (
                    <div className="kv-row" key={c}>
                      <Link
                        href={filterHref(activeScopeId, filters, 'check', c)}
                        className={isActive ? 'kv-row__k rl rl--ready' : 'kv-row__k'}
                      >
                        {c}
                        {isActive ? ' · filtering' : ''}
                      </Link>
                      <span className={n > 0 ? 'pill' : 'card__title'}>{n}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Filterable findings list. */}
          <section className="panel" style={{ marginBottom: '0.85rem' }}>
            <h3>
              Findings{' '}
              {filterActive ? (
                <span className="rl rl--ready">
                  {q.findings.length} of {q.totalFindings} · filtered
                </span>
              ) : (
                <span className="rl rl--na">{q.totalFindings} total</span>
              )}
            </h3>
            <div className="card__title" style={{ marginBottom: '0.5rem' }}>
              filter by check:{' '}
              {orderedChecks
                .filter((c) => (q.summary.byCheck[c] ?? 0) > 0)
                .map((c) => (
                  <Link
                    key={c}
                    href={filterHref(activeScopeId, filters, 'check', c)}
                    className={filters.check === c ? 'trace-pill trace-pill--verified' : 'trace-pill'}
                  >
                    {c}
                  </Link>
                ))}
              {filterActive ? (
                <Link href={buildHref(activeScopeId, {})} className="trace-pill trace-pill--todo">
                  clear filters
                </Link>
              ) : null}
            </div>
            {filters.file ? (
              <div className="card__title" style={{ marginBottom: '0.5rem' }}>
                file filter: <code>{filters.file}</code>{' '}
                <Link href={filterHref(activeScopeId, filters, 'file', filters.file)} className="trace-pill">
                  remove
                </Link>
              </div>
            ) : null}
            {q.findings.length === 0 ? (
              <div className="card__title">
                {q.totalFindings === 0
                  ? 'No findings to show.'
                  : 'No findings match the active filter. Clear it to see all findings.'}
              </div>
            ) : (
              <div className="kv-rows">
                {q.findings.map((f, i) => (
                  <FindingRow key={`${f.check}-${f.file}-${f.line ?? i}`} f={f} />
                ))}
              </div>
            )}
          </section>

          {/* Per-file finding counts (filterable). */}
          <section className="panel" style={{ marginBottom: '0.85rem' }}>
            <h3>Findings by file</h3>
            {q.byFile.length === 0 ? (
              <div className="card__title">No files with findings in the current view.</div>
            ) : (
              <div className="kv-rows">
                {q.byFile.map((g) => (
                  <div className="kv-row kv-row--col" key={g.file}>
                    <div>
                      <Link
                        href={filterHref(activeScopeId, filters, 'file', g.file)}
                        className={filters.file === g.file ? 'kv-row__k rl rl--ready' : 'kv-row__k'}
                      >
                        {g.file}
                      </Link>{' '}
                      <span className="pill">{g.total}</span>
                      {g.fail > 0 ? <span className="sev sev--high"> {g.fail} fail</span> : null}
                    </div>
                    <div className="card__title">
                      {Object.entries(g.byCheck)
                        .map(([c, n]) => `${c}: ${n}`)
                        .join(' · ')}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Proposed ticket cards — quality-scan dry-run survivors. */}
          <section className="panel">
            <h3>
              Proposed quality tickets{' '}
              <span className="rl rl--na">
                floor {q.plan.severityFloor} · would file {q.plan.counts.toFile}
              </span>
            </h3>
            <div className="card__title" style={{ marginBottom: '0.5rem' }}>
              These mirror <code>gov quality-scan</code> dry-run output. This view NEVER files or
              applies anything — copy a command to act.
            </div>
            <pre className="cmd-list">{cmds.join('\n')}</pre>
            {q.plan.proposals.length === 0 ? (
              <div className="card__title">
                {q.plan.counts.findings === 0
                  ? 'No findings — nothing would be filed.'
                  : 'No new tickets would be filed (all eligible findings are below the floor, already open, or deduped).'}
              </div>
            ) : (
              <div className="kv-rows">
                {q.plan.proposals.map((p) => (
                  <div className="kv-row kv-row--col" key={p.key}>
                    <div>
                      <span className={priClass(p.pri)}>{p.pri}</span>{' '}
                      <span className={sevClass(p.severity)}>{p.severity}</span> <code>{p.check}</code>{' '}
                      · <code>{p.evidence.where}</code>
                    </div>
                    <div>{p.title}</div>
                    <div className="card__title">qkey: <code>{p.key}</code></div>
                  </div>
                ))}
              </div>
            )}
            {q.plan.capped.length > 0 ? (
              <div className="card__title" style={{ marginTop: '0.5rem' }}>
                + {q.plan.capped.length} more eligible but capped (raise <code>--cap</code> to file
                them).
              </div>
            ) : null}
          </section>
        </div>

        <aside className="side-panel">
          {/* Dry-run accounting — open vs in-run dedup kept SEPARATE. */}
          <section className="panel">
            <h3>Quality-scan accounting</h3>
            <dl className="git-meta">
              <dt>findings</dt>
              <dd>{q.plan.counts.findings}</dd>
              <dt>below floor ({q.plan.severityFloor})</dt>
              <dd>{q.plan.counts.belowFloor}</dd>
              <dt>skipped — open ticket</dt>
              <dd>{q.plan.counts.skippedOpen}</dd>
              <dt>skipped — within run</dt>
              <dd>{q.plan.counts.skippedInRun}</dd>
              <dt>eligible</dt>
              <dd>{q.plan.counts.eligible}</dd>
              <dt>would file (cap {q.plan.cap})</dt>
              <dd>{q.plan.counts.toFile}</dd>
              <dt>capped</dt>
              <dd>{q.plan.counts.capped}</dd>
            </dl>
            <div className="card__title">
              <b>open</b> dedup = key already has a live board ticket. <b>within-run</b> dedup = two
              findings collapse to one key this scan. Tracked separately — never conflated.
            </div>
          </section>

          {/* Complexity hotspots. */}
          <section className="panel">
            <h3>Top complexity hotspots</h3>
            {q.complexityHotspots.length === 0 ? (
              <div className="card__title">No functions over the complexity budget.</div>
            ) : (
              <div className="kv-rows">
                {q.complexityHotspots.map((h, i) => (
                  <div className="kv-row" key={`${h.file}-${h.fn}-${i}`}>
                    <Link
                      href={filterHref(activeScopeId, { check: 'complexity' }, 'file', h.file)}
                      className="kv-row__k"
                    >
                      {h.fn}
                    </Link>
                    <span className={sevClass(h.severity)}>
                      ~{h.value} / {h.threshold}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Duplication groups with canonical attribution. */}
          <section className="panel">
            <h3>Duplication groups</h3>
            {q.duplicationGroups.length === 0 ? (
              <div className="card__title">No duplicate blocks over the line threshold.</div>
            ) : (
              <div className="kv-rows">
                {q.duplicationGroups.map((d, i) => (
                  <DupRow key={`${d.hash}-${d.file}-${i}`} d={d} />
                ))}
              </div>
            )}
          </section>

          {/* Hardcoding candidates. */}
          <section className="panel">
            <h3>Hardcoding candidates</h3>
            {q.hardcodingCandidates.length === 0 ? (
              <div className="card__title">No config-seam leaks flagged.</div>
            ) : (
              <div className="kv-rows">
                {q.hardcodingCandidates.map((h, i) => (
                  <div className="kv-row kv-row--col" key={`${h.file}-${h.line ?? i}`}>
                    <div>
                      <span className={sevClass(h.severity)}>{h.severity}</span>{' '}
                      <code>
                        {h.file}
                        {h.line != null ? `:${h.line}` : ''}
                      </code>
                    </div>
                    <div className="card__title">{h.message}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
