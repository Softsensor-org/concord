// COORD-822: cockpit pages read plan evidence through the engine's active
// projection (resolvePlanEvidence), never the raw append-only lists, so a
// superseded repo gate or a retracted invariant is never shown as current.
// The resolver is injected: the served page loads the engine module from disk
// and the test loads the same file, so there is one projection, not a copy.
//
// Fail closed: an invalid correction ledger yields no current evidence plus the
// engine's refusal message; the raw history is never substituted for it.
export function activePlanEvidence(plan, resolvePlanEvidence) {
  if (!plan) {
    return { repoGates: [], verificationCommands: [], criticalInvariants: [], error: null };
  }
  try {
    const active = resolvePlanEvidence(plan);
    return {
      repoGates: active.repo_gates,
      verificationCommands: active.verification_commands,
      criticalInvariants: active.critical_invariants,
      error: null
    };
  } catch (error) {
    return {
      repoGates: [],
      verificationCommands: [],
      criticalInvariants: [],
      error: String(error && error.message ? error.message : error)
    };
  }
}

// COORD-718: independent reviews through the engine projection, scoped to the
// ticket's claimed head. Current and historical are the engine's split; a
// QUESTIONS.md row or a self-review cycle is never an input here.
// Fail closed: an invalid ledger, or an engine that cannot be loaded, shows no
// current review plus the refusal.
export function independentReviewView(plan, options, projectIndependentReviews) {
  let projection;
  try {
    projection = projectIndependentReviews(plan || {}, options || {});
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    projection = { scope: null, counts: { current: 0, current_reviewers: 0, historical: 0 }, current: [], historical: [], error: message };
  }
  const row = (item) => ({
    id: item.id,
    reviewer: item.reviewer.handle,
    ownerAtReview: item.owner_at_review,
    repository: item.repository,
    commit: item.commit,
    method: item.method,
    findings: item.findings,
    verdict: item.verdict,
    timestamp: item.timestamp,
    status: item.status,
    currency: item.currency,
    successor: item.successor
  });
  return {
    scope: projection.scope,
    currentCount: projection.counts.current,
    currentReviewers: projection.counts.current_reviewers,
    historicalCount: projection.counts.historical,
    current: projection.current.map(row),
    historical: projection.historical.map(row),
    error: projection.error
  };
}
