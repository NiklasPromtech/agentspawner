/**
 * MarkdownContent — lightweight markdown renderer for agent chat messages.
 *
 * Handles the subset of markdown that Claude commonly emits:
 *   - ATX headers: # / ## / ###
 *   - Bold: **text** or __text__
 *   - Italic: *text* or _text_
 *   - Inline code: `code`
 *   - Fenced code blocks: ```lang\n...\n```
 *   - GFM pipe tables: | col | col |
 *   - Unordered lists: - item / * item / + item
 *   - Ordered lists: 1. item
 *   - Horizontal rule: --- / ***
 *   - Blank lines → paragraph breaks
 */

import React, { useState } from 'react';

// ── Inline renderer ──────────────────────────────────────────────────────────

type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'bold'; children: InlineNode[] }
  | { type: 'italic'; children: InlineNode[] }
  | { type: 'code'; value: string };

function parseInline(src: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = 0;

  while (i < src.length) {
    // Inline code: `...`
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      if (end !== -1) {
        nodes.push({ type: 'code', value: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Bold: **...** or __...__
    if (
      (src[i] === '*' && src[i + 1] === '*') ||
      (src[i] === '_' && src[i + 1] === '_')
    ) {
      const delim = src.slice(i, i + 2);
      const end = src.indexOf(delim, i + 2);
      if (end !== -1) {
        nodes.push({ type: 'bold', children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // Italic: *...* or _..._  (only single char, not already consumed as bold)
    if (src[i] === '*' || src[i] === '_') {
      const delim = src[i];
      // Avoid consuming list bullets (* at start of text-block is handled by block parser)
      const end = src.indexOf(delim, i + 1);
      if (end !== -1 && end > i + 1) {
        nodes.push({ type: 'italic', children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    // Plain text — consume until next potential token
    let j = i + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === '`' || c === '*' || c === '_') break;
      j++;
    }
    nodes.push({ type: 'text', value: src.slice(i, j) });
    i = j;
  }

  return nodes;
}

function renderInline(nodes: InlineNode[], key?: string | number): React.ReactNode {
  return nodes.map((node, i) => {
    const k = key !== undefined ? `${key}-${i}` : String(i);
    if (node.type === 'text') return node.value;
    if (node.type === 'code') return <code key={k} style={codeStyle}>{node.value}</code>;
    if (node.type === 'bold') return <strong key={k}>{renderInline(node.children)}</strong>;
    if (node.type === 'italic') return <em key={k}>{renderInline(node.children)}</em>;
    return null;
  });
}

// ── CodeBlock ─────────────────────────────────────────────────────────────────

interface SyntaxError_ { message: string; line: number }

function checkJsSyntax(code: string): SyntaxError_ | null {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
    return null;
  } catch (e) {
    if (e instanceof SyntaxError) {
      // V8 stack: "...at new Function (<anonymous>:N:M)..."
      // new Function adds 2 header lines: "function anonymous(" and ") {"
      // so rawLine - 2 = user code line
      const match = (e as Error).stack?.match(/<anonymous>:(\d+):\d+/);
      const rawLine = match ? parseInt(match[1], 10) : 0;
      const line = rawLine > 2 ? rawLine - 2 : 1;
      return { message: e.message, line };
    }
    return null;
  }
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);

  const isJs = lang === 'javascript' || lang === 'js';
  const syntaxErr = isJs ? checkJsSyntax(code) : null;

  const lines = code.split('\n');
  const gutterWidth = String(lines.length).length * 0.55 + 1.2 + 'rem';

  const handleCopy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ ...preStyle, padding: 0, overflow: 'hidden' }}>
      {/* ── Error banner ── */}
      {syntaxErr && (
        <div style={{
          background: 'rgba(248,81,73,0.1)',
          borderBottom: '1px solid rgba(248,81,73,0.3)',
          padding: '0.25rem 0.75rem',
          fontSize: '0.72rem',
          color: '#f85149',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
        }}>
          ⚠ line {syntaxErr.line}: {syntaxErr.message}
        </div>
      )}

      {/* ── Top-right toolbar ── */}
      <div style={{ position: 'absolute', top: syntaxErr ? 28 : 4, right: 8, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        {lang && <span style={{ fontSize: '0.65rem', color: '#8b949e' }}>{lang}</span>}
        <button
          onClick={handleCopy}
          style={{ background: 'none', border: '1px solid #30363d', borderRadius: 4, color: copied ? '#3fb950' : '#8b949e', cursor: 'pointer', fontSize: '0.65rem', padding: '0.1rem 0.4rem', lineHeight: 1.4, transition: 'color 0.15s' }}
        >
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>

      {/* ── Line-numbered code ── */}
      <div style={{ overflowX: 'auto', paddingTop: '0.5rem', paddingBottom: '0.5rem' }}>
        {lines.map((line, i) => {
          const lineNum = i + 1;
          const isErrLine = syntaxErr?.line === lineNum;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                background: isErrLine ? 'rgba(248,81,73,0.12)' : 'transparent',
                minHeight: '1.35em',
              }}
            >
              <span style={{
                userSelect: 'none',
                minWidth: gutterWidth,
                paddingRight: '0.75rem',
                paddingLeft: '0.75rem',
                textAlign: 'right',
                color: isErrLine ? '#f85149' : '#484f58',
                flexShrink: 0,
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                fontSize: '0.82rem',
                lineHeight: '1.35em',
                borderRight: isErrLine ? '2px solid rgba(248,81,73,0.6)' : '1px solid #21262d',
              }}>
                {lineNum}
              </span>
              <span style={{
                paddingLeft: '0.75rem',
                paddingRight: '3rem', // room for toolbar
                whiteSpace: 'pre',
                color: '#e6edf3',
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                fontSize: '0.82rem',
                lineHeight: '1.35em',
              }}>
                {line}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Block parser ─────────────────────────────────────────────────────────────

interface Props {
  children: string;
  /** Override the base text colour (defaults to inherit) */
  color?: string;
}

export default function MarkdownContent({ children, color }: Props) {
  const lines = children.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code block
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing ```
      blocks.push(<CodeBlock key={i} code={codeLines.join('\n')} lang={lang} />);
      continue;
    }

    // ── ATX heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const text = headingMatch[2];
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      blocks.push(
        <Tag key={i} style={headingStyles[level]}>
          {renderInline(parseInline(text), i)}
        </Tag>,
      );
      i++;
      continue;
    }

    // ── Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push(<hr key={i} style={{ border: 'none', borderTop: '1px solid #30363d', margin: '0.75rem 0' }} />);
      i++;
      continue;
    }

    // ── GFM table: line starts with |
    if (line.trimStart().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const headerCells = parseCells(tableLines[0]);
        // tableLines[1] is the separator row (---|---)
        const bodyRows = tableLines.slice(2).map(parseCells);
        blocks.push(
          <div key={i} style={{ overflowX: 'auto', margin: '0.5rem 0' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  {headerCells.map((cell, ci) => (
                    <th key={ci} style={thStyle}>{renderInline(parseInline(cell))}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bodyRows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci} style={tdStyle}>{renderInline(parseInline(cell))}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
      }
      continue;
    }

    // ── Unordered list: lines starting with - / * / +
    if (/^(\s*)([-*+])\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^(\s*)([-*+])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={i} style={ulStyle}>
          {items.map((item, li) => (
            <li key={li} style={liStyle}>{renderInline(parseInline(item), li)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // ── Ordered list: lines starting with digit.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={i} style={olStyle}>
          {items.map((item, li) => (
            <li key={li} style={liStyle}>{renderInline(parseInline(item), li)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // ── Blank line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // ── Paragraph — gather consecutive non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trimStart().startsWith('```') &&
      !lines[i].trimStart().startsWith('|') &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^(\s*)([-*+])\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^(\*{3,}|-{3,}|_{3,})\s*$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push(
        <p key={i} style={{ margin: '0.35rem 0', lineHeight: 1.6 }}>
          {renderInline(parseInline(paraLines.join('\n')), i)}
        </p>,
      );
    }
  }

  return (
    <div style={{ color: color ?? 'inherit', fontSize: 'inherit', lineHeight: 1.6 }}>
      {blocks}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseCells(row: string): string[] {
  return row
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

// ── Styles ───────────────────────────────────────────────────────────────────

const codeStyle: React.CSSProperties = {
  background: 'rgba(110,118,129,0.15)',
  borderRadius: 4,
  padding: '0.1em 0.35em',
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: '0.85em',
  color: '#e6edf3',
};

const preStyle: React.CSSProperties = {
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: '0.75rem 1rem',
  overflowX: 'auto',
  margin: '0.5rem 0',
  position: 'relative',
  whiteSpace: 'pre',
};

const headingStyles: Record<number, React.CSSProperties> = {
  1: { fontSize: '1.15rem', fontWeight: 700, margin: '0.75rem 0 0.35rem', borderBottom: '1px solid #30363d', paddingBottom: '0.3rem' },
  2: { fontSize: '1.05rem', fontWeight: 700, margin: '0.65rem 0 0.3rem' },
  3: { fontSize: '0.95rem', fontWeight: 700, margin: '0.55rem 0 0.25rem' },
  4: { fontSize: '0.9rem',  fontWeight: 700, margin: '0.45rem 0 0.2rem' },
  5: { fontSize: '0.85rem', fontWeight: 700, margin: '0.4rem 0 0.2rem' },
  6: { fontSize: '0.85rem', fontWeight: 700, margin: '0.35rem 0 0.15rem', color: '#8b949e' },
};

const tableStyle: React.CSSProperties = {
  borderCollapse: 'collapse',
  width: '100%',
  fontSize: '0.85rem',
};

const thStyle: React.CSSProperties = {
  border: '1px solid #30363d',
  padding: '0.4rem 0.75rem',
  background: 'rgba(255,255,255,0.06)',
  fontWeight: 600,
  textAlign: 'left',
};

const tdStyle: React.CSSProperties = {
  border: '1px solid #30363d',
  padding: '0.35rem 0.75rem',
};

const ulStyle: React.CSSProperties = {
  margin: '0.35rem 0',
  paddingLeft: '1.4rem',
  listStyleType: 'disc',
};

const olStyle: React.CSSProperties = {
  margin: '0.35rem 0',
  paddingLeft: '1.4rem',
};

const liStyle: React.CSSProperties = {
  margin: '0.2rem 0',
  lineHeight: 1.55,
};
