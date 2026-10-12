// Throwaway spike code (v0.2.1b). Not product code.
// @xterm/headless ships only Unicode 6 widths, where most emoji are 1 cell wide. Claude Code and
// Codex measure with modern tables (2 cells), so a Unicode 6 mirror misplaces every cell after an
// emoji. This provider is a small "modern enough" approximation, registered through xterm's
// unicode.register API, so the spike needs no new dependency.
import type { IUnicodeVersionProvider } from '@xterm/headless';

const WIDE = /[ᄀ-ᅟ〈〉⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u;
const ZERO = /[\p{Mn}\p{Me}​-‏︀-️\u{e0020}-\u{e007f}]|\p{Emoji_Modifier}/u;
const ZWJ = 0x200d, VS16 = 0xfe0f;
const REGIONAL = (cp: number): boolean => cp >= 0x1f1e6 && cp <= 0x1f1ff;

// Packed value layout copied from xterm's UnicodeService: state << 3 | width << 1 | shouldJoin.
const pack = (state: number, width: number, join: boolean): number => ((state & 0xffffff) << 3) | ((width & 3) << 1) | (join ? 1 : 0);
const widthOf = (value: number): number => (value >> 1) & 3;
const stateOf = (value: number): number => value >> 3;
const AFTER_ZWJ = 1, AFTER_REGIONAL = 2;

export const modernUnicode: IUnicodeVersionProvider = {
  version: 'spike-modern',
  wcwidth(cp: number): 0 | 1 | 2 {
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
    if (cp < 0x300) return 1;
    const char = String.fromCodePoint(cp);
    if (cp === ZWJ || ZERO.test(char)) return 0;
    return WIDE.test(char) || REGIONAL(cp) ? 2 : 1;
  },
  charProperties(cp: number, preceding: number): number {
    let width = this.wcwidth(cp);
    const before = widthOf(preceding), state = stateOf(preceding);
    // Joining rules, enough for ZWJ families, skin tones, VS16 emoji and flag pairs.
    if (preceding !== 0 && before !== 0) {
      if (cp === ZWJ) return pack(AFTER_ZWJ, before, true);
      if (state === AFTER_ZWJ) return pack(0, Math.max(before, width), true);
      if (cp === VS16) return pack(0, 2, true);
      if (width === 0) return pack(0, before, true);
      if (REGIONAL(cp) && state === AFTER_REGIONAL) return pack(0, 2, true);
    }
    return pack(REGIONAL(cp) ? AFTER_REGIONAL : 0, width, false);
  },
};
