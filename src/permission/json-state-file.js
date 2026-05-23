import { errMessage } from "@/shared";
/**
 * Generic JSON-state-file persistence engine (ADR-0046, extracted from
 * permission-store.ts #3).
 *
 * Owns the file-side machinery that is independent of WHAT is stored:
 *   - atomic write (per-instance `.tmp.<pid>.<rand>` + `rename`)
 *   - debounced flush (one `rename` per debounce window)
 *   - write serialization (`enqueueWrite` — burst-collapse, no torn rename)
 *   - quarantine sidecars (`.corrupt`, `.unsupported-vN`)
 *   - load → parse → validate, soft-failing to an empty state
 *   - test seam: `reset()` (drain in-flight write, drop file)
 *
 * The state DOMAIN (per-thread perms / per-host modes / denial ledger) lives
 * in the caller. This helper is parameterised by:
 *   - `emptyState()`        — the cold-start value.
 *   - `serialize(state)`    — the bytes to write (caller owns canonical order).
 *   - `parse(raw)`          — a `ParseOutcome<T>` so the right sidecar is chosen.
 *
 * Slice rules unchanged: pure `node:`-stdlib only. NO `@/storage`, NO
 * `@/memory` — `@/permission` keeps its dependency surface minimal.
 *
 * Failure model (preserved verbatim from the prior god-store):
 *   - Missing file at load    → start empty, no warning (cold-start).
 *   - Corrupt JSON            → start empty + `.corrupt` sidecar; never crash.
 *   - Schema-version mismatch → start empty + `.unsupported-vN` sidecar.
 *   - Write failure           → swallowed + warned (in-memory is authoritative).
 *   - Orphan `.tmp`           → unlinked on the unhappy write path.
 *
 * Concurrency:
 *   - Single in-process: writes serialize through `pendingFlush` so a burst of
 *     mutations produces at most ONE rename per debounce window.
 *   - Multi-process: per-instance tmp suffix avoids tmp clobber. The final
 *     rename is atomic (never torn). When a `mergeWithDisk` reconciler is
 *     supplied, every flush RE-READS the on-disk file and merges it with the
 *     in-memory state before serializing → last-write-MERGE, not -WINS, so a
 *     peer's grants/denials written between our load and our flush survive.
 *     (Still not a substitute for an OS lock under pathological interleaving —
 *     a true lockfile remains the v4 follow-up — but it removes the silent
 *     clobber of grants/denials, which is the security-critical loss.)
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const stderrWarn = (msg) => {
    process.stderr.write(`[quanta] permission-store: ${msg}\n`);
};
/** Route a fire-and-forget write's rejection to the same stderr-warn surface
 *  the synchronous write path uses, so a rejected `enqueueWrite()` (e.g. with
 *  `debounceMs:0` in tests) can never surface as an unhandled rejection.
 *  `writeToDisk` already swallows its own IO errors, so this is a defensive
 *  backstop for the promise-chain itself — the happy path is unaffected. */
const swallowWriteRejection = (filePath) => (e) => {
    const message = errMessage(e);
    stderrWarn(`flush failed (${filePath}): ${message}`);
};
export const createJsonStateFile = (opts) => {
    const { filePath, debounceMs, emptyState, serialize, parse, stateVersion, mergeWithDisk } = opts;
    let loaded = false;
    let pendingTimer = null;
    let pendingFlush = null;
    /** Snapshot getter captured at the time a flush is scheduled, so a debounced
     *  or queued write serializes the LATEST state at write time. */
    let snapshotState = emptyState;
    /** The state this instance last loaded-from / persisted-to disk. Drives the
     *  3-way merge (peer-added vs locally-deleted). `null` until first load/write
     *  resolves; the merge treats `null` baseline as "adopt all on-disk records"
     *  (we have no proof we ever deleted anything). */
    let baseline = null;
    /** Per-instance unique tmp suffix. Two stores sharing the same `filePath`
     *  (multi-process scenario) use DIFFERENT tmp paths so they don't clobber
     *  each other's in-flight write. The final `rename` is still last-write-
     *  wins (atomic), but neither write tears the JSON. */
    const tmpSuffix = `.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    const tmpPath = `${filePath}${tmpSuffix}`;
    /**
     * Atomic write: write to per-instance `.tmp.<pid>.<rand>`, then `rename`
     * over the final path. Avoids torn-write on crash AND prevents two
     * processes from clobbering each other's tmp file. On the unhappy path
     * the `.tmp` is unlinked so a crashed previous attempt can never linger.
     *
     * Concurrency:
     *   - Intra-process: serialized externally via {@link enqueueWrite} so two
     *     back-to-back mutations never `rename` over each other.
     *   - Multi-process: per-instance tmp suffix avoids tmp clobber; the final
     *     rename is still last-write-wins (see module comment).
     */
    /** Silent re-read used by the merge path (NOT load). Returns the parsed
     *  on-disk state, or `null` when the file is absent OR unreadable OR corrupt
     *  OR a version/shape mismatch. Crucially this NEVER quarantines and NEVER
     *  throws: a peer process mid-rename, a corrupt peer file, or a future-schema
     *  peer must NOT wipe our in-memory state nor crash our flush — we simply
     *  fall back to writing our own state (`null` ⇒ merge sees no disk records).
     *  The real `load()` path keeps its quarantine/sidecar behavior intact. */
    const rereadForMerge = async () => {
        if (mergeWithDisk === undefined)
            return null;
        let raw;
        try {
            raw = await readFile(filePath, "utf8");
        }
        catch {
            return null; // absent (first write) or unreadable — fall back to our state.
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return null; // corrupt peer file — do NOT let it wipe us, do NOT crash.
        }
        const outcome = parse(parsed);
        return outcome.kind === "ok" ? outcome.state : null;
    };
    const writeToDisk = async () => {
        try {
            await mkdir(dirname(filePath), { recursive: true });
            const inMemory = snapshotState();
            // Read-reconcile-MERGE: fold any peer-written records on disk into our
            // payload so a concurrent flush is last-write-MERGE, not -WINS. Absent
            // mergeWithDisk ⇒ legacy blind-overwrite (identical bytes). Single
            // process ⇒ onDisk deep-equals baseline ⇒ merge is identity (see law).
            const merged = mergeWithDisk === undefined
                ? inMemory
                : mergeWithDisk({ onDisk: await rereadForMerge(), inMemory, baseline });
            const payload = serialize(merged);
            await writeFile(tmpPath, payload, "utf8");
            await rename(tmpPath, filePath);
            // The merged state is now what's on disk → it becomes our new baseline so
            // the next 3-way merge diffs against what we actually persisted.
            baseline = merged;
        }
        catch (e) {
            const message = errMessage(e);
            stderrWarn(`flush failed (${filePath}): ${message}`);
            // Best-effort cleanup: remove a partial `.tmp` so the next write
            // starts from a clean slate (no orphan-tmp accumulation).
            try {
                await unlink(tmpPath);
            }
            catch {
                // tmp may not exist — that's fine.
            }
        }
    };
    /** True ⇨ a mutation since the last successful write is awaiting flush.
     *  Set by every mutating API (via markDirty/flushDebounced), cleared right
     *  before `writeToDisk` is called. Used to skip "write nothing" rewrites in
     *  `flush()` so idempotent set*() cannot bump the file's mtime. */
    let dirty = false;
    /**
     * Serialize writes through `pendingFlush`. A second mutation that arrives
     * while the first is in flight does NOT race a second `rename` — it queues
     * to run after the in-flight one resolves. Returns the promise of the
     * write that captured this mutation, so callers awaiting `flush()` see
     * their bytes hit disk.
     *
     * Behavior:
     *   - dirty + idle ⇒ start a fresh write, clear dirty.
     *   - dirty + in-flight ⇒ chain a new write after the current one
     *     (captures the latest state on the chained `writeToDisk` callback).
     *   - clean + in-flight ⇒ just return the in-flight promise (no double-write).
     *   - clean + idle ⇒ no-op (returns resolved promise).
     */
    const enqueueWrite = () => {
        if (!dirty)
            return pendingFlush ?? Promise.resolve();
        const prior = pendingFlush ?? Promise.resolve();
        // Capture the dirty bit at queue time so a NEW mutation arriving while
        // we're awaiting `prior` still gets its own write (it re-sets dirty).
        dirty = false;
        const next = prior.then(writeToDisk);
        pendingFlush = next.finally(() => {
            // Clear the slot ONLY if we were the most recent enqueue. A later
            // enqueue would have overwritten `pendingFlush` already.
            if (pendingFlush === next)
                pendingFlush = null;
        });
        return next;
    };
    const flush = async (getState) => {
        snapshotState = getState;
        if (pendingTimer !== null) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        // If a debounced write was queued but not yet started, run it now
        // (combined with any new mutations since). Also waits on any in-flight
        // write so `await flush()` is a true "bytes are durable" barrier.
        await enqueueWrite();
    };
    const flushDebounced = (getState) => {
        snapshotState = getState;
        dirty = true;
        if (debounceMs <= 0) {
            // Tests with debounceMs:0 still serialize through the queue — fixes
            // the prior "fire-and-forget hits a deleted tmpdir during teardown"
            // noise by ensuring `await flush()` drains all queued writes.
            enqueueWrite().catch(swallowWriteRejection(filePath));
            return;
        }
        if (pendingTimer !== null)
            clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => {
            pendingTimer = null;
            enqueueWrite().catch(swallowWriteRejection(filePath));
        }, debounceMs);
        // Don't keep the event loop alive solely for the flush.
        if (typeof pendingTimer.unref === "function") {
            ;
            pendingTimer.unref?.();
        }
    };
    /** Quarantine bytes to a versioned sidecar (`.corrupt`, `.unsupported-vN`).
     *  Best-effort — if the sidecar write fails we keep going with an empty
     *  state in memory. */
    const quarantine = async (suffix, raw) => {
        try {
            await writeFile(`${filePath}.${suffix}`, raw, "utf8");
        }
        catch {
            // best-effort — the in-memory state is still safe.
        }
    };
    /** Read bytes from disk OR signal "not present yet" via `null`. Surfaces
     *  unexpected IO errors (permission denied, EISDIR, …) to the caller as a
     *  warning rather than crashing the process. */
    const readRawState = async () => {
        try {
            return await readFile(filePath, "utf8");
        }
        catch (e) {
            const code = e.code;
            if (code === "ENOENT")
                return null;
            const message = errMessage(e);
            stderrWarn(`load failed (${filePath}): ${message} — starting empty`);
            return null;
        }
    };
    /** Parse bytes already known to exist. Splits the three terminal cases so
     *  `load()` stays well under the complexity ceiling. */
    const parseRawState = async (raw) => {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (e) {
            const message = errMessage(e);
            stderrWarn(`state file corrupt JSON (${filePath}): ${message} — starting empty`);
            await quarantine("corrupt", raw);
            return null;
        }
        const outcome = parse(parsed);
        if (outcome.kind === "ok")
            return outcome.state;
        if (outcome.kind === "version-mismatch") {
            stderrWarn(`state file schema mismatch (${filePath}) — found version=${String(outcome.foundVersion)}, expected ${stateVersion} — starting empty (quarantined)`);
            await quarantine(`unsupported-v${String(outcome.foundVersion)}`, raw);
            return null;
        }
        stderrWarn(`state file shape invalid (${filePath}): ${outcome.reason} — starting empty`);
        return null;
    };
    const load = async (setState) => {
        if (loaded)
            return;
        loaded = true;
        const raw = await readRawState();
        if (raw === null) {
            const cold = emptyState();
            // Establish a baseline even on cold start: we KNOW we loaded an empty
            // file, so any record that later appears on disk is peer-added (adopt),
            // and any record we never set was never ours to delete.
            baseline = cold;
            setState(cold);
            return;
        }
        const validated = await parseRawState(raw);
        const initial = validated ?? emptyState();
        baseline = initial;
        setState(initial);
    };
    const reset = async () => {
        if (pendingTimer !== null) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        // Wait on any in-flight write so we don't unlink mid-rename — without
        // this, a flush queued by a recent set*() could resurrect the file we
        // just deleted (Heisenbug seen in stress tests).
        if (pendingFlush !== null) {
            try {
                await pendingFlush;
            }
            catch {
                // Surfaced via stderrWarn already.
            }
        }
        loaded = false;
        baseline = null;
        try {
            await unlink(filePath);
        }
        catch {
            // best-effort — file may not exist yet.
        }
    };
    return { load, flush, flushDebounced, reset };
};
