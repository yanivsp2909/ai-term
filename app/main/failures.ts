// Main-process failures the user should see, and what app.log keeps of them: an error code or class name, never a
// message (messages can carry paths, URLs or pasted text).
const RENDERER_REASONS = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']);
export function errorTag(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const code = 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : error.name;
}
// node-pty reports a signal death as exit code 0 plus the signal; it must not read as a clean exit.
export function describeExit(exit: { exitCode: number; signal?: number }): { text: string; failed: boolean } {
  if (exit.signal) return { text: `ai stopped by signal ${exit.signal}`, failed: true };
  return { text: `ai exited (${exit.exitCode})`, failed: exit.exitCode !== 0 };
}
// After ai exits, the window stays open with its exit line; keys and resizes have nowhere to go and say nothing.
export function inputAfterExit(ended: boolean): 'drop' | 'deliver' { return ended ? 'drop' : 'deliver'; }
export function rendererGone(details: unknown): string {
  const reason = details && typeof details === 'object' && 'reason' in details && typeof details.reason === 'string' && RENDERER_REASONS.has(details.reason) ? details.reason : 'other';
  return `Desktop renderer exited (${reason})`;
}
// A Finder launch has no stderr: without a dialog the app would just vanish.
export function startupFailed(error: unknown, deps: { log?: { error(text: string): void }; showErrorBox(title: string, body: string): void; quit(): void }): void {
  deps.log?.error(`Desktop startup failed (${errorTag(error)})`);
  deps.showErrorBox('AI Term could not start', `${errorTag(error)}. Details are in app.log in AI Term's application support folder; reinstalling the app usually fixes a damaged bundle.`);
  deps.quit();
}
