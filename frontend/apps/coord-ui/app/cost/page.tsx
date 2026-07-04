import Link from 'next/link';
import { loadCostLedger } from '../../lib/cost';
import type { CostBucket, CostDimension, CostLedger } from '../../lib/cost';
import { requireRole } from '../../lib/access';

// Reads the journal + price table at request time — render dynamically.
// SEC-001: cost detail (USD / token economics) is operator-sensitive. A viewer
// (low-privilege) is denied the cost view entirely; operator+ sees it in full.
export const dynamic = 'force-dynamic';

const DIMENSIONS: { key: CostDimension; label: string }[] = [
  { key: 'ticket', label: 'ticket' },
  { key: 'agent', label: 'agent' },
  { key: 'model', label: 'model' },
  { key: 'tier', label: 'tier' }
];

function usd(n: number): string {
  return `$${n.toFixed(6)}`;
}

function tokens(n: number): string {
  return n.toLocaleString('en-US');
}

function BucketTable({
  title,
  buckets,
  linkTicket
}: {
  title: string;
  buckets: CostBucket[];
  linkTicket?: boolean;
}) {
  return (
    <section className="panel" style={{ marginBottom: '0.85rem' }}>
      <h3>
        {title} <span className="rl rl--na">{buckets.length} bucket(s)</span>
      </h3>
      {buckets.length === 0 ? (
        <div className="card__title">No observations in this breakdown.</div>
      ) : (
        <div className="kv-rows">
          {buckets.map((b) => (
            <div className="kv-row kv-row--col" key={b.key}>
              <div>
                {linkTicket ? (
                  <Link href={`/cost?ticket=${b.key}`} className="kv-row__k">
                    {b.key}
                  </Link>
                ) : (
                  <span className="kv-row__k">{b.key}</span>
                )}{' '}
                <span className="pill">{usd(b.usd)}</span>
                {b.fallbackPriced > 0 ? (
                  <span className="rl rl--pending"> {b.fallbackPriced} fallback-priced</span>
                ) : null}
              </div>
              <div className="card__title">
                {b.observations} obs · {tokens(b.inputTokens)} in / {tokens(b.outputTokens)} out tokens
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default async function CostPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole('operator');
  const sp = await searchParams;
  const pick = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const ticket = pick('ticket') ?? null;

  const ledger: CostLedger = loadCostLedger(ticket);
  const { totals, price } = ledger;

  return (
    <>
      <div className="board-meta">
        <span>
          observations: <strong>{totals.observations}</strong>
        </span>
        <span>
          total: <strong>{usd(totals.usd)}</strong>
        </span>
        <span>
          tokens: {tokens(totals.inputTokens)} in / {tokens(totals.outputTokens)} out
        </span>
        {ticket ? (
          <span>
            ticket filter: <strong>{ticket}</strong>
          </span>
        ) : null}
        <span>read-only ledger mirror</span>
      </div>

      {ticket ? (
        <div className="card__title" style={{ margin: '0 0 0.6rem' }}>
          <Link href="/cost" className="back">
            ← all tickets
          </Link>{' '}
          · <Link href={`/evidence?ticket=${ticket}`} className="kv-row__k">evidence dossier for {ticket} →</Link>
        </div>
      ) : null}

      {/* Missing/unknown price-data callout — never breaks rendering. */}
      {!price.present ? (
        <div className="banner">
          Price table <code>coord/product/model-prices.json</code> is missing or unreadable. Cost
          totals fall back to the conservative built-in rate ({usd(price.fallback.input)}/
          {usd(price.fallback.output)} per 1M in/out tokens). Recorded USD is shown as-is; no
          re-pricing happens in this read-only view.
        </div>
      ) : ledger.fallbackPricedCount > 0 ? (
        <div className="banner">
          {ledger.fallbackPricedCount} observation(s) were priced by the default fallback (model not
          in the price table). Their model is unknown to <code>{price.source}</code>; add it under{' '}
          <code>models</code> to price exactly. Rendering is unaffected.
        </div>
      ) : null}

      {/* Empty-ledger zero state — useful, not a broken card. */}
      {ledger.empty ? (
        <section className="panel">
          <h3>Cost ledger</h3>
          <div className="card__title">
            {ticket
              ? `No cost.observed events recorded for ${ticket}. Cost is recorded out-of-band via `
              : 'No cost.observed events in the governance journal yet. The ledger is empty. Cost is recorded out-of-band via '}
            <code>coord/scripts/gov record-cost &lt;ticket&gt; --model … --input-tokens … --output-tokens …</code>
            . This view never records cost — it only reads the journal.
          </div>
          <div className="card__title" style={{ marginTop: '0.5rem' }}>
            Totals are <b>deterministic</b>: identical journal input yields identical totals (USD
            summed then rounded to 6 dp, breakdowns key-sorted, no timestamps).
          </div>
        </section>
      ) : (
        <div className="ticket-grid">
          <div>
            <BucketTable title="By ticket" buckets={ledger.byTicket} linkTicket />
            <BucketTable title="By agent" buckets={ledger.byAgent} />
            <BucketTable title="By model" buckets={ledger.byModel} />
            <BucketTable title="By tier" buckets={ledger.byTier} />
            <BucketTable title="Landed / done tickets only" buckets={ledger.byLandedTicket} linkTicket />
          </div>

          <aside className="side-panel">
            <section className="panel">
              <h3>Ledger totals</h3>
              <dl className="git-meta">
                <dt>observations</dt>
                <dd>{totals.observations}</dd>
                <dt>estimated</dt>
                <dd>
                  {ledger.estimatedCount} / {totals.observations}
                </dd>
                <dt>fallback-priced</dt>
                <dd>{ledger.fallbackPricedCount}</dd>
                <dt>input tokens</dt>
                <dd>{tokens(totals.inputTokens)}</dd>
                <dt>output tokens</dt>
                <dd>{tokens(totals.outputTokens)}</dd>
                <dt>total USD</dt>
                <dd>{usd(totals.usd)}</dd>
              </dl>
              <div className="card__title">
                Deterministic: identical journal input → identical totals (6-dp rounding, key-sorted
                breakdowns, no timestamps). Mirrors <code>gov cost</code> math; records nothing.
              </div>
            </section>

            {/* Price table — display only, flags missing data. */}
            <section className="panel">
              <h3>
                Price table{' '}
                <span className={price.present ? 'rl rl--ready' : 'rl rl--blocked'}>
                  {price.present ? 'present' : 'missing'}
                </span>
              </h3>
              <div className="card__title" style={{ marginBottom: '0.5rem' }}>
                source: <code>{price.source}</code> · {price.unit} ({price.currency})
              </div>
              {price.rows.length === 0 ? (
                <div className="card__title">
                  No model rows. Using built-in fallback {usd(price.fallback.input)}/
                  {usd(price.fallback.output)} per 1M in/out tokens.
                </div>
              ) : (
                <div className="kv-rows">
                  {price.rows.map((r) => (
                    <div className="kv-row" key={r.model}>
                      <span className="kv-row__k">{r.model}</span>
                      <span className="card__title">
                        {usd(r.input)} in / {usd(r.output)} out
                      </span>
                    </div>
                  ))}
                  <div className="kv-row">
                    <span className="kv-row__k">default (fallback)</span>
                    <span className="card__title">
                      {usd(price.fallback.input)} in / {usd(price.fallback.output)} out
                    </span>
                  </div>
                </div>
              )}
            </section>
          </aside>
        </div>
      )}
    </>
  );
}
