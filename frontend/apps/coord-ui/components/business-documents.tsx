import { documentTextElement } from '../lib/business-documents';
import type { ReadDocument } from '../lib/business-documents';

function DocumentCard({ document }: { document: ReadDocument }) {
  const detail = {
    available: null,
    empty: 'This generated document is present but empty.',
    missing: 'This document has not been generated.',
    unreadable: 'This document could not be read.',
    'outside-root': 'This document path is outside the allowed workspace.'
  }[document.state];

  return (
    <article className="ac-card">
      <h3 className="ac-card__title">{document.name.replace(/\.md$/, '').replaceAll('_', ' ')}</h3>
      {document.state === 'available' && document.content !== null ? (
        documentTextElement(document.content)
      ) : (
        <div className="ac-stat ac-muted">{detail}</div>
      )}
      <div className="ac-stat ac-muted" style={{ marginTop: 'auto' }}>
        {document.name} · {document.state === 'available' ? 'derived / advisory' : document.state}
      </div>
    </article>
  );
}

export function BusinessDocuments({ documents }: { documents: ReadDocument[] }) {
  return (
    <section className="action-center" aria-label="Business summary">
      <article className="ac-card ac-card--wide">
        <h2 className="ac-card__title">Business summary</h2>
        <div className="ac-stat ac-muted">Synthesized discovery documents are derived and advisory.</div>
      </article>
      {documents.map((document) => <DocumentCard key={document.name} document={document} />)}
    </section>
  );
}

export function DomainModelDocument({ document }: { document: ReadDocument }) {
  return (
    <section className="action-center" aria-label="Domain model">
      <article className="ac-card ac-card--wide">
        <h2 className="ac-card__title">Canonical domain model</h2>
        <div className="ac-stat ac-muted">coord/product/DOMAIN_MODEL.md · canonical product document</div>
        {document.state === 'available' && document.content !== null ? (
          documentTextElement(document.content)
        ) : (
          <div className="ac-ok">
            {document.state === 'empty'
              ? 'The domain model file is present but empty.'
              : document.state === 'missing'
                ? 'The domain model document is not available in this workspace.'
                : 'The domain model document could not be read from the workspace.'}
          </div>
        )}
      </article>
    </section>
  );
}
