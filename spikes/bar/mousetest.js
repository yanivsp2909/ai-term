// Throwaway spike code (v0.2.1b). Turns on click+drag tracking in one encoding (argv[2]:
// default | utf8 | sgr | urxvt) and prints every decoded mouse event as "button col row".
// Ctrl+C exits.
const encoding = process.argv[2] ?? 'default';
const code = { default: null, utf8: 1005, sgr: 1006, urxvt: 1015 }[encoding];
process.stdin.setRawMode(true);
process.stdout.write(`\x1b[2J\x1b[H\x1b[?1002h${code ? `\x1b[?${code}h` : ''}MOUSE READY ${encoding}\r\n`);
const show = (b, x, y) => process.stdout.write(`event ${b} ${x} ${y}\r\n`);
process.stdin.on('data', data => {
  if (data.includes(3)) { process.stdout.write(`\x1b[?1002l${code ? `\x1b[?${code}l` : ''}`); process.exit(0); }
  const text = encoding === 'utf8' ? data.toString('utf8') : data.toString('latin1');
  let m;
  const sgr = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, urxvt = /\x1b\[(\d+);(\d+);(\d+)M/g;
  if (encoding === 'sgr') while ((m = sgr.exec(text))) show(`${m[1]}${m[4]}`, m[2], m[3]);
  else if (encoding === 'urxvt') while ((m = urxvt.exec(text))) show(Number(m[1]) - 32, m[2], m[3]);
  else for (let i = text.indexOf('\x1b[M'); i >= 0; i = text.indexOf('\x1b[M', i + 1)) {
    const v = [...text.slice(i + 3, i + 6)].map(c => c.codePointAt(0) - 32);
    show(v[0], v[1], v[2]);
  }
});
