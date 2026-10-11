import { dark, light } from './theme.js';

const graphite = {bg:'#1E1F22',surface:'#26282C','surface-2':'#313338',line:'#4A4D55',ink:'#E8E9EC','ink-2':'#B0B5BE','ink-3':'#9CA2AD',accent:'#5AD8CC','status-waiting':'#F5BC55','status-error':'#F47B7E'};
const slate = {bg:'#1B2029',surface:'#232935','surface-2':'#2D3443',line:'#46506A',ink:'#E6EAF0','ink-2':'#AEB6C4','ink-3':'#9AA4B5',accent:'#58D6C9','status-waiting':'#F5BC55','status-error':'#F47B7E'};
const channels = hex => hex.slice(1).match(/../g).map(part => Number.parseInt(part,16));
export function mix(color, target, amount) {
  const end = channels(target);
  return '#'+channels(color).map((start,i)=>Math.round(start+(end[i]-start)*amount).toString(16).padStart(2,'0')).join('');
}
export function luminance(color) {
  const linear = channels(color).map(channel=>{const value=channel/255;return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;});
  return linear[0]*0.2126+linear[1]*0.7152+linear[2]*0.0722;
}
export function contrast(a,b) {
  const first=luminance(a),second=luminance(b);
  return (Math.max(first,second)+0.05)/(Math.min(first,second)+0.05);
}
function aliases(colors) {
  return {...colors,'status-running':colors.accent,'status-done':colors['ink-2'],'status-idle':colors['ink-3'],cursor:colors.ink};
}
export function createPalette(name, background=null) {
  if(!['ink','graphite','slate','auto'].includes(name))throw new Error('Unknown palette');
  let colors = {...dark,...(name==='graphite'?graphite:name==='ink'?{}:slate)};
  let reason = name==='auto'?'no reply within 200 ms; slate fallback':'fixed palette';
  if(name==='auto'&&background){
    const isLight=luminance(background)>0.5,target=isLight?'#000000':'#ffffff';
    reason=isLight?'detected light background':'detected dark background';
    if(isLight)colors={...light};
    colors.bg=background;
    colors.surface=mix(background,target,0.05);
    colors['surface-2']=mix(background,target,0.11);
    colors.line=mix(background,target,0.24);
    if(!isLight&&contrast(colors['ink-3'],colors['surface-2'])<4.5){
      const original=colors['ink-3'];
      for(let percent=1;percent<=100;percent++){
        colors['ink-3']=mix(original,'#ffffff',percent/100);
        if(contrast(colors['ink-3'],colors['surface-2'])>=4.5)break;
      }
    }
    if(!isLight&&contrast(colors['ink-3'],colors['surface-2'])<4.5)reason+='; ink-3 reached white but 4.5:1 is impossible on this surface-2';
  }
  return {name,colors:aliases(colors),defaultBackground:name==='auto',background,reason};
}
