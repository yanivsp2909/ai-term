import { textWidth } from '../../shared/unicode-width.js';

// B35: the homepage's bottom line (the next agent's defaults, then the key hints) used to clip its model and engine and
// give the folder whatever room was left, so at 120 columns it read "claude c ·  · own login" while the hints stayed.
// Now every field is shown whole or not at all. Fields claim the room in rank order (1 first); one is left out only when
// it wouldn't fit even with everything ranked below it gone, so a lower field never pushes out a higher one.
export interface LineField { readonly text: string; readonly rank: number; readonly warn?: boolean }
export interface FittedLine { readonly fields: readonly LineField[]; readonly hints: boolean }
export const SEPARATOR = ' · ';
// The hints sit at the right, at least this many columns after the last field.
const HINTS_GAP = 2;

export function fitBottomLine(fields: readonly LineField[], hints: { readonly width: number; readonly rank: number }, width: number): FittedLine {
  const candidates = fields.filter(field => field.text !== '');
  const cost = (kept: ReadonlySet<LineField>, withHints: boolean): number => {
    const shown = candidates.filter(field => kept.has(field));
    return shown.reduce((sum, field, i) => sum + textWidth(field.text) + (i ? SEPARATOR.length : 0), 0) + (withHints ? hints.width + HINTS_GAP : 0);
  };
  const order: readonly (LineField | 'hints')[] = [...candidates, 'hints' as const].sort((a, b) => (a === 'hints' ? hints.rank : a.rank) - (b === 'hints' ? hints.rank : b.rank));
  const fitted = order.reduce<{ kept: ReadonlySet<LineField>; hints: boolean }>((line, item) => {
    const next = item === 'hints' ? { kept: line.kept, hints: true } : { kept: new Set([...line.kept, item]), hints: line.hints };
    return cost(next.kept, next.hints) <= width ? next : line;
  }, { kept: new Set(), hints: false });
  return { fields: candidates.filter(field => fitted.kept.has(field)), hints: fitted.hints };
}
