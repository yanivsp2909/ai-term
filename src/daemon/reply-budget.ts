// Token bucket for the mirror's automatic replies to terminal queries (cursor position, colors,
// device attributes). node-pty queues PTY writes without limit, so a session that floods queries
// and never reads its input would otherwise grow the daemon's memory forever. Real programs ask a
// handful of questions at a time; anything over the budget is dropped and the program times out.
export const REPLY_BURST_BYTES = 16 * 1024;
export const REPLY_BYTES_PER_SECOND = 4 * 1024;
export class ReplyBudget {
    private tokens = REPLY_BURST_BYTES;
    private last: number;
    constructor(private readonly now: () => number = Date.now) { this.last = now(); }
    take(bytes: number): boolean {
        const now = this.now();
        this.tokens = Math.min(REPLY_BURST_BYTES, this.tokens + (now - this.last) * REPLY_BYTES_PER_SECOND / 1000);
        this.last = now;
        if (bytes > this.tokens)
            return false;
        this.tokens -= bytes;
        return true;
    }
}
