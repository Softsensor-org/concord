export function BlockedReason({ reason }: { reason: string }) {
  return (
    <div className="card__title">
      <strong>blocked: </strong>{reason}
    </div>
  );
}
