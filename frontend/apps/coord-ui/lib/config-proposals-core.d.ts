export interface ProposalArgsInput { target: string; value: unknown; baseDigest: string; }
export interface ProposalResultShape {
  proposal_id: string;
  target: string;
  base_digest: string;
  diff: unknown;
  refusal?: string | null;
}
export interface PendingProposalShape {
  proposal_id: string;
  target: string;
  base_digest: string;
  result_digest: string;
  proposer: string | null;
  created_at: string;
  diff: unknown;
}
export function proposalArgs(input: ProposalArgsInput): string[];
export function parseProposalResult(stdout: string): ProposalResultShape;
export function pendingProposals(events: Array<Record<string, unknown>>): PendingProposalShape[];
