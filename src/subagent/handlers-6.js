import { errMessage } from "@/shared";
/** Bound on concurrent long-running PTYs we will keep alive across calls.
 *  A normal agent run uses 0–2; this cap exists to defend against runaway
 *  spawn_loops (LLM hallucination / runaway tool). Hits return a structured
 *  error with cause:"pty_cap". */
export const MAX_PTY = 32;
/** Soft default for `wait_agent` blocking timeouts. Mirrors `task_output`'s
 *  30s upper bound; callers can override via `timeoutMs`. */
const DEFAULT_WAIT_AGENT_TIMEOUT_MS = 30_000;
/** Per-tool error helpers — guarantees the discriminator + message shape that
 *  matches the frozen contract (`ErrorShape` in tools-6.ts). */
const errExec = (message, cause) => cause !== undefined ? { kind: "error", message, cause } : { kind: "error", message };
const errWrite = (message, cause) => cause !== undefined ? { kind: "error", message, cause } : { kind: "error", message };
const errSpawn = (message, cause) => cause !== undefined ? { kind: "error", message, cause } : { kind: "error", message };
const errWait = (message, cause) => cause !== undefined ? { kind: "error", message, cause } : { kind: "error", message };
const errClose = (message, cause) => cause !== undefined ? { kind: "error", message, cause } : { kind: "error", message };
const errSendInput = (message, cause) => cause !== undefined ? { kind: "error", message, cause } : { kind: "error", message };
/** Internal pty registry. Module-scoped (one process worth of state) — the
 *  agent runs a single Bun process; the registry is the source of truth for
 *  the host's living children. Exposed for tests via {@link snapshotPtyTable}. */
export class PtyTable {
    slots = new Map();
    size() {
        return this.slots.size;
    }
    has(pid) {
        return this.slots.has(pid);
    }
    get(pid) {
        return this.slots.get(pid);
    }
    set(pid, slot) {
        this.slots.set(pid, slot);
    }
    delete(pid) {
        return this.slots.delete(pid);
    }
    /** Codex `getSnapshot` analogue — readable view for turn-checkpoint dumps. */
    snapshot() {
        const out = [];
        for (const [pid, s] of this.slots.entries()) {
            out.push({ pid, command: s.command, startedAt: s.startedAt });
        }
        return out;
    }
    /** Force-kill every live process and clear the table. Idempotent. Used by
     *  test cleanup; production sessions call this from their shutdown path. */
    closeAll() {
        for (const [, s] of this.slots) {
            try {
                s.proc.kill();
            }
            catch {
                // already dead — ignore
            }
        }
        this.slots.clear();
    }
}
/**
 * `exec_command` — spawn a shell command via `Bun.spawn` with piped stdio.
 * When `pty:true` is requested AND the child is still running at return time,
 * the handle is held in the {@link PtyTable} so subsequent `write_stdin`
 * calls can reach it; the child's pid is returned to the model.
 *
 * Failure modes (all returned as `{kind:"error", ...}` — never thrown):
 *   - spawn failure (bad command / bad cwd / ENOENT)        → `cause:"spawn_error"`
 *   - timeout (kills the child, returns timed-out result)   → `cause:"timeout"`
 *   - pty cap exceeded                                      → `cause:"pty_cap"`
 *   - abort via ctx signal (caller-cancelled mid-exec)      → `cause:"abort"`
 */
export const handleExecCommand = async (input, deps = {}, signal) => {
    const table = deps.ptyTable;
    const wantPty = input.pty === true;
    if (wantPty && table !== undefined && table.size() >= MAX_PTY) {
        return errExec(`PTY cap exceeded: ${MAX_PTY} concurrent ptys already open.`, "pty_cap");
    }
    // Build env: only set when caller supplied an overlay (so the default Bun
    // semantics — inherit current env — applies on the no-overlay path). When
    // a record is passed we MERGE onto process.env so unrelated vars survive.
    const env = input.env !== undefined
        ? { ...process.env, ...input.env }
        : undefined;
    let proc;
    try {
        proc = Bun.spawn(["bash", "-lc", input.command], {
            cwd: input.cwd,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            ...(env !== undefined ? { env } : {}),
        });
    }
    catch (e) {
        const msg = errMessage(e);
        return errExec(`Failed to spawn command: ${msg}`, "spawn_error");
    }
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
        timedOut = true;
        try {
            proc.kill();
        }
        catch {
            // already dead
        }
    }, input.timeoutMs);
    const onAbort = () => {
        aborted = true;
        try {
            proc.kill();
        }
        catch {
            // already dead
        }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        const [stdoutText, stderrText, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if (timedOut) {
            return errExec(`Command timed out after ${input.timeoutMs}ms`, "timeout");
        }
        if (aborted) {
            return errExec("Command aborted", "abort");
        }
        // If pty:true was requested AND the child is somehow still alive at this
        // point (rare — most short commands exit before we get here), keep the
        // handle so write_stdin can reach it. NOTE: the Bun.spawn pipe model
        // means once we've drained stdout we usually already saw exit; this is a
        // best-effort retain — primarily for long-lived REPLs spawned with `cat`
        // / `python -i` etc. (their stdin stays open until we close it).
        if (wantPty && table !== undefined && !proc.killed && proc.exitCode === null) {
            table.set(proc.pid, {
                proc,
                startedAt: Date.now(),
                command: input.command,
                exited: proc.exited,
            });
            return {
                kind: "success",
                exitCode,
                stdout: stdoutText,
                stderr: stderrText,
                pid: proc.pid,
            };
        }
        return { kind: "success", exitCode, stdout: stdoutText, stderr: stderrText };
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
};
/** Write to an existing PTY's stdin. Returns `bytesWritten` or a structured
 *  error if the pid is unknown / the pipe is closed / the encode fails. */
export const handleWriteStdin = async (input, deps) => {
    const slot = deps.ptyTable.get(input.pid);
    if (slot === undefined) {
        return errWrite(`No live PTY found with pid ${input.pid}`, "pid_unknown");
    }
    const data = input.appendNewline === true ? `${input.data}\n` : input.data;
    const bytes = new TextEncoder().encode(data);
    // `proc.stdin` is a FileSink in Bun. Writes are sync up to the OS buffer,
    // but on a closed pipe they throw — we catch and return a structured error.
    const stdin = slot.proc.stdin;
    if (stdin === null) {
        return errWrite(`PTY pid ${input.pid} has no stdin pipe`, "no_stdin");
    }
    try {
        stdin.write(bytes);
        await stdin.flush();
    }
    catch (e) {
        const msg = errMessage(e);
        return errWrite(`Failed to write to PTY pid ${input.pid}: ${msg}`, "write_failed");
    }
    return { kind: "success", bytesWritten: bytes.byteLength };
};
/** Spawn a child subagent through the injected runner. Returns the registry
 *  task id which `wait_agent` / `close_agent` / `send_input` reference. The
 *  caller MUST stash the returned ownerToken to authorize a later close. */
export const handleSpawnAgent = async (input, deps) => {
    const parentDepth = deps.parentDepth ?? 0;
    const childDepth = parentDepth + 1;
    const cap = input.maxDepth ?? deps.maxDepth;
    if (cap !== undefined && childDepth > cap) {
        return errSpawn(`Subagent denied: depth ${childDepth} exceeds maxDepth ${cap}`, "depth_exceeded");
    }
    const taskId = deps.registry.newId();
    const { abort, ownerToken } = deps.registry.register({
        id: taskId,
        description: input.prompt.slice(0, 120),
        ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
    });
    const req = {
        prompt: input.prompt,
        depth: childDepth,
        signal: abort.signal,
        ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
        ...(input.toolFilter !== undefined ? { toolFilter: input.toolFilter } : {}),
    };
    // Fire-and-forget: the registry record settles when the runner returns.
    void deps
        .runner(req)
        .then((r) => deps.registry.complete(taskId, r))
        .catch((e) => deps.registry.fail(taskId, errMessage(e)));
    return { kind: "success", agentId: taskId, ownerToken };
};
/** Map a settled TaskRecord status string to the contract-narrowed union
 *  the WaitAgent output expects. Extracted to keep handleWaitAgent under
 *  the biome cognitive-complexity cap. */
const renderSettled = (rec) => {
    const status = rec.status === "completed" ? "completed" : rec.status === "failed" ? "failed" : "stopped";
    return {
        kind: "success",
        status,
        finalText: rec.result?.finalText ?? rec.error ?? "",
        turns: rec.result?.turns ?? 0,
    };
};
/** Race the registry's settle promise against a timeout. Returns whichever
 *  arrived first. Extracted to bound handleWaitAgent's complexity. */
const raceSettleWithTimeout = async (registry, agentId, timeoutMs) => {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
        return await Promise.race([
            registry.waitForSettle(agentId).then(() => "settled"),
            timeout,
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
};
/** Block until the named child reaches a terminal state, or `timeoutMs`
 *  elapses (default 30s). On timeout the child remains running and may be
 *  re-awaited or closed. */
export const handleWaitAgent = async (input, deps) => {
    const rec = deps.registry.get(input.agentId);
    if (rec === undefined) {
        return errWait(`No agent found with id ${input.agentId}`, "id_unknown");
    }
    const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_AGENT_TIMEOUT_MS;
    if (rec.status !== "running")
        return renderSettled(rec);
    const winner = await raceSettleWithTimeout(deps.registry, input.agentId, timeoutMs);
    if (winner === "timeout") {
        return errWait(`wait_agent timed out after ${timeoutMs}ms`, "timeout");
    }
    const after = deps.registry.get(input.agentId);
    if (after === undefined) {
        return errWait(`agent ${input.agentId} disappeared from registry`, "id_unknown");
    }
    return renderSettled(after);
};
/** Idempotent terminate. Returns `wasRunning:false` if the agent was already
 *  settled (so the LLM can call this defensively without checking state). */
export const handleCloseAgent = async (input, deps) => {
    const rec = deps.registry.get(input.agentId);
    if (rec === undefined) {
        return errClose(`No agent found with id ${input.agentId}`, "id_unknown");
    }
    if (rec.status !== "running") {
        return { kind: "success", wasRunning: false };
    }
    let stopped;
    if (deps.ownerToken !== undefined) {
        stopped = deps.registry.stop(input.agentId, deps.ownerToken);
    }
    else {
        // Host-authority path (no LLM-supplied token) — used when close_agent is
        // routed from a trusted internal caller, e.g. a session shutdown hook.
        stopped = deps.registry.forceStop(input.agentId) ? "stopped" : "not-found";
    }
    if (stopped === "denied") {
        return errClose(`close_agent denied: owner_token does not match for ${input.agentId}`, "denied");
    }
    if (stopped === "not-found") {
        // Race: it settled between our read and our stop — idempotent path.
        return { kind: "success", wasRunning: false };
    }
    // Drop any pty owned by the same id (defensive — spawn_agent doesn't own
    // ptys today, but close_agent is the centralised teardown hook).
    return { kind: "success", wasRunning: true };
};
/** Per-agent one-shot input channel. The runner is responsible for
 *  registering a receiver under `agentId` when the child pauses awaiting
 *  conversational input; `send_input` calls the receiver and removes the
 *  entry. This is the only seam in the slice that bridges "host input" into
 *  a paused fork. */
export class InputChannelRegistry {
    channels = new Map();
    /** Register a receiver for `agentId`. Returns a disposer the runner uses
     *  to remove the channel if the child resumes/terminates without input. */
    register(agentId, receiver) {
        this.channels.set(agentId, receiver);
        return () => this.channels.delete(agentId);
    }
    has(agentId) {
        return this.channels.has(agentId);
    }
    /** One-shot deliver: pops the entry and invokes the receiver. Returns true
     *  iff the message was delivered. */
    deliver(agentId, message) {
        const receiver = this.channels.get(agentId);
        if (receiver === undefined)
            return false;
        this.channels.delete(agentId);
        try {
            receiver(message);
        }
        catch {
            // Receiver throws ⇒ treat as delivery failure (caller sees structured
            // error from the surrounding handler).
            return false;
        }
        return true;
    }
}
/** Route a conversational message to a paused child. Different from
 *  `write_stdin` — this is into the child's loop, not into a PTY. */
export const handleSendInput = async (input, deps) => {
    const rec = deps.registry.get(input.agentId);
    if (rec === undefined) {
        return errSendInput(`No agent found with id ${input.agentId}`, "id_unknown");
    }
    if (rec.status !== "running") {
        return errSendInput(`Agent ${input.agentId} is not running (status=${rec.status})`, "not_running");
    }
    if (deps.inputChannel === undefined || !deps.inputChannel.has(input.agentId)) {
        return errSendInput(`Agent ${input.agentId} is not waiting for input (no registered input channel)`, "not_paused");
    }
    const ok = deps.inputChannel.deliver(input.agentId, input.message);
    if (!ok) {
        return errSendInput(`Failed to deliver input to ${input.agentId} (channel rejected)`, "deliver_failed");
    }
    return { kind: "success", delivered: true };
};
