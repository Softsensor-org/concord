const EPOCH_SENTINEL = '1970-01-01T00:00:00.000Z';

export function discoveryDateLabel(generatedAt) {
  if (!generatedAt || generatedAt === EPOCH_SENTINEL) return null;
  return generatedAt.slice(0, 10);
}
