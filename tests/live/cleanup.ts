// What a run made, undone in reverse: the stub, ai, the world with its daemon, your key in tier 2. The same steps run when
// the run ends, fails, or is stopped with Ctrl+C (review: an abort left the daemon, its agents and the world behind).
export class Cleanup {
  private steps: { name: string; undo: () => Promise<void> }[] = [];
  private running: Promise<string[]> | null = null;
  add(name: string, undo: () => Promise<void>): void { this.steps.push({ name, undo }); }
  // Each step once, newest first; a failing step doesn't stop the others. Returns what failed, as "name: reason".
  async run(): Promise<string[]> {
    const steps = this.steps.reverse(), failed: string[] = [];
    this.steps = [];
    for (const step of steps) { try { await step.undo(); } catch (error) { failed.push(`${step.name}: ${error instanceof Error ? error.message : String(error)}`); } }
    return failed;
  }
  // Ctrl+C, a closed terminal or a kill: clean up once (a second Ctrl+C waits for it rather than cutting it short,
  // security review), say so where the terminal still listens, and exit non-zero.
  onSignals(out: (line: string) => void): void {
    // A closed terminal makes writes fail; the cleanup must still run.
    process.stdout.on('error', () => undefined);
    const say = (line: string) => { try { out(line); } catch { /* the terminal is gone: nothing to tell */ } };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => {
      if (this.running) return;
      say(`stopped (${signal}): cleaning up the temporary world`);
      this.running = this.run();
      void this.running.then(failed => { for (const line of failed) say(`note: ${line}`); process.exit(130); });
    });
  }
}
