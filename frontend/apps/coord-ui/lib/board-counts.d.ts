export type BoardCountStatus = 'proposed' | 'todo' | 'doing' | 'review' | 'done' | 'blocked' | 'superseded' | 'unknown';
export type BoardCountsInput = {
  rows: unknown[];
  byStatus: Record<BoardCountStatus, unknown[]>;
};
export type BoardCounts = {
  totalCount: number;
  visibleCount: number;
  omittedCount: number;
  omittedByStatus: Array<{ status: BoardCountStatus; count: number }>;
  unclassifiedCount: number;
  unclassifiedDisposition: 'visible-lane' | 'omitted';
};
export const VISIBLE_BOARD_STATUSES: readonly BoardCountStatus[];
export function deriveBoardCounts(board: BoardCountsInput, visibleStatuses?: readonly BoardCountStatus[]): BoardCounts;
