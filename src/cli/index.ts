#!/usr/bin/env node
import packageInfo from '../../package.json' with { type: 'json' };

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stdout.write('AI Term v0.1: not built yet. See PROGRESS.md.\n');
} else if (args.length === 1 && args[0] === '--version') {
  process.stdout.write(`${packageInfo.version}\n`);
} else {
  process.stderr.write('Usage: ai [--version]\n');
  process.exitCode = 2;
}
