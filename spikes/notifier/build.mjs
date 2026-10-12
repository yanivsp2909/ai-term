import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, 'build', 'AI Term.app');
const contents = join(app, 'Contents');
mkdirSync(join(contents, 'MacOS'), { recursive: true });
copyFileSync(join(here, 'Info.plist'), join(contents, 'Info.plist'));
for (const [file, args] of [
  ['/usr/bin/xcrun', ['swiftc', '-swift-version', '6', '-strict-concurrency=complete', '-warnings-as-errors', '-parse-as-library', '-O', '-framework', 'AppKit', '-framework', 'UserNotifications', '-module-cache-path', join(here, 'build', 'module-cache'), join(here, 'Notifier.swift'), '-o', join(contents, 'MacOS', 'AITermNotifier')]],
  ['/usr/bin/codesign', ['--sign', '-', '--force', app]],
  ['/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', app]],
]) {
  const start = performance.now();
  const result = spawnSync(file, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) { process.stderr.write('Notifier build failed\n'); process.exit(1); }
  process.stdout.write(`${file.split('/').at(-1)}: ${(performance.now() - start).toFixed(0)} ms\n`);
}
process.stdout.write(`App: ${app}\n`);
