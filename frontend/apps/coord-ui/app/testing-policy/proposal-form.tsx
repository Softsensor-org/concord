'use client';

import { useState, type FormEvent } from 'react';

type Proposal = {
  proposal_id: string;
  target: string;
  base_digest: string;
  diff: unknown;
};

export default function ProposalForm() {
  const [text, setText] = useState(`{
  "stageMap": {}
}`);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [refusal, setRefusal] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProposal(null);
    setRefusal('');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      setRefusal(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    setPending(true);
    try {
      const response = await fetch('/api/config/proposals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'project.testPolicy', value }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(String(result.refusal || 'config proposal refused'));
      setProposal(result as Proposal);
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="proposal-heading">
      <h3 className="section-h" id="proposal-heading">Propose testing-policy settings</h3>
      <p>Creates an inert journaled proposal. It does not apply the setting. A configured governance identity is required to submit; approval requires signed human-admin authority and is unavailable until the trusted verifier is integrated.</p>
      <form onSubmit={submit}>
        <label htmlFor="test-policy-proposal">Adopter testPolicy JSON (stageMap, stages, repoMaps, execution)</label>
        <textarea id="test-policy-proposal" rows={10} value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />
        <button type="submit" disabled={pending}>{pending ? 'Submitting…' : 'Create proposal'}</button>
      </form>
      {refusal && <div className="banner" role="alert">{refusal}</div>}
      {proposal && (
        <div className="card" role="status">
          <h4>Proposal recorded: <code>{proposal.proposal_id}</code></h4>
          <p>Target: <code>{proposal.target}</code></p>
          <p>Base digest: <code>{proposal.base_digest}</code></p>
          <pre>{JSON.stringify(proposal.diff, null, 2)}</pre>
          <p>No configuration file was changed.</p>
        </div>
      )}
    </section>
  );
}
