// Throwaway spike code (v0.2.1b). The fixed echo program for latency: raw mode, echo every byte,
// a new line every 60 characters. Ctrl+C exits.
process.stdin.setRawMode(true);
process.stdout.write('\x1b[2J\x1b[HECHO READY\r\n');
let count = 0;
process.stdin.on('data', data => {
  if (data.includes(3)) process.exit(0);
  let out = '';
  for (const byte of data) { out += String.fromCharCode(byte); if (++count % 60 === 0) out += '\r\n'; }
  process.stdout.write(out);
});
