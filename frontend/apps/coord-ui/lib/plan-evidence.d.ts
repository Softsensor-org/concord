export interface ActivePlanEvidence {
  repoGates: string[];
  verificationCommands: string[];
  criticalInvariants: string[];
  /** the engine's refusal when the correction ledger is invalid; null otherwise. */
  error: string | null;
}
export interface ResolvedPlanEvidence {
  repo_gates: string[];
  verification_commands: string[];
  critical_invariants: string[];
}
export function activePlanEvidence(
  plan: Record<string, unknown> | null | undefined,
  resolvePlanEvidence: (plan: Record<string, unknown>) => ResolvedPlanEvidence
): ActivePlanEvidence;

export interface IndependentReviewRow {
  id: string;
  reviewer: string;
  ownerAtReview: string | null;
  repository: string;
  commit: string;
  method: string;
  findings: string[];
  verdict: string;
  timestamp: string;
  status: 'active' | 'superseded' | 'corrected';
  currency: 'current' | 'superseded' | 'corrected' | 'reviewer_is_owner' | 'scope_unresolved' | 'other_repository' | 'stale_head';
  successor: string | null;
}
export interface IndependentReviewScope {
  repository: string;
  commit: string;
  source: string | null;
}
export interface IndependentReviewView {
  scope: IndependentReviewScope | null;
  currentCount: number;
  currentReviewers: number;
  historicalCount: number;
  current: IndependentReviewRow[];
  historical: IndependentReviewRow[];
  /** the engine's refusal when the ledger is invalid; null otherwise. */
  error: string | null;
}
export interface IndependentReviewProjection {
  scope: IndependentReviewScope | null;
  counts: { current: number; current_reviewers: number; historical: number; total: number };
  current: Array<Record<string, any>>;
  historical: Array<Record<string, any>>;
  error: string | null;
}
export function independentReviewView(
  plan: Record<string, unknown> | null | undefined,
  options: { scope: IndependentReviewScope | null; owner: string | null },
  projectIndependentReviews: (plan: Record<string, unknown>, options: Record<string, unknown>) => IndependentReviewProjection
): IndependentReviewView;
