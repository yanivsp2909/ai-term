// Throwaway spike code (v0.2.1b). Draws on the normal screen, enters the alternate screen, and
// leaves it on a key. The normal screen should come back. Ctrl+C exits.
const out = s => process.stdout.write(s);
out('\x1b[2J\x1b[H');
for (let i = 1; i <= 5; i++) out(`NORMAL line ${i}\r\n`);
out('\x1b[?1049h\x1b[2J\x1b[HALT SCREEN: press a key to leave');
process.stdin.setRawMode(true);
let left = false;
process.stdin.on('data', data => {
  if (data.includes(3)) process.exit(0);
  if (!left) { left = true; out('\x1b[?1049lback on normal screen\r\n'); }
});
