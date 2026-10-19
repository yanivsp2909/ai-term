import type { FontStacks } from '../../src/shared/app-fonts.js';

// Ligatures show only with a font that has them; when the terminal's first family isn't installed, the next one in
// the chain draws the text and the switch changes nothing. The title strip then says so in one line (Yaniv asked
// during the v1.2.0 run) instead of leaving a silent switch.
export function firstFamily(stack: string): string {
  const quoted = stack.match(/^"([^"]+)"/)?.[1];
  return quoted ?? stack.split(',')[0]?.trim() ?? stack;
}
export function fontNote(fonts: FontStacks, installed: (family: string) => boolean): string | null {
  if (!fonts.ligatures) return null;
  const family = firstFamily(fonts.terminal);
  return installed(family) ? null : `${family} isn't installed, so ligatures can't show`;
}
// A family is installed when text drawn in it differs from every generic fallback alone (no font is ever loaded).
const SAMPLE = 'mmmmmmmmmmlli=>WW@#';
export function canvasInstalled(family: string): boolean {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return true;
  return ['monospace', 'serif', 'sans-serif'].some(base => {
    context.font = `72px ${base}`; const plain = context.measureText(SAMPLE).width;
    context.font = `72px "${family}", ${base}`;
    return context.measureText(SAMPLE).width !== plain;
  });
}
