// Builds AI Term's notification helper into build/notifier/AI Term.app. The path never changes: macOS keeps the
// notification permission for the bundle id at its path, so a rebuild in place keeps the user's Allow.
import { mkdirSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'native', 'notifier'), out = join(root, 'build', 'notifier'), app = join(out, 'AI Term.app');
// The whole bundle is assembled and signed here first, so a failed compile or signature never touches the working helper.
const staged = join(out, 'staging', 'AI Term.app'), previous = join(out, 'previous.app');
// xcode-select answers without the "install developer tools" dialog that a bare xcrun shim can open.
const toolchain = [['/usr/bin/xcode-select', ['-p']], ['/usr/bin/xcrun', ['--find', 'swiftc']]].every(([file, args]) => { const r = spawnSync(file, args, { stdio: 'ignore' }); return !r.error && r.status === 0; });
if (!toolchain) { process.stdout.write('Notifier not built: swiftc not found (install the Xcode Command Line Tools). AI Term works without notifications.\n'); process.exit(1); }
function run(file, args, step) {
  const result = spawnSync(file, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) { process.stderr.write(`Notifier build failed: ${step}\n`); process.exit(1); }
}
rmSync(join(out, 'staging'), { recursive: true, force: true });
mkdirSync(join(staged, 'Contents', 'MacOS'), { recursive: true });
run('/usr/bin/xcrun', ['swiftc', '-swift-version', '6', '-strict-concurrency=complete', '-warnings-as-errors', '-parse-as-library', '-O',
  '-framework', 'AppKit', '-framework', 'UserNotifications', '-module-cache-path', join(out, 'module-cache'),
  join(source, 'Notifier.swift'), '-o', join(staged, 'Contents', 'MacOS', 'AITermNotifier')], 'swiftc');
copyFileSync(join(source, 'Info.plist'), join(staged, 'Contents', 'Info.plist'));
run('/usr/bin/codesign', ['--force', '--sign', '-', staged], 'codesign');
run('/usr/bin/codesign', ['--verify', '--strict', staged], 'codesign verify');
// Swap the signed bundle in at the same path; the old one is removed only after the new one is in place.
rmSync(previous, { recursive: true, force: true });
try { renameSync(app, previous); } catch (error) { if (error.code !== 'ENOENT') { process.stderr.write('Notifier build failed: swap\n'); process.exit(1); } }
renameSync(staged, app);
rmSync(previous, { recursive: true, force: true }); rmSync(join(out, 'staging'), { recursive: true, force: true });
process.stdout.write(`Notifier built and ad-hoc signed: ${app}\n`);
