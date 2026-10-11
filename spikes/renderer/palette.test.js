import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundReplies, parseBackground } from './osc11.js';
import { mix, luminance, contrast, createPalette } from './palettes.js';
import { usePalette, styleEscape, dark, light } from './theme.js';
import { diffFrame } from './grid.js';

test('OSC 11 accepts 16-bit and 8-bit channels and both terminators',()=>{
  assert.equal(parseBackground('\x1b]11;rgb:1b1b/2020/2929\x1b\\'),'#1b2029');
  assert.equal(parseBackground('\x1b]11;rgb:FF/80/00\x07'),'#ff8000');
  assert.equal(parseBackground('\x1b]11;rgb:ffff/8000/0000\x1b\\'),'#ff8000');
  for(const reply of ['rgb:ff/80/00','\x1b]11;rgb:fff/80/00\x07','\x1b]10;rgb:ff/80/00\x07','\x1b]11;rgb:xx/80/00\x07'])assert.equal(parseBackground(reply),null);
});
test('split OSC replies never reach command input and ordinary bytes remain intact',()=>{
  const reply=Buffer.from('\x1b]11;rgb:1b1b/2020/2929\x1b\\');
  for(let split=0;split<=reply.length;split++){
    const detected=[],filter=new BackgroundReplies(color=>detected.push(color));
    const output=Buffer.concat([filter.push(Buffer.from('before')),filter.push(reply.subarray(0,split)),filter.push(reply.subarray(split)),filter.push(Buffer.from('after'))]);
    assert.equal(output.toString(),'beforeafter');assert.deepEqual(detected,['#1b2029']);
  }
  const found=[],filter=new BackgroundReplies(color=>found.push(color));
  assert.equal(Buffer.concat([...reply].map(byte=>filter.push(Buffer.from([byte])))).length,0);assert.equal(found.length,1);
  assert.equal(Buffer.concat([filter.push(Buffer.from('\x1b')),filter.push(Buffer.from('[A\x03'))]).toString(),'\x1b[A\x03');
  assert.equal(filter.push(Buffer.from('\x1b]11;rgb:bad\x07typed')).toString(),'typed');
});
test('unrelated Alt+] and malformed or oversized OSC candidates recover typing',()=>{
  const filter=new BackgroundReplies(()=>{});
  assert.equal(filter.push(Buffer.from('\x1b]')).length,0);
  assert.equal(filter.push(Buffer.from('hello\rworld')).toString(),'\x1b]hello\rworld');
  const unicode=Buffer.from('\x1b]中');
  for(let split=0;split<=unicode.length;split++){
    const decoder=new BackgroundReplies(()=>{});
    assert.deepEqual(Buffer.concat([decoder.push(unicode.subarray(0,split)),decoder.push(unicode.subarray(split))]),unicode);
  }
  filter.push(Buffer.from('\x1b]11;rgb:ab!'));
  assert.equal(filter.push(Buffer.from('typing')).toString(),'typing');
  filter.push(Buffer.from('\x1b]11;'+ 'a'.repeat(100)));
  assert.equal(filter.osc,false);assert.equal(filter.push(Buffer.from('still typing')).toString(),'still typing');
});
test('mixing, luminance, fixed colors and aliases match the requested palette',()=>{
  assert.equal(mix('#000000','#ffffff',0.05),'#0d0d0d');
  assert.equal(mix('#ffffff','#000000',0.11),'#e3e3e3');
  assert.equal(luminance('#000000'),0);assert.equal(luminance('#ffffff'),1);assert.equal(contrast('#000000','#ffffff'),21);
  assert.equal(createPalette('ink').colors.bg,dark.bg);assert.equal(createPalette('graphite').colors.bg,'#1E1F22');
  const slate=createPalette('slate');assert.equal(slate.colors['status-done'],slate.colors['ink-2']);assert.equal(slate.defaultBackground,false);
  assert.throws(()=>createPalette('invalid'));
});
test('auto derives dark/light panels, improves tertiary contrast and has a slate timeout fallback',()=>{
  const darkAuto=createPalette('auto','#333333');assert.equal(darkAuto.colors.surface,mix('#333333','#ffffff',0.05));assert.equal(darkAuto.colors.line,mix('#333333','#ffffff',0.24));
  assert.ok(contrast(darkAuto.colors['ink-3'],darkAuto.colors['surface-2'])>=4.5);
  const lightAuto=createPalette('auto','#ffffff');assert.equal(lightAuto.colors.ink,light.ink);assert.equal(lightAuto.colors['status-error'],light['status-error']);assert.equal(lightAuto.colors.surface,'#f2f2f2');
  const fallback=createPalette('auto');assert.equal(fallback.colors.bg,createPalette('slate').colors.bg);assert.match(fallback.reason,/no reply/);assert.equal(fallback.defaultBackground,true);
  const middle=createPalette('auto','#888888');assert.equal(middle.colors['ink-3'],'#ffffff');assert.match(middle.reason,/impossible/);
});
test('only auto ground cells use SGR 49, including the no-reply fallback',()=>{
  for(const background of [null,'#123456']){
    const palette=createPalette('auto',background);usePalette(palette);
    const cell={char:' ',fg:palette.colors.ink,bg:palette.colors.bg,bold:false,width:1};
    assert.match(styleEscape(cell),/;49m$/);assert.doesNotMatch(styleEscape(cell),/48;2/);
    assert.match(styleEscape({...cell,bg:palette.colors.surface}),/48;2/);
    assert.match(diffFrame([[cell]],null),/;49m/);
  }
  const fixed=createPalette('slate');usePalette(fixed);assert.match(styleEscape({fg:fixed.colors.ink,bg:fixed.colors.bg}),/48;2/);
});
