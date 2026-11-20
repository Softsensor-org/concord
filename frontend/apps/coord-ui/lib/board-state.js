const STATUS_VALUES = new Set(['todo', 'doing', 'review', 'done', 'blocked', 'proposed', 'superseded']);

const EVENT_STATUS = Object.freeze({
  start: 'doing',
  'start-ticket': 'doing',
  block: 'blocked',
  unblock: 'doing',
  submit: 'review',
  'move-review': 'review',
  land: 'done',
  'mark-done': 'done',
  close: 'done',
  finalize: 'done',
  finish: 'done',
  'finish-ticket': 'done',
  supersede: 'superseded',
  reopen: 'todo',
  'reopen-ticket': 'todo',
  unstart: 'todo'
});

function normalizeStatus(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { status: 'unknown' };

  const blocked = /^doing\s+\(blocked:\s*(.+)\)$/i.exec(value);
  if (blocked) {
    const reason = blocked[1].trim();
    if (reason) return { status: 'blocked', blockedReason: reason };
    return { status: 'unknown' };
  }

  const normalized = value.toLowerCase();
  if (STATUS_VALUES.has(normalized)) return { status: normalized };
  return { status: 'unknown' };
}

function eventState(events) {
  for (const event of events ?? []) {
    if (event?.result !== 'succeeded') continue;
    if (!Object.hasOwn(EVENT_STATUS, event.command)) continue;
    const commandStatus = EVENT_STATUS[event.command];

    if (Object.hasOwn(event, 'after_status') && event.after_status != null) {
      const parsed = normalizeStatus(event.after_status);
      return {
        ...parsed,
        owner: event.identity?.owner,
        source: 'derived'
      };
    }

    const details = event.details && typeof event.details === 'object' ? event.details : {};
    return {
      status: commandStatus,
      ...(commandStatus === 'blocked' && typeof details.reason === 'string' && details.reason.trim()
        ? { blockedReason: details.reason.trim() }
        : {}),
      owner: event.identity?.owner,
      source: 'derived'
    };
  }
  return null;
}

/** Return safety guidance for lifecycle states that must not expose `gov start`. */
export function nonRunnableStatusGuidance(id, status, blockedReason) {
  const commands = [`coord/scripts/gov explain ${id}`];
  if (status === 'proposed') {
    commands.push('# proposed — quarantined pending acceptance; do not start');
    return commands;
  }
  if (status === 'blocked') {
    commands.push(blockedReason ? `# blocked: ${blockedReason}` : '# blocked — resolve the recorded reason before proceeding');
    return commands;
  }
  if (status === 'unknown') {
    commands.push('# lifecycle status is unknown — inspect the canonical board before acting');
    return commands;
  }
  if (status === 'superseded') {
    commands.push('# superseded — no further action');
    return commands;
  }
  return null;
}

/** Merge canonical rows with active-note presence and non-authoritative evidence. */
export function mergeBoardRows({ boardRows = [], activeRows = [], locks = new Map(), eventsByTicket = new Map() } = {}) {
  const canonicalById = new Map(boardRows.map((row) => [row.id, row]));
  const activeById = new Map(activeRows.map((row) => [row.id, row]));
  const ids = new Set([...canonicalById.keys(), ...activeById.keys()]);
  const rows = [];

  for (const id of ids) {
    const canonical = canonicalById.get(id);
    const active = activeById.get(id);
    const base = canonical
      ? {
          ...(active ?? {}),
          ...canonical,
          id,
          repo: canonical.repo || active?.repo || 'X',
          type: canonical.type || active?.type,
          priority: canonical.priority || active?.priority,
          description: canonical.description || active?.description,
          dependsOn: canonical.dependsOn || active?.dependsOn,
          source: 'tasks.json'
        }
      : { ...active, id };

    const retainedReason = base.blockedReason;
    const parsed = normalizeStatus(base.status);
    base.status = parsed.status;
    if (parsed.blockedReason) base.blockedReason = parsed.blockedReason;
    else if (parsed.status === 'blocked' && typeof retainedReason === 'string' && retainedReason.trim()) {
      base.blockedReason = retainedReason;
    } else delete base.blockedReason;

    // A canonical board row is authoritative, including an unrecognized value.
    // Only active-only rows may use successful lifecycle events as fallback.
    if (!canonical) {
      const derived = eventState(eventsByTicket.get(id));
      if (derived) {
        base.status = derived.status;
        if (derived.blockedReason) base.blockedReason = derived.blockedReason;
        else delete base.blockedReason;
        if (!base.owner && derived.owner) base.owner = derived.owner;
        base.source = 'derived';
      } else base.status = 'unknown';
    }

    const lock = locks.get(id);
    if (!base.owner && lock?.owner) base.owner = lock.owner;
    rows.push(base);
  }

  return rows;
}

export { normalizeStatus };
