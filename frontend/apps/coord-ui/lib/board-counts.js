export const VISIBLE_BOARD_STATUSES = Object.freeze([
  'proposed', 'todo', 'doing', 'review', 'done', 'blocked', 'unknown'
]);

const ALL_STATUSES = Object.freeze([
  'proposed', 'todo', 'doing', 'review', 'done', 'blocked', 'superseded', 'unknown'
]);

function canonicalRowStatuses(rows) {
  const rowStatus = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id) {
      throw new Error('Board row partition mismatch: every canonical row must have an id.');
    }
    if (rowStatus.has(row.id)) {
      throw new Error(`Board row partition mismatch: duplicate canonical row id ${row.id}.`);
    }
    rowStatus.set(row.id, row.status);
  }
  return rowStatus;
}

function assertBucketIdentities(byStatus, rowStatus) {
  const bucketIds = new Set();
  for (const status of ALL_STATUSES) {
    for (const row of byStatus[status]) {
      if (!row || typeof row.id !== 'string' || !row.id) {
        throw new Error(`Board row partition mismatch: bucket ${status} contains a row without an id.`);
      }
      if (row.status !== status) {
        throw new Error(`Board row partition mismatch: row ${row.id} is in ${status} but carries status ${row.status}.`);
      }
      if (rowStatus.has(row.id) && rowStatus.get(row.id) !== status) {
        throw new Error(`Board row partition mismatch: canonical row ${row.id} carries status ${rowStatus.get(row.id)} but is bucketed as ${status}.`);
      }
      if (bucketIds.has(row.id)) {
        throw new Error(`Board row partition mismatch: row ${row.id} appears in multiple buckets.`);
      }
      bucketIds.add(row.id);
    }
  }
  const missingFromBuckets = [...rowStatus.keys()].filter((id) => !bucketIds.has(id));
  const absentFromRows = [...bucketIds].filter((id) => !rowStatus.has(id));
  if (missingFromBuckets.length || absentFromRows.length) {
    throw new Error(
      `Board row partition mismatch: ${missingFromBuckets.length} canonical rows missing from buckets; ` +
      `${absentFromRows.length} bucket rows absent from canonical rows.`
    );
  }
}

/** Derive an honest row reconciliation from the final BoardView partition. */
export function deriveBoardCounts(board, visibleStatuses = VISIBLE_BOARD_STATUSES) {
  if (!board || !Array.isArray(board.rows) || !board.byStatus || typeof board.byStatus !== 'object') {
    throw new TypeError('Board count input must contain rows and final byStatus buckets.');
  }
  const visible = new Set(visibleStatuses);
  const buckets = ALL_STATUSES.map((status) => {
    const rows = board.byStatus[status];
    if (!Array.isArray(rows)) throw new TypeError(`Missing final board bucket: ${status}`);
    return { status, count: rows.length };
  });
  const bucketTotal = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  if (bucketTotal !== board.rows.length) {
    throw new Error(`Board row partition mismatch: rows=${board.rows.length}, buckets=${bucketTotal}.`);
  }
  assertBucketIdentities(board.byStatus, canonicalRowStatuses(board.rows));
  for (const status of visible) {
    if (!ALL_STATUSES.includes(status)) throw new TypeError(`Unknown visible board status: ${status}`);
  }

  const visibleCount = buckets.reduce((sum, bucket) => sum + (visible.has(bucket.status) ? bucket.count : 0), 0);
  const omittedByStatus = buckets
    .filter((bucket) => !visible.has(bucket.status))
    .map(({ status, count }) => ({ status, count }));
  const omittedCount = omittedByStatus.reduce((sum, bucket) => sum + bucket.count, 0);

  return {
    totalCount: board.rows.length,
    visibleCount,
    omittedCount,
    omittedByStatus,
    unclassifiedCount: board.byStatus.unknown.length,
    unclassifiedDisposition: visible.has('unknown') ? 'visible-lane' : 'omitted'
  };
}
