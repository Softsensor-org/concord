import { loadUrs } from '../../lib/urs';
import { loadTraceability } from '../../lib/traceability';
import Link from 'next/link';

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

function renderUrs(
  raw: string,
  headings: { line: number; slug: string; level: number }[]
) {
  const slugByLine = new Map<number, { slug: string; level: number }>();
  for (const h of headings) slugByLine.set(h.line, { slug: h.slug, level: h.level });

  const lines = raw.split('\n');
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let key = 0;

  const flush = () => {
    if (para.length === 0) return;
    blocks.push(
      <p key={`p${key++}`} className="urs-p">
        {para.join(' ')}
      </p>
    );
    para = [];
  };

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const h = slugByLine.get(lineNo);
    if (h) {
      flush();
      const text = line.replace(/^#{1,4}\s+/, '');
      const Tag = (`h${Math.min(h.level + 1, 6)}` as unknown) as keyof React.JSX.IntrinsicElements;
      blocks.push(
        <Tag key={`h${key++}`} id={h.slug} className={`urs-h urs-h--l${h.level}`}>
          {text}
        </Tag>
      );
      return;
    }
    if (line.trim() === '') {
      flush();
      return;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line) || line.startsWith('|')) {
      flush();
      blocks.push(
        <pre key={`c${key++}`} className="urs-pre">
          {line}
        </pre>
      );
      return;
    }
    para.push(line.trim());
  });
  flush();
  return blocks;
}

import React from 'react';
