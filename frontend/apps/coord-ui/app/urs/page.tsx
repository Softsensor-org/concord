import { loadUrs } from '../../lib/urs';
import { loadTraceability } from '../../lib/traceability';
import { parseUrsMarkdown } from '../../lib/urs-markdown';
import type { UrsBlock, UrsInline } from '../../lib/urs-markdown';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default function UrsPage() {
  const urs = loadUrs();
  const trace = loadTraceability();

  if (!urs.found) {
    return (
      <div className="banner">
        Requirements document not found. Expected {urs.sourcePath ?? 'coord/product/REQUIREMENTS.md'}.
      </div>
    );
  }

  const tocHeadings = urs.headings.filter((h) => h.level <= 2);

  return (
    <>
      <div className="board-meta">
        <span>
          <strong>{urs.title ?? 'URS'}</strong>
        </span>
        <span>{urs.headings.length} sections</span>
        <span>
          traceability:{' '}
          <Link href="/traceability" className="event__cmd">
            {trace.withRealClosure}/{trace.total} closed · {trace.verified} verified ·{' '}
            {trace.closingGap} closing-gap
          </Link>
        </span>
      </div>

      <div className="urs-grid">
        <nav className="urs-toc">
          <h3>Contents</h3>
          {tocHeadings.map((h) => (
            <a
              key={h.slug}
              href={`#${h.slug}`}
              className={`urs-toc__item urs-toc__item--l${h.level}`}
            >
              {h.text}
            </a>
          ))}
        </nav>

        <article className="urs-doc">
          {renderUrs(urs.raw ?? '', urs.headings)}
        </article>
      </div>
    </>
  );
}

// Document text only ever reaches the page as React children, so it is escaped;
// nothing here builds markup from strings.
function renderUrs(
  raw: string,
  headings: { line: number; slug: string; level: number }[]
) {
  const slugByLine = new Map<number, string>();
  for (const h of headings) slugByLine.set(h.line, h.slug);
  return parseUrsMarkdown(raw).map((block, i) => renderBlock(block, `b${i}`, slugByLine));
}

function renderInline(inline: UrsInline[]): React.ReactNode[] {
  return inline.map((token, i) => {
    switch (token.type) {
      case 'code':
        return (
          <code key={i} className="urs-code">
            {token.text}
          </code>
        );
      case 'strong':
        return <strong key={i}>{renderInline(token.children)}</strong>;
      case 'em':
        return <em key={i}>{renderInline(token.children)}</em>;
      default:
        return <React.Fragment key={i}>{token.text}</React.Fragment>;
    }
  });
}

function renderBlock(
  block: UrsBlock,
  key: string,
  slugByLine: Map<number, string>
): React.ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = (`h${Math.min(block.level + 1, 6)}` as unknown) as keyof React.JSX.IntrinsicElements;
      return (
        <Tag key={key} id={slugByLine.get(block.line)} className={`urs-h urs-h--l${block.level}`}>
          {renderInline(block.inline)}
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p key={key} className="urs-p">
          {renderInline(block.inline)}
        </p>
      );
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i}>
          {renderInline(item.inline)}
          {item.children.map((child, j) => renderBlock(child, `${key}-${i}-${j}`, slugByLine))}
        </li>
      ));
      return block.ordered ? (
        <ol key={key} className="urs-list" start={block.start ?? undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key} className="urs-list">
          {items}
        </ul>
      );
    }
    case 'table':
      return (
        <div key={key} className="urs-table-wrap">
          <table className="urs-table">
            <thead>
              <tr>
                {block.header.map((cell, c) => (
                  <th key={c} scope="col" style={{ textAlign: block.align[c] ?? undefined }}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ textAlign: block.align[c] ?? undefined }}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr key={key} className="urs-hr" />;
    case 'code':
      return (
        <pre key={key} className="urs-pre">
          {block.text}
        </pre>
      );
  }
}

import React from 'react';
