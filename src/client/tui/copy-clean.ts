// Work only on parsed mirror text. These rules describe decoration, never a provider's reply format.
export function cleanSessionText(text: string): string {
  const lines: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() && /^[\s\u2500-\u257f\u2800-\u28ff◐◓◑◒◴◵◶◷◰◱◲◳◜◝◞◟\-_=–—]+$/u.test(line)) continue;
    // Remove one border-padding space; further indentation belongs to the content (e.g. code).
    let content = line.replace(/^[ \t]*[\u2500-\u257f]+ ?/u, '').trimEnd();
    let end = content.length;
    while (end && (content.charCodeAt(end - 1) >= 0x2500 && content.charCodeAt(end - 1) <= 0x257f)) end--;
    if (end < content.length) { if (content[end - 1] === ' ') end--; content = content.slice(0, end).trimEnd(); }
    if (!content.trim()) { if (lines.length && lines.at(-1) !== '') lines.push(''); }
    else lines.push(content);
  }
  if (lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}
