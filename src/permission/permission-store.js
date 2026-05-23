/**
 * Permission state store (ADR-0046).
 *
 * File-backed JSON store for per-thread permissions, per-host agent modes,
 * and post-denial precedence records. Single file at `~/.quanta/permission-
 * state.json` (override via `QUANTA_PERMISSION_STATE`). Both env vars are
 * read via `runtimeConfig()` — the single legitimate `process.env` owner.
 *
 * Slice rules: pure `node:`-stdlib only (plus the slice-internal
 * `@/shared/runtime-config` ADR-frozen env reader). NO `@/storage`, NO
 * `@/memory` — `@/permission` MUST keep its dependency surface at the
 * minimum (see biome `noRestrictedImports` config). Persistence is a
 * deliberately simple read-modify-write of one JSON file with debounced
 * flush; no SQLite, no transactions. The whole state is bounded:
 *   - perThread     — one record per active thread (small N)
 *   - perHost       — one record per known host (smaller N)
 *   - deniedActions — keyed by `(threadId, actionSignature)` so a thread's
 *                     denial state is independent from its siblings'.
 *
 * Composition (refactor #3): `createPermissionStore` is the composition point.
 * It owns ONE live `MutableState` + ONE {@link JsonStateFile} persistence
 * engine (atomic write / debounce / quarantine / parse-migrate), and layers
 * three thin domain modules over them:
 *   - {@link createThreadStore} — per-thread permissions.
 *   - {@link createHostStore}   — per-host agent modes.
 *   - {@link createDenialLedger}— post-denial precedence (the 3-timestamp
 *     state machine, security-sensitive — preserved byte-identical).
 * The public {@link PermissionStore} interface is unchanged so all external
 * consumers keep working.
 *
 * Failure model (delegated to {@link JsonStateFile}):
 *   - Missing file at load    → start empty, no warning (cold-start).
 *   - Corrupt JSON            → start empty + write `.corrupt` sidecar so the
 *                               user can recover; never crash.
 *   - Schema-version mismatch → start empty + write `.unsupported-vN` sidecar
 *                               so future migration code has the prior bytes.
 *   - Write failure           → swallowed + warned (in-memory state is still
 *                               authoritative for the rest of the process).
 *   - Orphan `.tmp` from a crashed prior write → unlinked at next successful
 *                               `writeToDisk()` (cleanup-on-write).
 *
 * Concurrency:
 *   - Single in-process: writes go through `pendingFlush` serialization so a
 *     burst of mutations produces at most ONE rename per debounce window.
 *   - Multi-process (e.g. CLI + Tauri Desktop on the same `~/.quanta`):
 *     atomic `tmp + rename` prevents torn-write but NOT last-write-wins races.
 *     ADR-0046 §Trade-offs documents this as accepted (v3 = single-process);
 *     follow-up lockfile ADR queued when a multi-process surface ships.
 *
 * Tests can mint an isolated instance via `createPermissionStore({ filePath })`.
 * The production singleton is created by `getDefaultPermissionStore()`.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { runtimeConfig } from "@/shared/runtime-config";
import { createJsonStateFile } from "./json-state-file";
/** Current on-disk schema version. Bump when the JSON shape changes; add a
 *  parallel branch in {@link parseState} so older versions can be migrated
 *  in-place. A mismatch quarantines the file to `.unsupported-vN` and starts
 *  empty rather than corrupting data. */
const STATE_VERSION = 1;
/** Composite key for `deniedActions`. Stored as a single string so the JSON
 *  serialization is flat (objects-as-keys would round-trip lossily). */
const denialKey = (threadId, actionSignature) => `${threadId}::${actionSignature}`;
const emptyState = () => ({
    version: STATE_VERSION,
    perThread: Object.freeze({}),
    perHost: Object.freeze({}),
    deniedActions: Object.freeze({}),
});
/** Canonical JSON: object keys sorted lexicographically at every level so
 *  two structurally-equal payloads produce byte-identical bytes (the
 *  actionSignature must be stable across runs / processes / machines). */
const canonicalize = (value) => {
    if (value === null || typeof value !== "object")
        return value;
    if (Array.isArray(value))
        return value.map(canonicalize);
    const keys = Object.keys(value).sort();
    const out = {};
    for (const k of keys) {
        out[k] = canonicalize(value[k]);
    }
    return out;
};
/** Stable action signature. The caller passes a structurally-meaningful
 *  projection of the call ({ tool, workdir, args }); the helper canonicalizes
 *  + hashes it to a hex string. Same input ⇒ same signature on every call,
 *  so a `recordDenial` in one process can be matched by `hasPostDenialOverride`
 *  in another (or by the same process after a reload).
 *
 *  Algorithm: sha256 of `JSON.stringify(canonicalize({ tool, workdir, args }))`.
 *  Truncated to 32 hex chars (128 bits) — collision-resistant enough for the
 *  per-thread scope. */
export const computeActionSignature = (input) => {
    const canonical = JSON.stringify(canonicalize({ tool: input.tool, workdir: input.workdir, args: input.args }));
    return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
};
/** Resolve the default state file path. `QUANTA_PERMISSION_STATE` overrides;
 *  otherwise `<QUANTA_HOME>/permission-state.json` (or `~/.quanta/permission-
 *  state.json` if `QUANTA_HOME` is unset — mirrors the Codex convention).
 *
 *  Both env vars are read via `runtimeConfig()` (ADR-frozen — single
 *  legitimate `process.env` owner). */
export const defaultStateFilePath = () => {
    const cfg = runtimeConfig();
    if (cfg.permissionStateFile !== undefined)
        return cfg.permissionStateFile;
    const home = cfg.quantaHome ?? join(homedir(), ".quanta");
    return join(home, "permission-state.json");
};
const cloneAsMutable = (state) => ({
    version: STATE_VERSION,
    perThread: { ...state.perThread },
    perHost: { ...state.perHost },
    deniedActions: { ...state.deniedActions },
});
const snapshot = (state) => Object.freeze({
    version: STATE_VERSION,
    perThread: Object.freeze({ ...state.perThread }),
    perHost: Object.freeze({ ...state.perHost }),
    deniedActions: Object.freeze({ ...state.deniedActions }),
});
/** Validate a parsed JSON payload — soft-fail to an empty state when the
 *  shape is wrong rather than crash. Returns a distinguished outcome so the
 *  {@link JsonStateFile} engine can write a useful sidecar (corrupt vs
 *  unsupported-version). */
const parseState = (raw) => {
    if (raw === null || typeof raw !== "object") {
        return { kind: "shape-invalid", reason: "root must be a JSON object" };
    }
    const obj = raw;
    const v = obj.version;
    if (v !== STATE_VERSION) {
        return {
            kind: "version-mismatch",
            foundVersion: typeof v === "number" || typeof v === "string" ? v : null,
        };
    }
    const perThread = obj.perThread ?? {};
    const perHost = obj.perHost ?? {};
    const deniedActions = obj.deniedActions ?? {};
    if (typeof perThread !== "object" ||
        typeof perHost !== "object" ||
        typeof deniedActions !== "object") {
        return {
            kind: "shape-invalid",
            reason: "perThread / perHost / deniedActions must each be objects",
        };
    }
    return {
        kind: "ok",
        state: Object.freeze({
            version: STATE_VERSION,
            perThread: Object.freeze({ ...perThread }),
            perHost: Object.freeze({ ...perHost }),
            deniedActions: Object.freeze({ ...deniedActions }),
        }),
    };
};
/* ------------------------------------------------------------------------- *
 * Domain module: per-thread permissions.
 * ------------------------------------------------------------------------- */
/** Structural equality on `ThreadPermission`. Used by `setThread` to skip
 *  a redundant flush when the record didn't actually change — keeps the
 *  store idempotent (setting the same perm twice = single write). */
const threadPermEqual = (a, b) => a.approvalPolicy === b.approvalPolicy &&
    a.approvalsReviewer === b.approvalsReviewer &&
    JSON.stringify(canonicalize(a.sandboxPolicy)) === JSON.stringify(canonicalize(b.sandboxPolicy));
const createThreadStore = (state, onMutate) => ({
    get: (threadId) => state().perThread[threadId],
    list: () => {
        const m = new Map();
        for (const [k, v] of Object.entries(state().perThread))
            m.set(k, v);
        return m;
    },
    set: (threadId, perm) => {
        const existing = state().perThread[threadId];
        if (existing !== undefined && threadPermEqual(existing, perm))
            return; // idempotent
        state().perThread[threadId] = perm;
        onMutate();
    },
    clear: (threadId) => {
        if (state().perThread[threadId] === undefined)
            return; // idempotent
        delete state().perThread[threadId];
        onMutate();
    },
});
/* ------------------------------------------------------------------------- *
 * Domain module: per-host agent modes.
 * ------------------------------------------------------------------------- */
const createHostStore = (state, onMutate) => ({
    get: (hostId) => state().perHost[hostId],
    list: () => {
        const m = new Map();
        for (const [k, v] of Object.entries(state().perHost))
            m.set(k, v);
        return m;
    },
    set: (hostId, mode) => {
        if (state().perHost[hostId] === mode)
            return; // idempotent
        state().perHost[hostId] = mode;
        onMutate();
    },
    clear: (hostId) => {
        if (state().perHost[hostId] === undefined)
            return; // idempotent
        delete state().perHost[hostId];
        onMutate();
    },
});
/* ------------------------------------------------------------------------- *
 * Domain module: post-denial precedence ledger.
 *
 * The 3-timestamp state machine (deniedAt → seenRiskAt → userOverrideAt) is
 * the most logic-dense + security-sensitive part of the store. Behavior is
 * preserved byte-identical: `recordDenial` resets the sequence, risk/override
 * recording is a no-op without a prior denial, and `hasPostDenialOverride`
 * enforces deniedAt ≤ seenRiskAt ≤ userOverrideAt.
 * ------------------------------------------------------------------------- */
const createDenialLedger = (state, onMutate) => ({
    get: (threadId, actionSignature) => state().deniedActions[denialKey(threadId, actionSignature)],
    listForThread: (threadId) => {
        const out = [];
        for (const r of Object.values(state().deniedActions)) {
            if (r.threadId === threadId)
                out.push(r);
        }
        return out;
    },
    recordDenial: (args) => {
        const key = denialKey(args.threadId, args.actionSignature);
        // Recording a fresh denial RESETS the override sequence — once we've
        // denied again, any prior `seenRiskAt`/`userOverrideAt` is stale.
        state().deniedActions[key] = {
            threadId: args.threadId,
            actionSignature: args.actionSignature,
            deniedAt: args.deniedAt,
            deniedReason: args.deniedReason,
        };
        onMutate();
    },
    recordRiskSeen: (threadId, actionSignature, seenRiskAt) => {
        const key = denialKey(threadId, actionSignature);
        const existing = state().deniedActions[key];
        if (existing === undefined) {
            // Recording risk-seen without a prior denial is a no-op (defensive).
            return;
        }
        state().deniedActions[key] = { ...existing, seenRiskAt };
        onMutate();
    },
    recordUserOverride: (threadId, actionSignature, userOverrideAt) => {
        const key = denialKey(threadId, actionSignature);
        const existing = state().deniedActions[key];
        if (existing === undefined)
            return;
        state().deniedActions[key] = { ...existing, userOverrideAt };
        onMutate();
    },
    clear: (threadId, actionSignature) => {
        delete state().deniedActions[denialKey(threadId, actionSignature)];
        onMutate();
    },
    hasOverride: (threadId, actionSignature) => {
        const rec = state().deniedActions[denialKey(threadId, actionSignature)];
        if (rec === undefined)
            return false;
        if (rec.seenRiskAt === undefined || rec.userOverrideAt === undefined)
            return false;
        // Sequence enforcement: deniedAt ≤ seenRiskAt ≤ userOverrideAt.
        if (rec.seenRiskAt < rec.deniedAt)
            return false;
        if (rec.userOverrideAt < rec.seenRiskAt)
            return false;
        return true;
    },
});
/* ------------------------------------------------------------------------- *
 * Multi-process read-reconcile-MERGE (ADR-0046 follow-up: clobber fix).
 *
 * Two agent processes sharing `~/.quanta/permission-state.json` each load once,
 * mutate in-memory, then flush via tmp+rename. The rename is atomic but a BLIND
 * overwrite — process B's flush silently discarded grants/denials A wrote in
 * between. We turn that into last-write-MERGE by re-reading the on-disk state
 * at flush time and folding it into our payload with these per-sub-store rules:
 *
 *   - perThread / perHost grants — 3-WAY merge (peer-added vs locally-deleted):
 *       · a key on disk that is NOT in our baseline ⇒ a PEER added it ⇒ adopt
 *         (UNION — never drop a peer's grant).
 *       · a key in our baseline that WE removed in-memory ⇒ our revocation wins
 *         (we do NOT resurrect a grant we deliberately cleared — fail toward
 *         MORE restriction, per the security rule).
 *       · a key we currently hold ⇒ our value wins (we are the live writer).
 *
 *   - deniedActions ledger — denials are SECURITY-CRITICAL and must NEVER be
 *     lost (losing a denial = silently re-allowing). So this is NOT a 3-way
 *     merge: it is a most-restrictive UNION that ignores local deletions of a
 *     peer's denial. Per `(threadId, actionSignature)` key:
 *       · only one side has it ⇒ keep that record.
 *       · both sides have it ⇒ keep the record whose `deniedAt` is LATEST (a
 *         fresh `recordDenial` supersedes — it intentionally resets the
 *         override sequence), then re-attach the override timestamps
 *         (`seenRiskAt`/`userOverrideAt`) ONLY when they belong to that same
 *         (latest) denial generation, taking the max of each. This guarantees
 *         neither side's denial is dropped AND a stale peer can never resurrect
 *         an override sequence that a newer denial reset.
 *
 * SINGLE-PROCESS IDENTITY LAW: when we are the only writer, the file we re-read
 * deep-equals our `baseline` (we wrote it last), so: every disk key is in
 * baseline (nothing to adopt), nothing was locally deleted that isn't already
 * gone, and every denial generation matches ⇒ the merge returns exactly the
 * in-memory state. Byte-identical to the legacy blind-overwrite. (Verified by
 * the full existing suite passing unchanged.)
 * ------------------------------------------------------------------------- */
/** Pick the more-advanced denial record for a key present on BOTH sides. A
 *  newer `deniedAt` supersedes (the reset semantics of `recordDenial`); when
 *  the two denials are the same generation (equal `deniedAt`) we take the max
 *  of each override timestamp so neither side's progress is lost. A stale
 *  peer's override timestamps are dropped when our `deniedAt` is newer. */
const mergeDenialRecord = (a, b) => {
    // The record with the strictly-later denial wins its base fields; its
    // override timestamps belong to that generation.
    const [newer, older] = a.deniedAt >= b.deniedAt ? [a, b] : [b, a];
    if (newer.deniedAt > older.deniedAt) {
        // Different generations: the older record's seen/override are stale (the
        // newer denial reset the sequence). Keep ONLY the newer record's fields.
        return newer;
    }
    // Same generation (equal deniedAt): fold override progress from both sides,
    // taking the max so neither in-flight override step is dropped.
    const maxOpt = (x, y) => {
        if (x === undefined)
            return y;
        if (y === undefined)
            return x;
        return Math.max(x, y);
    };
    const seenRiskAt = maxOpt(a.seenRiskAt, b.seenRiskAt);
    const userOverrideAt = maxOpt(a.userOverrideAt, b.userOverrideAt);
    const merged = {
        threadId: newer.threadId,
        actionSignature: newer.actionSignature,
        deniedAt: newer.deniedAt,
        // deniedReason is informational; prefer the newer record's (a's on tie).
        deniedReason: newer.deniedReason,
        // Re-attach override timestamps only when present (exactOptionalProperty).
        ...(seenRiskAt !== undefined ? { seenRiskAt } : {}),
        ...(userOverrideAt !== undefined ? { userOverrideAt } : {}),
    };
    return merged;
};
/** 3-way merge of a grant map (perThread / perHost). `inMemory` is the live
 *  authoritative base; a disk key absent from `baseline` is peer-added (adopt);
 *  a baseline key WE removed stays removed (revocation wins). */
const mergeGrantMap = (onDisk, inMemory, baseline) => {
    // Start from our live state — our values win for keys we currently hold.
    const out = { ...inMemory };
    for (const [k, v] of Object.entries(onDisk)) {
        if (k in out)
            continue; // we hold it ⇒ our value wins.
        if (k in baseline)
            continue; // we knew it + dropped it ⇒ revocation wins.
        out[k] = v; // peer-added since our baseline ⇒ adopt (never drop a grant).
    }
    return out;
};
/** Reconcile the on-disk state with our in-memory state per the documented
 *  per-sub-store policy. Pure; satisfies the single-process identity law. */
const mergePermissionState = (args) => {
    const { onDisk, inMemory } = args;
    // No readable peer state (absent / corrupt / mismatch) ⇒ write our own. A
    // corrupt peer file must NOT wipe us, and we have nothing to merge in.
    if (onDisk === null)
        return inMemory;
    const baseline = args.baseline ?? emptyState();
    const perThread = mergeGrantMap(onDisk.perThread, inMemory.perThread, baseline.perThread);
    const perHost = mergeGrantMap(onDisk.perHost, inMemory.perHost, baseline.perHost);
    // Denials: most-restrictive UNION — start from our live ledger, then fold in
    // every disk denial (a peer's denial we don't have, or a more-advanced
    // version of one we share). We deliberately do NOT honor a local delete of a
    // denial here: a disk denial is preserved even if absent from memory.
    const deniedActions = { ...inMemory.deniedActions };
    for (const [key, diskRec] of Object.entries(onDisk.deniedActions)) {
        const ours = deniedActions[key];
        deniedActions[key] = ours === undefined ? diskRec : mergeDenialRecord(ours, diskRec);
    }
    return Object.freeze({
        version: STATE_VERSION,
        perThread: Object.freeze(perThread),
        perHost: Object.freeze(perHost),
        deniedActions: Object.freeze(deniedActions),
    });
};
export const createPermissionStore = (opts = {}) => {
    const filePath = opts.filePath ?? defaultStateFilePath();
    const debounceMs = opts.debounceMs ?? 200;
    let state = cloneAsMutable(emptyState());
    // ONE persistence engine + ONE file handle, shared by all three domains.
    const file = createJsonStateFile({
        filePath,
        debounceMs,
        emptyState,
        serialize: (s) => JSON.stringify(s, null, 2),
        parse: parseState,
        stateVersion: STATE_VERSION,
        mergeWithDisk: mergePermissionState,
    });
    const getState = () => state;
    const liveSnapshot = () => snapshot(state);
    const onMutate = () => file.flushDebounced(liveSnapshot);
    // Three thin domain modules over the shared state + persistence seam.
    const threads = createThreadStore(getState, onMutate);
    const hosts = createHostStore(getState, onMutate);
    const denials = createDenialLedger(getState, onMutate);
    const load = async () => {
        await file.load((s) => {
            state = cloneAsMutable(s);
        });
    };
    const reset = async () => {
        await file.reset();
        state = cloneAsMutable(emptyState());
    };
    return {
        load,
        flush: () => file.flush(liveSnapshot),
        flushDebounced: () => file.flushDebounced(liveSnapshot),
        snapshot: liveSnapshot,
        getThread: threads.get,
        getHost: hosts.get,
        getDenial: denials.get,
        listThreads: threads.list,
        listHosts: hosts.list,
        listThreadDenials: denials.listForThread,
        setThread: threads.set,
        clearThread: threads.clear,
        setHost: hosts.set,
        clearHost: hosts.clear,
        recordDenial: denials.recordDenial,
        recordRiskSeen: denials.recordRiskSeen,
        recordUserOverride: denials.recordUserOverride,
        clearDenial: denials.clear,
        hasPostDenialOverride: denials.hasOverride,
        reset,
    };
};
// --- Process-wide singleton ------------------------------------------------
let defaultStore = null;
/** Singleton accessor. Tests must NOT use this — instead create an isolated
 *  store via `createPermissionStore({ filePath })`. */
export const getDefaultPermissionStore = () => {
    if (defaultStore === null)
        defaultStore = createPermissionStore();
    return defaultStore;
};
/** Test-only reset of the singleton (does not touch any on-disk file). */
export const __resetDefaultPermissionStore = () => {
    defaultStore = null;
};
