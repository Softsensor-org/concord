import { loadReadinessView } from '../../lib/readiness';

function list(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

function statusClass(open: boolean): string {
  return open ? 'fstatus fstatus--open' : 'fstatus fstatus--resolved';
}

export const dynamic = 'force-dynamic';

export default function ReadinessPage() {
  const r = loadReadinessView();

  return (
    <>
      <div className="board-meta">
        <span>
          profile: <strong>{r.recommendedProfile}</strong>
        </span>
        <span>
          phase: <strong>{r.recommendedPhase}</strong>
        </span>
        <span>
          shape: <strong>{r.detectedShape}</strong>
        </span>
        <span>read-only artifact mirror</span>
      </div>

      <div className="banner" role="note">
        {r.note}
      </div>

      {!r.found ? (
        <div className="banner">
          Generate the readiness artifact outside the UI:{' '}
          <code className="event__cmd">{r.generatedCommand}</code>
        </div>
      ) : null}

      <h3 className="section-h">Setup Posture</h3>
      <div className="issues">
        <div className="issue" style={{ gridTemplateColumns: '220px 1fr' }}>
          <span className="issue-ticket">Artifact</span>
          <span className="issue-summary">{r.sourcePath}</span>
        </div>
        <div className="issue" style={{ gridTemplateColumns: '220px 1fr' }}>
          <span className="issue-ticket">Setup decisions</span>
          <span className="issue-summary">
            {r.setupDecisions.present ? 'present' : 'missing'} ·{' '}
            {r.setupDecisions.valid ? 'valid' : 'not valid'} · profile:{' '}
            {r.setupDecisions.profile} · phase: {r.setupDecisions.phase}
          </span>
        </div>
        <div className="issue" style={{ gridTemplateColumns: '220px 1fr' }}>
          <span className="issue-ticket">Tracks</span>
          <span className="issue-summary">{list(r.setupDecisions.tracks)}</span>
        </div>
        <div className="issue" style={{ gridTemplateColumns: '220px 1fr' }}>
          <span className="issue-ticket">Suggested gates</span>
          <span className="issue-summary">{list(r.setupDecisions.gates)}</span>
        </div>
      </div>

      <h3 className="section-h">Detected Shape</h3>
      <div className="issues">
        <div className="issue" style={{ gridTemplateColumns: '220px 1fr' }}>
          <span className="issue-ticket">Signals</span>
          <span className="issue-summary">{list(r.detectedSignals)}</span>
        </div>
        <div className="issue" style={{ gridTemplateColumns: '220px 1fr' }}>
          <span className="issue-ticket">Package managers</span>
          <span className="issue-summary">{list(r.packageManagers)}</span>
        </div>
        <div className="issue" style={{ gridTemplateColumns: '220px 1fr' }}>
          <span className="issue-ticket">Test commands</span>
          <span className="issue-summary">{list(r.testCommands)}</span>
        </div>
        <div className="issue" style={{ gridTemplateColumns: '220px 1fr' }}>
          <span className="issue-ticket">Build commands</span>
          <span className="issue-summary">{list(r.buildCommands)}</span>
        </div>
      </div>

      <h3 className="section-h">Gaps</h3>
      <div className="issues">
        <div className="issue" style={{ gridTemplateColumns: '240px 1fr' }}>
          <span className="issue-ticket">Missing governance artifacts</span>
          <span className="issue-summary">{list(r.missingGovernanceArtifacts)}</span>
        </div>
        <div className="issue" style={{ gridTemplateColumns: '240px 1fr' }}>
          <span className="issue-ticket">Shim drift</span>
          <span className="issue-summary">{list(r.shimDrift)}</span>
        </div>
        <div className="issue" style={{ gridTemplateColumns: '240px 1fr' }}>
          <span className="issue-ticket">Requirements/doc gaps</span>
          <span className="issue-summary">{list(r.requirementGaps)}</span>
        </div>
        <div className="issue" style={{ gridTemplateColumns: '240px 1fr' }}>
          <span className="issue-ticket">Test/gate maturity</span>
          <span className="issue-summary">{list(r.testGateMaturity)}</span>
        </div>
      </div>

      <h3 className="section-h">Suggested Tickets</h3>
      {r.suggestedTickets.length === 0 ? (
        <div className="banner">No suggested tickets in the readiness artifact.</div>
      ) : (
        <div className="issues">
          {r.suggestedTickets.map((ticket) => (
            <div key={ticket.id} className="issue" style={{ gridTemplateColumns: '120px 140px 1fr' }}>
              <span className="issue-ticket">{ticket.id}</span>
              <span className={statusClass(ticket.open)}>{ticket.status}</span>
              <span className="issue-summary">{ticket.open ? 'open follow-up' : 'closed or superseded'}</span>
            </div>
          ))}
        </div>
      )}

      <h3 className="section-h">Pilot vs Enterprise Blockers</h3>
      <div className="issues">
        <div className="issue" style={{ gridTemplateColumns: '180px 1fr' }}>
          <span className="issue-ticket">Pilot</span>
          <span className="issue-summary">{list(r.pilotBlockers)}</span>
        </div>
        <div className="issue" style={{ gridTemplateColumns: '180px 1fr' }}>
          <span className="issue-ticket">Enterprise</span>
          <span className="issue-summary">{list(r.enterpriseBlockers)}</span>
        </div>
      </div>

      <h3 className="section-h">Findings</h3>
      {r.findings.length === 0 ? (
        <div className="banner">No findings in the readiness artifact.</div>
      ) : (
        <div className="issues">
          {r.findings.map((finding) => (
            <div key={finding.code} className="issue" style={{ gridTemplateColumns: '110px 220px 1fr' }}>
              <span className="trace-pill">{finding.severity}</span>
              <span className="issue-ticket">{finding.code}</span>
              <span className="issue-summary">{finding.message}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
