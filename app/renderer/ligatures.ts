// v1.2.6 ligatures (/settings → app fonts): xterm draws each cell on its own, so a font's ligature can only form when
// the characters of a sequence are drawn as one unit. This joiner names the usual programming sequences; a font without
// ligatures draws the joined cells exactly as before. It is registered only while ligatures are on (off costs nothing),
// and it runs per drawn row, so it is one precompiled regex.
const SEQUENCES = ['<!--', '===', '!==', '=>>', '<<=', '>>=', '...', '::', '!=', '==', '=>', '->', '<-', '<=', '>=', '&&', '||', '//', '/*', '*/', '++', '..', '|>', '<|', '<>', '?.', '??', '<<', '>>', '</', '/>'];
const PATTERN = new RegExp([...SEQUENCES].sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|'), 'g');
export function ligatureRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const match of text.matchAll(PATTERN)) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}
