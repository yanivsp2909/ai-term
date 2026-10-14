import { createElement as h, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { monoFont, sansFont, terminalFontSize, tokenColors } from '../../src/shared/theme-tokens.js';
import { pasteErrors, type AppTheme, type MenuAction } from '../shared/api.js';
import { fitToWindow } from './resize.js';
import '@xterm/xterm/css/xterm.css';
import './style.css';

function App(): unknown {
  const host = useRef<HTMLDivElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const term = useRef<Terminal | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [closeNote, setCloseNote] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    const api = window.terminal;
    const terminal = new Terminal({ fontFamily: monoFont, fontSize: terminalFontSize, lineHeight: 16 / 13, cursorBlink: false, macOptionIsMeta: true, scrollback: 10000, allowProposedApi: true, screenReaderMode: true });
    term.current = terminal;
    const fit = new FitAddon(), finder = new SearchAddon(); search.current = finder;
    terminal.loadAddon(fit); terminal.loadAddon(finder);
    terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
    const report = (message: string): void => { setError(`✗ ${message} · Esc closes`); };
    terminal.loadAddon(new WebLinksAddon((_event, url) => { void api.openUrl(url).catch(() => { report('Could not open http/https link'); }); }));
    terminal.open(host.current);
    let webgl: WebglAddon | undefined;
    const fallback = (): void => {
      webgl?.dispose(); webgl = undefined;
      console.warn('AI Term: WebGL unavailable; using the DOM renderer');
    };
    try { webgl = new WebglAddon(); webgl.onContextLoss(fallback); terminal.loadAddon(webgl); } catch { fallback(); }
    const theme = (mode: AppTheme): void => {
      const colors = tokenColors(mode);
      for (const [name, color] of Object.entries(colors)) document.documentElement.style.setProperty(`--${name}`, color);
      document.documentElement.style.setProperty('--sans', sansFont);
      terminal.options.theme = { background: colors.bg, foreground: colors.ink, cursor: colors.cursor, cursorAccent: colors.bg, selectionBackground: `${colors.accent}61` };
    };
    theme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    // Input/output go straight between xterm and preload; React only owns search/errors.
    const input = terminal.onData(data => { api.write(data); });
    const stopOutput = api.onOutput(data => { terminal.write(data); });
    const stopTheme = api.onTheme(mode => { theme(mode); api.themeApplied(mode); });
    const resize = (): void => {
      fitToWindow(fit, terminal, size => { api.resize(size); });
    };
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    const action = (item: MenuAction): void => {
      if (item === 'close-note') { setCloseNote(true); return; }
      const field = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
      if (item === 'copy') {
        const selection = field ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0) : terminal.getSelection();
        if (selection) void api.copy(selection).catch(() => { report('Could not copy terminal selection'); });
      } else if (item === 'paste') {
        void api.paste().then(text => {
          if (field) { field.setRangeText(text, field.selectionStart ?? 0, field.selectionEnd ?? 0, 'end'); field.dispatchEvent(new Event('input', {bubbles:true})); finder.findNext(field.value, {incremental:true}); }
          else terminal.paste(text);
        }).catch((error: unknown) => {
          report(Object.values(pasteErrors).find(reason => error instanceof Error && error.message.includes(reason)) ?? pasteErrors.unavailable);
        });
      } else if (item === 'select-all') { if (field) field.select(); else terminal.selectAll(); }
      else if (item === 'find') setSearching(true);
      else { terminal.options.fontSize = item === 'font-reset' ? terminalFontSize : Math.max(8, Math.min(32, (terminal.options.fontSize ?? terminalFontSize) + (item === 'font-decrease' ? -1 : 1))); resize(); }
    };
    const stopMenu = api.onMenuAction(action);
    resize(); terminal.focus();
    return () => { observer.disconnect(); stopOutput(); stopTheme(); stopMenu(); input.dispose(); terminal.dispose(); term.current = null; search.current = null; };
  }, []);
  useEffect(() => { if (searching) searchInput.current?.focus(); }, [searching]);
  return h('div', null,
    h('div', {className:'chrome'}, closeNote ? 'Closing the window keeps your agents running.' : 'AI Term'),
    h('div', { className: 'terminal', ref: host, 'aria-label': 'AI Term terminal' }),
    searching ? h('div', { className: 'search', role: 'search' },
      h('input', { ref: searchInput, 'aria-label': 'Search scrollback', placeholder: 'Search scrollback',
        onChange: (event: { currentTarget: HTMLInputElement }) => { search.current?.findNext(event.currentTarget.value, { incremental: true }); },
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key === 'Escape') { setSearching(false); term.current?.focus(); }
          if (event.key === 'Enter' && searchInput.current) {
            event.preventDefault(); const query = searchInput.current.value;
            if (event.shiftKey) search.current?.findPrevious(query); else search.current?.findNext(query);
          }
        } }), h('span', null, '⏎ next · ⇧⏎ previous · Esc closes')) : null,
    error ? h('div', { className: 'error', role: 'alert', tabIndex: 0, ref: (element: HTMLElement | null) => { element?.focus(); }, onKeyDown: (event: KeyboardEvent) => { if (event.key === 'Escape') { setError(''); term.current?.focus(); } } }, error) : null,
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing app root');
createRoot(root).render(h(App));
