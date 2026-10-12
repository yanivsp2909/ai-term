import type { TerminalModes } from '../shared/protocol.js';
const csi='\x1b[';
// An attached CLI owns terminal appearance too; restore the terminal's defaults on every exit.
export const RESET_MODES=[9,1000,1002,1003,1005,1006,1007,1015,2004,1004,1,66,6,45,2026].map(code=>`${csi}?${code}l`).join('')+`${csi}?7h${csi}4l${csi}>4;0m${csi}=0u${csi}<u\x1b>${csi}?25h${csi}0m${csi}r${csi}0 q`+[0,104,110,111,112].map(code=>`\x1b]${code}${code===0?';':''}\x1b\\`).join('');
export function enterModes(m:TerminalModes):string {
  const set=(code:number,on:boolean)=>`${csi}?${code}${on?'h':'l'}`;
  const mouse={none:0,x10:9,vt200:1000,drag:1002,any:1003}[m.mouseTracking];
  const encoding={default:0,utf8:1005,sgr:1006,urxvt:1015}[m.mouseEncoding];
  // Resetting any tracking mode clears the active one in xterm; enable last.
  const tracking=[9,1000,1002,1003].map(code=>set(code,false)).join('')+(mouse?set(mouse,true):'');
  const mouseEncoding=[1005,1006,1015].map(code=>set(code,false)).join('')+(encoding?set(encoding,true):'');
  return set(1,m.applicationCursorKeys)+(m.applicationKeypad?'\x1b=':'\x1b>')+set(2004,m.bracketedPaste)+tracking+mouseEncoding+set(1004,m.focusEvents)+set(25,m.cursorVisible);
}
