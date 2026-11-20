import type { BoardRow, GovEvent, LockInfo, Status } from './types';

export interface NormalizedStatus {
  status: Status;
  blockedReason?: string;
}

export interface MergeBoardRowsInput {
  boardRows?: BoardRow[];
  activeRows?: BoardRow[];
  locks?: Map<string, LockInfo>;
  /** Events ordered newest first, as returned by listEvents(). */
  eventsByTicket?: Map<string, GovEvent[]>;
}

export function normalizeStatus(raw: unknown): NormalizedStatus;
export function mergeBoardRows(input?: MergeBoardRowsInput): BoardRow[];
export function nonRunnableStatusGuidance(id: string, status: Status, blockedReason?: string): string[] | null;
