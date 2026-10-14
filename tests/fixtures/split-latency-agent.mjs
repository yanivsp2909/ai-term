import process from 'node:process';
// Split latency agent, chosen by its folder: "yes" prints like `yes` as fast as its PTY takes it; "count" prints numbered
// lines just as fast, so every frame of its pane changes; anywhere else it echoes typed bytes like latency-echo.mjs.
process.stdin.setRawMode(true);
process.stdin.resume();
const folder = process.cwd().split('/').at(-1);
if (folder === 'yes' || folder === 'count') {
  let n = 0;
  const chunk = () => folder === 'yes' ? 'y\r\n'.repeat(4096) : Array.from({ length: 512 }, () => `line ${n++} ${'#'.repeat(n % 50)}\r\n`).join('');
  const pump = () => { while (process.stdout.write(chunk())); process.stdout.once('drain', pump); };
  process.stdin.on('data', data => { if (data.includes(3)) process.exit(0); });
  pump();
} else {
  process.stdout.write('ECHO_READY\r\n');
  process.stdin.on('data', data => { if (data.includes(3)) process.exit(0); process.stdout.write(data); });
}
