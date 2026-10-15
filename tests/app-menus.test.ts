import { expect, it, vi } from 'vitest';
import { appMenu, menuShortcut } from '../app/main/menus.js';
it('menus expose the requested native accelerators and fixed actions', () => {
  const handlers = {command:vi.fn(),action:vi.fn(),theme:vi.fn(),themeSource:'system' as const};
  const menus = appMenu(handlers, 'darwin');
  expect(menus.map(item=>item.label)).toEqual(['AI Term','File','Edit','View','Window']);
  const items = menus.flatMap(menu=>Array.isArray(menu.submenu)?menu.submenu:[]);
  for (const [key, action] of Object.entries({k:'palette',f:'find',t:'new-agent',d:'split',e:'home','1':'select 1','9':'select 9',w:'close',q:'quit'})) expect(menuShortcut(key)).toBe(action);
  expect(menuShortcut('x')).toBeUndefined();
  expect(items.find(item=>item.label==='Command Palette')).toMatchObject({accelerator:'Command+K'});
  expect(items.find(item=>item.label==='Find…')).toMatchObject({accelerator:'Command+F'});
  expect(items.find(item=>item.label==='Settings…')).toMatchObject({accelerator:'Command+,'});
  expect(items.filter(item=>item.type==='radio').map(item=>[item.label,item.checked])).toEqual([['Use System Appearance',true],['Light',false],['Dark',false]]);
});
