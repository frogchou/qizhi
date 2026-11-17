import { createElement, Fragment, type ReactNode } from 'react';

/** Render the supported Markdown blocks as React nodes; raw HTML remains text. */
export function DeliveryBody({ body, format }: { body: string; format: 'markdown' | 'text' }) {
  return <div className={format === 'text' ? 'delivery-text' : 'delivery-markdown'}>{format === 'text' ? body : blocks(body)}</div>;
}

function blocks(body: string): ReactNode[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const result: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const key = index;
    if (!line.trim()) { index++; continue; }
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const content: string[] = [];
      index++;
      while (index < lines.length && !new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index++;
      result.push(<pre key={key}><code>{content.join('\n')}</code></pre>);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) {
      result.push(createElement(`h${Math.min(heading[1].length + 2, 6)}`, { key }, inline(heading[2])));
      index++; continue;
    }
    if (isRule(line)) { result.push(<hr key={key} />); index++; continue; }
    if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      const headers = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(cells(lines[index++]));
      result.push(<div className="delivery-table" key={key}><table><thead><tr>{headers.map((cell, column) => <th key={column}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) quote.push(lines[index++].replace(/^\s{0,3}> ?/, ''));
      result.push(<blockquote key={key}>{blocks(quote.join('\n'))}</blockquote>);
      continue;
    }
    const list = listItem(line);
    if (list) {
      const ordered = /^\d/.test(list[1]);
      const items: ReactNode[] = [];
      const start = ordered ? Number.parseInt(list[1], 10) : undefined;
      while (index < lines.length) {
        const item = listItem(lines[index]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const content = [item[2]];
        index++;
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !listItem(lines[index])) content.push(lines[index++].trimStart());
        items.push(<li key={items.length}>{inline(content.join('\n'))}</li>);
      }
      result.push(ordered ? <ol key={key} start={start}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index]) && !(lines[index].includes('|') && isTableSeparator(lines[index + 1] ?? ''))) paragraph.push(lines[index++]);
    result.push(<p key={key}>{inline(paragraph.join('\n'))}</p>);
  }
  return result;
}

function inline(value: string, depth = 0): ReactNode[] {
  if (depth > 4) return [value];
  const pattern = /(!?)\[([^\]]+)\]\(([^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  const result: ReactNode[] = [];
  let previous = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > previous) result.push(value.slice(previous, match.index));
    const key = match.index;
    if (match[2] !== undefined) {
      const label = inline(match[2], depth + 1);
      // Images are linked by their alt text, so delivery never loads remote media.
      result.push(safeLink(match[3]) ? <a key={key} href={match[3]} target="_blank" rel="noopener noreferrer">{label}</a> : <Fragment key={key}>{label}</Fragment>);
    } else if (match[4] !== undefined) result.push(<code key={key}>{match[4]}</code>);
    else if (match[5] !== undefined || match[6] !== undefined) result.push(<strong key={key}>{inline(match[5] ?? match[6], depth + 1)}</strong>);
    else result.push(<em key={key}>{inline(match[7] ?? match[8], depth + 1)}</em>);
    previous = match.index + match[0].length;
  }
  if (previous < value.length) result.push(value.slice(previous));
  return result;
}
function safeLink(value: string): boolean { return !/[\u0000-\u0020\u007f]/.test(value) && /^(https?:\/\/|mailto:|#)/i.test(value); }
function listItem(line: string): RegExpMatchArray | null { return line.match(/^\s*([-+*]|\d+[.)])\s+(.*)$/); }
function isRule(line: string): boolean { return /^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/.test(line); }
function isTableSeparator(line: string): boolean { return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line); }
function cells(line: string): string[] { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|')); }
function startsBlock(line: string): boolean { return /^\s{0,3}(?:#{1,6}\s|`{3,}|~{3,}|>)/.test(line) || !!listItem(line) || isRule(line); }
