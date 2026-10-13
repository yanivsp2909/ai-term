// Builds AI Term's notification helper into build/notifier/AI Term.app. The path never changes: macOS keeps the
// notification permission for the bundle id at its path, so a rebuild in place keeps the user's Allow.
import { mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'native', 'notifier'), out = join(root, 'build', 'notifier'), app = join(out, 'AI Term.app');
const binary = join(app, 'Contents', 'MacOS', 'AITermNotifier'), fresh = join(out, 'AITermNotifier.new');
// xcode-select answers without the "install developer tools" dialog that a bare xcrun shim can open.
const toolchain = [['/usr/bin/xcode-select', ['-p']], ['/usr/bin/xcrun', ['--find', 'swiftc']]].every(([file, args]) => { const r = spawnSync(file, args, { stdio: 'ignore' }); return !r.error && r.status === 0; });
if (!toolchain) { process.stdout.write('Notifier not built: swiftc not found (install the Xcode Command Line Tools). AI Term works without notifications.\n'); process.exit(1); }
function run(file, args, step) {
  const result = spawnSync(file, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) { process.stderr.write(`Notifier build failed: ${step}\n`); process.exit(1); }
}
mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
// Compile beside the bundle first, so a failed compile leaves the last working helper in place.
run('/usr/bin/xcrun', ['swiftc', '-swift-version', '6', '-strict-concurrency=complete', '-warnings-as-errors', '-parse-as-library', '-O',
  '-framework', 'AppKit', '-framework', 'UserNotifications', '-module-cache-path', join(out, 'module-cache'),
  join(source, 'Notifier.swift'), '-o', fresh], 'swiftc');
copyFileSync(join(source, 'Info.plist'), join(app, 'Contents', 'Info.plist'));
renameSync(fresh, binary);
run('/usr/bin/codesign', ['--force', '--sign', '-', app], 'codesign');
run('/usr/bin/codesign', ['--verify', '--strict', app], 'codesign verify');
process.stdout.write(`Notifier built and ad-hoc signed: ${app}\n`);
