// Throwaway spike code (v0.2.1b). Turns on bracketed paste and prints what arrives, escaped.
// Ctrl+C exits.
process.stdin.setRawMode(true);
process.stdout.write('\x1b[2J\x1b[H\x1b[?2004hPASTE READY\r\n');
process.stdin.on('data', data => {
  if (data.length === 1 && data[0] === 3) { process.stdout.write('\x1b[?2004l'); process.exit(0); }
  process.stdout.write(JSON.stringify(data.toString('utf8')).replace(/\\u001b/g, 'ESC') + '\r\n');
});
