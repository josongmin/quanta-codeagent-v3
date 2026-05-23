/**
 * Decisive failure classification for `InstanceResult` — surfaced both in
 * `bench-report.json` and in the operator console next to each `[FAIL]` line.
 *
 * Two-axis schema (covering + non-exclusive):
 *   - `termination`: exactly one — HOW the run ended.
 *   - `signals[]`:    zero-or-more — WHAT went wrong along the way.
 *
 * Sources of truth:
 *   - `InstanceResult` (turns, patch, passed, error, patchPath)
 *   - The per-attempt trajectory JSONL at `<patchPath>.replace(.patch,.jsonl)`,
 *     when observe was on. Trajectory is opportunistic — absence ⇒ termination
 *     degrades to `"unknown"` and only patch-based signals fire.
 *
 * Pure-by-signature: no argv reads, no logger calls, no env. The contract is
 * exercised by `tests/unit/bench-failure-classifier.test.ts` against synthetic
 * fixtures so a future detector cannot silently drift.
 */
import { existsSync, readFileSync } from "node:fs";
import { getCachePathRe } from "./cache-pathspecs";
const VERIFY_LOOP_THRESHOLD = 5;
const SEARCH_THRASH_THRESHOLD = 5;
const DRIFT_THRESHOLD = 3;
/** Derive trajectory file path from `r.patchPath`. Returns null when patchPath
 *  is absent (observe was off), or the .jsonl sibling is missing. */
const trajectoryPathFor = (patchPath) => {
    if (!patchPath || !patchPath.endsWith(".patch"))
        return null;
    return `${patchPath.slice(0, -".patch".length)}.jsonl`;
};
/** Best-effort trajectory loader. A malformed line is skipped (not throw) so a
 *  single bad event can never derail the whole classification. */
const readTrajectory = (patchPath) => {
    const path = trajectoryPathFor(patchPath);
    if (path === null || !existsSync(path))
        return null;
    const out = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line === "")
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            // Skip malformed lines.
        }
    }
    return out;
};
const lastSessionEnd = (events) => {
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e?.kind === "session_end")
            return e;
    }
    return undefined;
};
const computeTermination = (r, events) => {
    if (r.passed)
        return "passed";
    if (r.error !== undefined)
        return "harness_error";
    if (events === null)
        return "unknown";
    const end = lastSessionEnd(events);
    if (!end?.data)
        return "unknown";
    const reason = end.data.reason;
    const turns = (end.data.turns ?? r.turns) | 0;
    if (reason === "aborted" && turns === 0)
        return "hung_stream";
    if (reason === "max_turns")
        return "max_turns_exhausted";
    return "completed_unresolved";
};
/** Collect `b/<path>` from every `diff --git` header in a unified diff. */
const diffHeaderPaths = (patch) => {
    const out = [];
    for (const line of patch.split("\n")) {
        const m = line.match(/^diff --git a\/\S+ b\/(\S+)/);
        if (m?.[1])
            out.push(m[1]);
    }
    return out;
};
/**
 * Dirty-cache leak: the patch ONLY modifies build/cache-shaped paths. A
 * single source-shaped path disqualifies the signal.
 *
 * INVARIANT ALARM (post-T2): the bench runner now prunes cache paths at the
 * git layer via `CACHE_PATHSPECS` (see `cache-pathspecs.ts`), so under
 * normal operation this detector should fire 0 times. A positive match
 * means the prune-at-source contract was violated upstream — either a new
 * cache-shaped path entered the worktree and is missing from the SSOT, or
 * the pathspec exclude was bypassed. Treat any new occurrence as a bug
 * report on the runner, not as a normal classification.
 */
const isDirtyCacheLeak = (patch) => {
    if (patch.trim() === "")
        return false;
    const paths = diffHeaderPaths(patch);
    if (paths.length === 0)
        return false;
    const re = getCachePathRe();
    return paths.every((p) => re.test(p));
};
const distinctEditedFiles = (patch) => new Set(diffHeaderPaths(patch)).size;
/** Verify-loop signal: trailing run of ≥N consecutive `bash`/`test_runner`
 *  calls with no edit/write/scripted_replace in between. Captures the
 *  "agent burned remaining turns trying to install env" pattern. */
const hasVerifyLoopStuck = (events) => {
    const calls = [];
    for (const e of events) {
        if (e.kind !== "tool_call")
            continue;
        const name = e.data?.name ?? "";
        calls.push(name);
    }
    let trailing = 0;
    for (let i = calls.length - 1; i >= 0; i--) {
        const name = calls[i];
        if (name === "bash" || name === "test_runner")
            trailing++;
        else
            break;
    }
    return trailing >= VERIFY_LOOP_THRESHOLD;
};
const SEARCH_TOOLS = new Set(["glob", "grep", "localize"]);
const FOUND_NAV_TOOLS = new Set(["read", "edit", "write", "scripted_replace"]);
/** Find the tool_result immediately following a tool_call at index `i`. The
 *  recorder writes one result per call back-to-back; another tool_call before
 *  any result means the result is missing for this call. */
const resultAfter = (events, i) => {
    for (let j = i + 1; j < events.length; j++) {
        const e = events[j];
        if (e?.kind === "tool_result")
            return e;
        if (e?.kind === "tool_call")
            return undefined;
    }
    return undefined;
};
const isEmptyResult = (result) => {
    const r = String(result.data?.result ?? "").trim();
    return r === "" || r === "[]" || r === "{}";
};
/** Search-thrash: ≥N consecutive empty-result search calls (`glob`/`grep`/
 *  `localize`) BEFORE the first read/edit/write breaks the streak. Tracks max
 *  consecutive run, not just the trailing one — so a thrash that ended with a
 *  successful `localize` still surfaces. */
const hasSearchThrashing = (events) => {
    let consec = 0;
    let max = 0;
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e?.kind !== "tool_call")
            continue;
        const name = e.data?.name ?? "";
        if (FOUND_NAV_TOOLS.has(name))
            break;
        if (!SEARCH_TOOLS.has(name))
            continue;
        const result = resultAfter(events, i);
        if (!result)
            continue;
        if (isEmptyResult(result))
            consec++;
        else
            consec = 0;
        if (consec > max)
            max = consec;
    }
    return max >= SEARCH_THRASH_THRESHOLD;
};
export const classify = (r) => {
    if (r.passed)
        return { termination: "passed", signals: [] };
    const events = readTrajectory(r.patchPath);
    const termination = computeTermination(r, events);
    const signals = [];
    if (r.patch.trim() === "")
        signals.push("empty_patch");
    else if (isDirtyCacheLeak(r.patch))
        signals.push("dirty_cache_leak");
    if (distinctEditedFiles(r.patch) >= DRIFT_THRESHOLD)
        signals.push("multi_file_drift");
    if (events !== null) {
        if (hasVerifyLoopStuck(events))
            signals.push("verify_loop_stuck");
        if (hasSearchThrashing(events))
            signals.push("search_thrashing");
    }
    return { termination, signals };
};
export const aggregate = (classifications) => {
    const byTermination = {};
    const bySignal = {};
    for (const c of classifications) {
        byTermination[c.termination] = (byTermination[c.termination] ?? 0) + 1;
        for (const s of c.signals)
            bySignal[s] = (bySignal[s] ?? 0) + 1;
    }
    return { byTermination, bySignal };
};
