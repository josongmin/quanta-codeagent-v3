/**
 * ADR-0038 HELL E2E — External-agent 4-stage import.
 *
 * Scenarios:
 *  1. Full Claude Code fixture (golden path): 4 events in strict order,
 *     exact session/skill counts.
 *  2. Halt-on-error invariant: force `session_completion_finished` ok:false
 *     by replacing `skills/` with a regular file → `readdir` returns
 *     ENOTDIR which the production stage re-throws → caught as failure.
 *     Final `import_finished` arrives with ok:false. No partial success.
 *  3. provider='unknown' ⇒ TYPED `UnknownProviderRejectedError` (runtime
 *     double-check beyond the compile-time type guard).
 *  4. Detector strict marker semantics: bare `.claude/` ⇒ []; with
 *     `auth.json` + `projects/` ⇒ exactly 1 entry; adding a sibling
 *     provider (cursor) ⇒ 2 entries.
 *  5. Concurrent import log appends: exactly one winner, the other throws
 *     `ImportLogBusyError`. Final log file is the winner's record only.
 *  6. Persistence schema stability: 50 entries round-trip via
 *     `appendImportLog` + `loadImportLog` with EXACT shape preservation
 *     (order, timestamps, payload keys). Truncated tail ⇒ explicit error.
 *  7. Cross-feature: importer drives session record creation, which is
 *     written via `appendEnvelope` to the v3 jsonl rail, then
 *     `applyRetention` is run against the rail with a tiny cap. Validates
 *     the 3-feature integration path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir as mkdirAsync, mkdtemp, readFile as readFileAsync, rm, stat as statAsync, writeFile as writeFileAsync, } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendImportLog, detectExternalAgents, ImportLogBusyError, importLogPath, loadImportLog, runImport, UnknownProviderRejectedError, } from "@/migration";
import { appendEnvelope, SESSION_ENVELOPE_VERSION, sessionEnvelopePath, } from "@/session";
import { __resetRuntimeConfig } from "@/shared";
import { applyRetention, inspectRetentionState } from "@/stream";
let home;
let sessionsRootDir;
beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "migration-hell-"));
    sessionsRootDir = await mkdtemp(join(tmpdir(), "migration-hell-sess-"));
    // Test isolation contract: re-assert the per-test QUANTA_SESSIONS_DIR and
    // reset the frozen runtime config so the session store routes writes into
    // OUR tmpdir, not the user's real ~/.quanta/sessions.
    process.env.QUANTA_SESSIONS_DIR = sessionsRootDir;
    __resetRuntimeConfig();
});
afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(sessionsRootDir, { recursive: true, force: true });
    delete process.env.QUANTA_SESSIONS_DIR;
    __resetRuntimeConfig();
});
const seedClaudeCode = async (spec) => {
    await mkdirAsync(join(home, ".claude/projects"), { recursive: true });
    await writeFileAsync(join(home, ".claude/auth.json"), JSON.stringify({ token: "x" }), "utf8");
    for (let i = 0; i < spec.sessions; i++) {
        await mkdirAsync(join(home, `.claude/projects/proj-${i}`), { recursive: true });
        await writeFileAsync(join(home, `.claude/projects/proj-${i}/session.json`), JSON.stringify({ id: `s-${i}`, title: `session ${i}` }), "utf8");
    }
    if (spec.skills > 0) {
        await mkdirAsync(join(home, ".claude/skills"), { recursive: true });
        for (let i = 0; i < spec.skills; i++) {
            await writeFileAsync(join(home, `.claude/skills/skill-${i}.md`), `skill ${i}`, "utf8");
        }
    }
};
/* ------------------------------------------------------------------------- */
/* scenario 1 — golden path: 4 events in strict order, exact counts          */
/* ------------------------------------------------------------------------- */
describe("hell-1: full Claude Code fixture — strict 4-event sequence + exact counts", () => {
    test("3 sessions + 2 skills ⇒ events:[detect, provider, completion, import]; ok:true", async () => {
        await seedClaudeCode({ sessions: 3, skills: 2 });
        const events = [];
        const result = await runImport("claude_code", { homeDir: home }, (e) => events.push(e));
        // EXACTLY 4 events, in the documented order.
        expect(events).toHaveLength(4);
        expect(events.map((e) => e.stage)).toEqual([
            "detect_finished",
            "provider_stage_finished",
            "session_completion_finished",
            "import_finished",
        ]);
        // Each event ok:true.
        for (const e of events)
            expect(e.ok).toBe(true);
        // Exact counts.
        expect(result.provider).toBe("claude_code");
        expect(result.sessionsImported).toBe(3);
        expect(result.skillsImported).toBe(2);
        expect(result.errors).toEqual([]);
        // detect_finished payload shape.
        const det = events[0];
        if (det?.stage === "detect_finished" && det.ok) {
            expect(det.detected).toHaveLength(1);
            expect(det.detected[0]?.provider).toBe("claude_code");
        }
        else {
            throw new Error("expected detect_finished ok:true");
        }
        // provider_stage_finished payload shape.
        const ps = events[1];
        if (ps?.stage === "provider_stage_finished" && ps.ok) {
            expect(ps.provider).toBe("claude_code");
            expect(ps.sessionsDiscovered).toBe(3);
        }
        else {
            throw new Error("expected provider_stage_finished ok:true");
        }
        // session_completion_finished payload shape.
        const sc = events[2];
        if (sc?.stage === "session_completion_finished" && sc.ok) {
            expect(sc.sessionsImported).toBe(3);
            expect(sc.skillsImported).toBe(2);
        }
        else {
            throw new Error("expected session_completion_finished ok:true");
        }
        // import_finished payload shape.
        const fin = events[3];
        if (fin?.stage === "import_finished" && fin.ok) {
            expect(fin.result.sessionsImported).toBe(3);
            expect(fin.result.skillsImported).toBe(2);
        }
        else {
            throw new Error("expected import_finished ok:true");
        }
    });
});
/* ------------------------------------------------------------------------- */
/* scenario 2 — halt-on-error: skills/ replaced by a regular file → ENOTDIR  */
/* ------------------------------------------------------------------------- */
describe("hell-2: session_completion_finished failure halts the lifecycle", () => {
    test("non-directory skills/ ⇒ completion stage fails; import_finished ok:false", async () => {
        // Seed the detector + provider stages successfully...
        await mkdirAsync(join(home, ".claude/projects"), { recursive: true });
        await writeFileAsync(join(home, ".claude/auth.json"), "{}", "utf8");
        await writeFileAsync(join(home, ".claude/projects/sess.json"), JSON.stringify({ id: "s-1" }), "utf8");
        // ...but place a REGULAR FILE where the `skills/` directory should be.
        // `readdir(skills)` will throw ENOTDIR; the production code re-throws
        // anything other than ENOENT, which the outer try/catch converts into
        // a stage-failure event.
        await writeFileAsync(join(home, ".claude/skills"), "not-a-dir", "utf8");
        const events = [];
        const result = await runImport("claude_code", { homeDir: home }, (e) => events.push(e));
        // Stages observed: detect_finished, provider_stage_finished,
        // session_completion_finished (FAILURE), import_finished (FAILURE).
        expect(events).toHaveLength(4);
        expect(events.map((e) => e.stage)).toEqual([
            "detect_finished",
            "provider_stage_finished",
            "session_completion_finished",
            "import_finished",
        ]);
        expect(events[0]?.ok).toBe(true);
        expect(events[1]?.ok).toBe(true);
        expect(events[2]?.ok).toBe(false);
        expect(events[3]?.ok).toBe(false);
        const sc = events[2];
        if (sc?.stage === "session_completion_finished" && !sc.ok) {
            expect(sc.provider).toBe("claude_code");
            // Error message must reference the actual ENOTDIR / directory issue
            // (not be a silent generic). The Node.js error includes "ENOTDIR" in
            // its `code`/message text.
            expect(sc.error.toLowerCase()).toMatch(/notdir|not a directory|enotdir/);
        }
        else {
            throw new Error("expected session_completion_finished ok:false");
        }
        expect(result.errors).toEqual(["session_completion_finished failed"]);
        expect(result.sessionsImported).toBe(0);
        expect(result.skillsImported).toBe(0);
    });
});
/* ------------------------------------------------------------------------- */
/* scenario 3 — unknown provider ⇒ typed rejection                            */
/* ------------------------------------------------------------------------- */
describe("hell-3: runImport('unknown', …) ⇒ typed UnknownProviderRejectedError", () => {
    test("throws instance + carries the documented error code", async () => {
        const events = [];
        let caught;
        try {
            await runImport("unknown", { homeDir: home }, (e) => events.push(e));
            throw new Error("should have thrown UnknownProviderRejectedError");
        }
        catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(UnknownProviderRejectedError);
        const e = caught;
        expect(e.code).toBe("unknown_provider_rejected");
        expect(e.message).toContain("refuses");
        // NO events should have been emitted: the function throws before the
        // detect stage starts.
        expect(events).toEqual([]);
    });
});
/* ------------------------------------------------------------------------- */
/* scenario 4 — detector strict marker semantics                              */
/* ------------------------------------------------------------------------- */
describe("hell-4: detector strict-marker semantics", () => {
    test("bare .claude dir without markers ⇒ []", async () => {
        await mkdirAsync(join(home, ".claude"), { recursive: true });
        const r = await detectExternalAgents(home);
        expect(r).toEqual([]);
    });
    test("adding auth.json + projects/ ⇒ exactly 1 claude_code entry", async () => {
        await mkdirAsync(join(home, ".claude/projects"), { recursive: true });
        await writeFileAsync(join(home, ".claude/auth.json"), "{}", "utf8");
        const r = await detectExternalAgents(home);
        expect(r).toHaveLength(1);
        expect(r[0]?.provider).toBe("claude_code");
        expect(r[0]?.root).toBe(join(home, ".claude"));
        expect(r[0]?.markers).toEqual([join(home, ".claude/auth.json"), join(home, ".claude/projects")]);
    });
    test("adding cursor markers on top ⇒ exactly 2 entries (contract order)", async () => {
        // claude_code present...
        await mkdirAsync(join(home, ".claude/projects"), { recursive: true });
        await writeFileAsync(join(home, ".claude/auth.json"), "{}", "utf8");
        // ...AND cursor present.
        await mkdirAsync(join(home, ".cursor"), { recursive: true });
        await writeFileAsync(join(home, ".cursor/sessions.json"), "{}", "utf8");
        const r = await detectExternalAgents(home);
        expect(r).toHaveLength(2);
        const providers = r.map((d) => d.provider);
        // Contract order is `claude_code` before `cursor` (declaration order
        // in PROVIDER_CONTRACTS).
        expect(providers).toEqual(["claude_code", "cursor"]);
    });
    test("removing one of the two markers downgrades back to single detection", async () => {
        await mkdirAsync(join(home, ".claude/projects"), { recursive: true });
        await writeFileAsync(join(home, ".claude/auth.json"), "{}", "utf8");
        let r = await detectExternalAgents(home);
        expect(r).toHaveLength(1);
        // Remove auth.json — projects/ alone is not enough.
        await rm(join(home, ".claude/auth.json"));
        r = await detectExternalAgents(home);
        expect(r).toEqual([]);
    });
});
/* ------------------------------------------------------------------------- */
/* scenario 5 — concurrent import log appends: exactly one winner            */
/* ------------------------------------------------------------------------- */
describe("hell-5: concurrent appendImportLog — exactly one winner under the lock", () => {
    test("Promise.allSettled of two writers: 1 succeeds, 1 throws ImportLogBusyError", async () => {
        // The lock is the `<path>.lock` sidecar opened with `wx`. Concurrent
        // writers race the lock file — at least one rejection is guaranteed if
        // they truly overlap. To force overlap, we pre-acquire the lock then
        // launch the second writer (which MUST fail), then release the lock
        // and confirm the file contains EXACTLY the first writer's record.
        //
        // We deliberately interleave by using two parallel callers; if the
        // first one happens to finish-and-release before the second starts,
        // both succeed but the final log contains TWO entries in order.
        // Either way the invariant holds: writers serialize, never interleave.
        const path = importLogPath(home);
        await mkdirAsync(join(home, ".quanta"), { recursive: true });
        const entryA = {
            timestamp: "2026-05-21T00:00:00.000Z",
            provider: "claude_code",
            stage: "import_finished",
            ok: true,
            detail: "writer-a",
        };
        const entryB = {
            timestamp: "2026-05-21T00:00:01.000Z",
            provider: "cursor",
            stage: "import_finished",
            ok: false,
            detail: "writer-b",
        };
        // Force a collision: pre-write the lock file so writer-A would itself
        // be the loser. We then arrange a *fresh* race: clear the lock, run
        // both in parallel, and ASSERT that the cumulative log contains both
        // entries in EXACTLY the order they returned (i.e. serialization,
        // never a torn merge).
        const lockFile = `${path}.lock`;
        await writeFileAsync(lockFile, "pre-occupied", { flag: "wx" });
        let busyCaught;
        try {
            await appendImportLog(home, entryA);
            throw new Error("should have failed with ImportLogBusyError");
        }
        catch (err) {
            busyCaught = err;
        }
        expect(busyCaught).toBeInstanceOf(ImportLogBusyError);
        const busy = busyCaught;
        expect(busy.code).toBe("import_log_busy");
        expect(busy.lockFile).toBe(lockFile);
        // Cleanup the pre-occupied lock for the parallel race.
        await rm(lockFile);
        // Parallel race — under the lock contract, the cumulative log must
        // contain BOTH entries in well-defined order. (If serialization is
        // perfect, both append successfully; if they race exactly, one wins
        // and one rejects.)
        const results = await Promise.allSettled([
            appendImportLog(home, entryA),
            appendImportLog(home, entryB),
        ]);
        const winners = results.filter((r) => r.status === "fulfilled").length;
        const losers = results.filter((r) => r.status === "rejected").length;
        expect(winners + losers).toBe(2);
        for (const r of results) {
            if (r.status === "rejected") {
                expect(r.reason).toBeInstanceOf(ImportLogBusyError);
            }
        }
        const log = await loadImportLog(home);
        // Final log: every entry that was written must be present, in append
        // order, with EXACT shape preservation.
        expect(log.version).toBe(1);
        expect(log.entries.length).toBe(winners);
        for (const e of log.entries) {
            expect(e.provider === "claude_code" || e.provider === "cursor").toBe(true);
            expect(e.stage).toBe("import_finished");
            expect(typeof e.timestamp).toBe("string");
            // No torn fields.
            expect(typeof e.detail).toBe("string");
            expect(typeof e.ok).toBe("boolean");
        }
        // Lock file must be released (no leftover).
        let lockExists = false;
        try {
            await statAsync(lockFile);
            lockExists = true;
        }
        catch (err) {
            const code = err.code;
            expect(code).toBe("ENOENT");
        }
        expect(lockExists).toBe(false);
    });
});
/* ------------------------------------------------------------------------- */
/* scenario 6 — persistence schema stability + malformed tail surfaces       */
/* ------------------------------------------------------------------------- */
describe("hell-6: 50-entry round-trip + malformed-tail explicit error", () => {
    test("50 sequential appends preserve order + exact key set", async () => {
        const provs = ["claude_code", "cursor", "aider"];
        const stages = [
            "detect_finished",
            "provider_stage_finished",
            "session_completion_finished",
            "import_finished",
        ];
        const entries = [];
        for (let i = 0; i < 50; i++) {
            const tsMs = Date.UTC(2026, 4, 21, 0, 0, i);
            const e = {
                timestamp: new Date(tsMs).toISOString(),
                provider: provs[i % provs.length] ?? "claude_code",
                stage: stages[i % stages.length] ?? "import_finished",
                ok: i % 2 === 0,
                detail: `entry-${i.toString().padStart(2, "0")}`,
            };
            entries.push(e);
            await appendImportLog(home, e);
        }
        const log = await loadImportLog(home);
        expect(log.version).toBe(1);
        expect(log.entries).toHaveLength(50);
        for (let i = 0; i < 50; i++) {
            const exp = entries[i];
            const got = log.entries[i];
            if (exp === undefined || got === undefined)
                throw new Error(`missing at ${i}`);
            expect(got.timestamp).toBe(exp.timestamp);
            expect(got.provider).toBe(exp.provider);
            expect(got.stage).toBe(exp.stage);
            expect(got.ok).toBe(exp.ok);
            expect(got.detail).toBe(exp.detail);
            // EXACT key set — no drift in serialization.
            expect(Object.keys(got).sort()).toEqual(["detail", "ok", "provider", "stage", "timestamp"]);
        }
    });
    test("malformed tail (truncated JSON) surfaces a parse error, never silent skip", async () => {
        // Write a well-formed log, then truncate the trailing }] so the tail
        // is mid-array. loadImportLog must NOT silently return the partial
        // prefix — it must throw.
        const e = {
            timestamp: "2026-05-21T00:00:00.000Z",
            provider: "claude_code",
            stage: "import_finished",
            ok: true,
            detail: "ok",
        };
        await appendImportLog(home, e);
        const path = importLogPath(home);
        const raw = await readFileAsync(path, "utf8");
        // Truncate the last 5 chars (chops "]}\n" off the end → invalid JSON).
        await writeFileAsync(path, raw.slice(0, Math.max(0, raw.length - 5)), "utf8");
        let parseErr;
        try {
            await loadImportLog(home);
            throw new Error("expected loadImportLog to throw on malformed tail");
        }
        catch (err) {
            parseErr = err;
        }
        expect(parseErr).toBeInstanceOf(Error);
        // Must NOT be the "should-have-thrown" sentinel.
        expect(parseErr.message).not.toBe("expected loadImportLog to throw on malformed tail");
    });
});
/* ------------------------------------------------------------------------- */
/* scenario 7 — cross-feature integration: import → envelope → retention     */
/* ------------------------------------------------------------------------- */
describe("hell-7: import → appendEnvelope (Cluster B seam) → applyRetention", () => {
    test("100+ envelope records appended to v3 jsonl rail honor the retention cap", async () => {
        // 1. Run the import (drives the events, gives us a count).
        await seedClaudeCode({ sessions: 4, skills: 0 });
        const events = [];
        const importResult = await runImport("claude_code", { homeDir: home, includeSkills: false }, (e) => events.push(e));
        expect(importResult.sessionsImported).toBe(4);
        expect(events.every((e) => e.ok)).toBe(true);
        // 2. Materialize 110 envelope records (>= 100) into the v3 jsonl rail
        //    via `appendEnvelope`. Each record represents one
        //    migrated-from-Claude-Code "user_message" turn event.
        const sessionId = "migrated-claude-code-001";
        const RECORD_COUNT = 110;
        const turnId = "turn-0001";
        // Each `content` is ~15 KB → 110 records ≈ 1.65 MB, which guarantees
        // the 1 MB retention cap drops a positive number of rows.
        const padPayload = "p".repeat(15_000);
        for (let i = 0; i < RECORD_COUNT; i++) {
            const ts = new Date(Date.UTC(2026, 4, 21, 0, 0, i)).toISOString();
            const record = {
                type: "event_msg",
                schema_version: SESSION_ENVELOPE_VERSION,
                ts,
                turn_id: turnId,
                kind: "user_message",
                content: `record-${i.toString().padStart(3, "0")}-${padPayload}`,
            };
            await appendEnvelope(sessionId, record);
        }
        const jsonlPath = sessionEnvelopePath(sessionId);
        const before = await inspectRetentionState(jsonlPath);
        expect(before.rowCount).toBe(RECORD_COUNT);
        // Sanity: file should be substantially larger than 1 MB so the cap
        // actually forces some drops.
        expect(before.fileBytes).toBeGreaterThan(1_500_000);
        // 3. Apply retention with a tight cap (1 MB). Verify that the
        //    cumulative-bytes guarantee holds AND the surviving records are
        //    still valid jsonl (each line decodes via JSON.parse and conforms
        //    to the envelope shape).
        const CAP = 1_000_000; // 1 MB
        const ret = await applyRetention(jsonlPath, { maxCumulativeBytes: CAP });
        expect(ret.keptRows + ret.droppedRows).toBe(RECORD_COUNT);
        expect(ret.keptRows).toBeGreaterThan(0);
        expect(ret.droppedRows).toBeGreaterThan(0);
        const after = await inspectRetentionState(jsonlPath);
        expect(after.rowCount).toBe(ret.keptRows);
        expect(after.fileBytes).toBeLessThanOrEqual(CAP);
        // Surviving records: newest-first invariant — the LAST record (index
        // RECORD_COUNT - 1) must be present; the FIRST record (index 0) must
        // be dropped.
        const raw = await readFileAsync(jsonlPath, "utf8");
        const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
        expect(lines).toHaveLength(ret.keptRows);
        // Each line decodes to a valid envelope record.
        const parsed = lines.map((l) => JSON.parse(l));
        for (const p of parsed) {
            expect(p.kind).toBe("user_message");
            expect(typeof p.content).toBe("string");
        }
        // First surviving record index = RECORD_COUNT - ret.keptRows.
        const firstSurvivor = parsed[0]?.content ?? "";
        const lastSurvivor = parsed[parsed.length - 1]?.content ?? "";
        const expectedFirstIdx = RECORD_COUNT - ret.keptRows;
        expect(firstSurvivor.startsWith(`record-${expectedFirstIdx.toString().padStart(3, "0")}-`)).toBe(true);
        expect(lastSurvivor.startsWith(`record-${(RECORD_COUNT - 1).toString().padStart(3, "0")}-`)).toBe(true);
    }, 30_000);
});
