export type Status = 'todo' | 'doing' | 'review' | 'done' | 'blocked' | 'superseded' | 'unknown';

export interface BoardRow {
  id: string;
  repo: string;
  type?: string;
  priority?: string;
  status: Status;
  owner?: string;
  description?: string;
  dependsOn?: string;
  source: 'tasks.json' | 'active' | 'derived';
}

export interface LockInfo {
  id: string;
  owner?: string;
  agentId?: string;
  branch?: string;
  head?: string;
  startedAt?: string;
  raw?: unknown;
}

export interface GovEvent {
  ts: string;
  command: string;
  ticket: string | null;
  before_status?: string | null;
  after_status?: string | null;
  identity?: {
    agent_id?: string | null;
    owner?: string | null;
    session_id?: string | null;
    thread_id?: string | null;
  };
  result?: string;
  details?: unknown;
  snapshot_digest?: string;
  changed_paths?: string[];
}
