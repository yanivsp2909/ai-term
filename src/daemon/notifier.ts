import { dirname, resolve } from 'node:path';
// Inside the bundle; the helper's own name in Info.plist.
export const NOTIFIER_EXECUTABLE = 'Contents/MacOS/AITermNotifier';
// One fixed place per checkout (src/cli/index.ts and dist/cli/index.js both sit two levels below the repo root).
// Notification permission belongs to the bundle at this path, so scripts/build-notifier.mjs always rebuilds it here.
export function notifierAppPath(entry: string): string { return resolve(dirname(entry), '..', '..', 'build', 'notifier', 'AI Term.app'); }
