/** Default cap on retained SETTLED records before LRU eviction kicks in.
 *  Running tasks are never evicted regardless of count — only settled ones are
 *  reclaimed, oldest `endedAt` first. 256 fits typical long sessions without
 *  unbounded growth; override via constructor for tests or extreme workloads. */
const DEFAULT_MAX_RETAINED = 256;
/**
 * In-memory registry of background subagent tasks (v2's `taskRegistry`). The
 * Agent tool registers a task here when launched in background mode and
 * resolves it when the forked runner settles; `TaskOutput`/`TaskStop` observe
 * and cancel by id. Lives for the process — not persisted.
 *
 * Three seams the tools rely on:
 *   1. `register()` returns the per-task {@link AbortController}. Callers
 *      MUST plumb its `.signal` into the runner's request (via
 *      `SubagentRequest.signal`) so `stop(id)` actually unwinds the child.
 *      Discarding the controller is the historical bug class this fixed.
 *   2. `waitForSettle(id)` returns a Promise that resolves the instant the
 *      task transitions to a terminal status — event-driven, no busy poll.
 *   3. `pendingIds()` enumerates currently-running task ids — the session
 *      cleanup path uses this to stop+await all in-flight children on
 *      graceful shutdown.
 *
 * Settled-record GC: bounded by `maxRetained` (default 256). When the settled
 * count exceeds the cap, oldest-`endedAt`-first eviction reclaims space.
 * Running tasks are never evicted.
 */
export class TaskRegistry {
    tasks = new Map();
    aborters = new Map();
    settlers = new Map();
    /** S17: per-task owner token. The map IS the capability table — only the
     *  caller of `register()` knows the token, so only that caller can
     *  successfully stop the task. Tokens are deleted on settle. */
    owners = new Map();
    maxRetained;
    constructor(opts = {}) {
        this.maxRetained = opts.maxRetained ?? DEFAULT_MAX_RETAINED;
    }
    /** Mint a fresh, unique task id. Uses `crypto.randomUUID()` (Bun + Node
     *  ≥19): collision-resistant regardless of clock granularity. The
     *  `task_<uuid>` shape keeps log lines greppable. */
    newId() {
        return `task_${crypto.randomUUID()}`;
    }
    /** Registration returns `{abort, ownerToken}`. The caller MUST surface the
     *  token back to whatever entity is allowed to cancel the task (e.g. the
     *  LLM, by including it in the `task_run` tool result). Without the
     *  matching token, `stop()` refuses. */
    register(rec) {
        const ac = new AbortController();
        this.tasks.set(rec.id, { ...rec, status: "running", startedAt: Date.now() });
        this.aborters.set(rec.id, ac);
        let resolve;
        const promise = new Promise((r) => {
            resolve = r;
        });
        this.settlers.set(rec.id, { promise, resolve });
        const ownerToken = crypto.randomUUID();
        this.owners.set(rec.id, ownerToken);
        return { abort: ac, ownerToken };
    }
    get(id) {
        return this.tasks.get(id);
    }
    list() {
        return [...this.tasks.values()];
    }
    /** Ids of tasks currently in the "running" state. Stable snapshot — caller
     *  may mutate via `stop()` while iterating the returned array. */
    pendingIds() {
        const out = [];
        for (const t of this.tasks.values()) {
            if (t.status === "running")
                out.push(t.id);
        }
        return out;
    }
    complete(id, result) {
        const t = this.tasks.get(id);
        if (!t || t.status !== "running")
            return;
        t.status = result.ok ? "completed" : "failed";
        t.result = result;
        if (!result.ok)
            t.error = result.finalText;
        t.endedAt = Date.now();
        this.aborters.delete(id);
        this.settlers.get(id)?.resolve();
        this.settlers.delete(id);
        this.owners.delete(id);
        this.evictIfOverCap();
    }
    fail(id, error) {
        const t = this.tasks.get(id);
        if (!t || t.status !== "running")
            return;
        t.status = "failed";
        t.error = error;
        t.endedAt = Date.now();
        this.aborters.delete(id);
        this.settlers.get(id)?.resolve();
        this.settlers.delete(id);
        this.owners.delete(id);
        this.evictIfOverCap();
    }
    /** Cancel a running task — REQUIRES the owner token returned by
     *  `register()`. A sibling agent that learns the `id` cannot cancel the
     *  task without the matching token. Returns one of:
     *    - "stopped"      — task was running AND the token matched
     *    - "denied"       — task exists but the supplied token is wrong/missing
     *    - "not-found"    — id unknown or task already settled
     *
     *  This is the structural fix for the task_stop DoS surface: capability
     *  control, not "any caller can stop any id". */
    stop(id, ownerToken) {
        const t = this.tasks.get(id);
        if (!t || t.status !== "running")
            return "not-found";
        const expected = this.owners.get(id);
        if (expected === undefined || ownerToken !== expected)
            return "denied";
        this.aborters.get(id)?.abort();
        t.status = "stopped";
        t.endedAt = Date.now();
        this.aborters.delete(id);
        this.settlers.get(id)?.resolve();
        this.settlers.delete(id);
        this.owners.delete(id);
        this.evictIfOverCap();
        return "stopped";
    }
    /** Force-cancel a running task without an owner token. ONLY callable by
     *  the session-lifecycle owner (e.g. agent shutdown `cleanupSession`) —
     *  the public LLM-facing `task_stop` tool MUST go through {@link stop}.
     *
     *  This separation is the structural distinction: capability for the LLM
     *  (token-gated), authority for the host (named method, not name-gated). */
    forceStop(id) {
        const t = this.tasks.get(id);
        if (!t || t.status !== "running")
            return false;
        this.aborters.get(id)?.abort();
        t.status = "stopped";
        t.endedAt = Date.now();
        this.aborters.delete(id);
        this.settlers.get(id)?.resolve();
        this.settlers.delete(id);
        this.owners.delete(id);
        this.evictIfOverCap();
        return true;
    }
    /** Event-driven settle notifier. Returns a Promise that resolves the
     *  instant `complete`/`fail`/`stop` is called for `id`. If the task is
     *  unknown or already settled, resolves immediately. No timer; the caller
     *  composes timeout via `Promise.race`. */
    waitForSettle(id) {
        const t = this.tasks.get(id);
        if (!t || t.status !== "running")
            return Promise.resolve();
        return this.settlers.get(id)?.promise ?? Promise.resolve();
    }
    /** Drop oldest-`endedAt` settled records until the settled count is under
     *  the cap. Running tasks are never evicted. O(N log N) on overflow, O(1)
     *  on the common path (no overflow). */
    evictIfOverCap() {
        const settled = [];
        for (const t of this.tasks.values()) {
            if (t.status !== "running")
                settled.push(t);
        }
        if (settled.length <= this.maxRetained)
            return;
        settled.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
        const drop = settled.length - this.maxRetained;
        for (let i = 0; i < drop; i++) {
            const t = settled[i];
            if (t)
                this.tasks.delete(t.id);
        }
    }
}
