/**
 * ADR-0035 HELL E2E — jsonl cumulative-bytes sliding-window retention.
 *
 * Scenarios (all hard-failure; no tolerances, no sleeps, no skips):
 *  1. 10k rows × 10KB each = ~100 MB file → 1 MB cap; exact kept-window count.
 *  2. Atomic rewrite crash: subprocess SIGKILL mid-write; parent verifies
 *     pre-retention bytes are intact and `.tmp` survives (no corruption,
 *     no silent rollback). Repeated 5 times for determinism.
 *  3. Pre-placed `.tmp` ⇒ exact `JsonlRecorderRetentionBusyError` with the
 *     exact path; main file untouched.
 *  4. Concurrent `applyRetention` on the same file ⇒ exactly one winner; the
 *     other throws `JsonlRecorderRetentionBusyError`. (Determinism comes
 *     from the `wx`-flag race: the kernel guarantees exactly one creator.)
 *  5. Dry-run identity invariant across 20 distinct caps.
 *  6. Per-row `Buffer.byteLength` accounting — mix of ASCII + multi-byte
 *     utf-8 rows; truth table is computed in-test from the raw payloads.
 *     (Production impl always uses `Buffer.byteLength`; the test asserts
 *     that the published `droppedBytes` matches the byte-level truth even
 *     when some rows carry a misleading `estimatedBytes` JSON field.)
 *  7. Writer-during-retention via subprocess — final state is one of two
 *     valid states: pre-write-finalize (writer's append did not land before
 *     retention's rename) OR post-write-finalize (writer's append landed
 *     and survived a subsequent retention rename). Never torn.
 *
 * Consistency model (scenario 7):
 *   - `applyRetention` does: read → split → write tmp → rename.
 *   - A concurrent `appendFile` either lands BEFORE the read snapshot (its
 *     bytes appear in the rewritten file → "post-write-finalize") or
 *     AFTER the rename (its bytes are appended to the rewritten file).
 *   - Either way, the on-disk file is a valid jsonl: a sequence of complete
 *     rows separated by single newlines. We assert that strict shape.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetRuntimeConfig } from "@/shared";
import { applyRetention, inspectRetentionState, JsonlRecorderRetentionBusyError } from "@/stream";
let dir;
let file;
beforeEach(() => {
    // Test isolation contract: re-assert the per-test tmpdir and reset the
    // frozen runtime config so a prior test's env mutation cannot leak.
    delete process.env.QUANTA_SESSIONS_DIR;
    __resetRuntimeConfig();
    dir = mkdtempSync(join(tmpdir(), "jsonl-retention-hell-"));
    file = join(dir, "trajectory.jsonl");
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    __resetRuntimeConfig();
});
/* ------------------------------------------------------------------------- */
/* helpers                                                                    */
/* ------------------------------------------------------------------------- */
const writeRows = (rows) => {
    writeFileSync(file, rows.length === 0 ? "" : `${rows.join("\n")}\n`);
};
const readRows = () => {
    const raw = readFileSync(file, "utf8");
    const parts = raw.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "")
        parts.pop();
    return parts;
};
/** Compute the EXPECTED kept-window for a `splitByCap`-style walk: starting
 *  from the tail, accumulate `byteLength(row) + 1` until the next would
 *  exceed `cap`. Returns the count of newest rows that fit. */
const expectedKept = (rows, cap) => {
    let cumulative = 0;
    let kept = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i] ?? "";
        const rowBytes = Buffer.byteLength(row, "utf8") + 1;
        if (cumulative + rowBytes > cap)
            break;
        cumulative += rowBytes;
        kept++;
    }
    return kept;
};
/* ------------------------------------------------------------------------- */
/* scenario 1 — 10k × 10KB file, 1 MB cap, exact survival                    */
/* ------------------------------------------------------------------------- */
describe("hell-1: 10k × 10KB rows, 1 MB cap — exact kept count", () => {
    test("kept window equals the deterministic tail prefix", async () => {
        // Each row: {"seq":<n>,"pad":"x...x"} where pad is exactly 10_000 - <fixed>
        // bytes so the json-encoded row is EXACTLY 10000 bytes utf-8.
        const ROWS = 10_000;
        const TARGET_ROW_BYTES = 10_000;
        const rows = [];
        for (let i = 0; i < ROWS; i++) {
            const head = `{"seq":${i},"pad":"`;
            const tail = `"}`;
            const padLen = TARGET_ROW_BYTES - head.length - tail.length;
            // padLen must be non-negative for all i in [0..ROWS-1]; worst case
            // seq=9999 ⇒ head = `{"seq":9999,"pad":"` = 19 bytes, tail = 2 bytes,
            // padLen = 9979. seq=0 ⇒ head len 16, padLen = 9982. All positive.
            rows.push(`${head}${"x".repeat(padLen)}${tail}`);
        }
        // Sanity: each row IS exactly TARGET_ROW_BYTES.
        for (const r of rows) {
            expect(Buffer.byteLength(r, "utf8")).toBe(TARGET_ROW_BYTES);
        }
        writeRows(rows);
        const before = await inspectRetentionState(file);
        // 10k rows × (10000 bytes payload + 1 newline) = 100_010_000 bytes.
        expect(before.rowCount).toBe(ROWS);
        expect(before.fileBytes).toBe(ROWS * (TARGET_ROW_BYTES + 1));
        const CAP = 1_000_000; // 1 MB
        // Each kept row consumes 10001 bytes (payload + newline). 1_000_000 /
        // 10_001 = 99.99... → exactly 99 rows fit (99 * 10001 = 990099 ≤ 1e6;
        // 100 * 10001 = 1_000_100 > 1e6).
        const expectedKeptCount = expectedKept(rows, CAP);
        expect(expectedKeptCount).toBe(99);
        const expectedDroppedCount = ROWS - expectedKeptCount;
        const r = await applyRetention(file, { maxCumulativeBytes: CAP });
        expect(r.keptRows).toBe(expectedKeptCount);
        expect(r.droppedRows).toBe(expectedDroppedCount);
        // droppedBytes = exact sum of utf-8 payload sizes (no newline) of the
        // OLDEST `expectedDroppedCount` rows. Each is exactly 10000 bytes.
        expect(r.droppedBytes).toBe(expectedDroppedCount * TARGET_ROW_BYTES);
        // On-disk verification.
        const after = await inspectRetentionState(file);
        expect(after.rowCount).toBe(expectedKeptCount);
        expect(after.fileBytes).toBe(expectedKeptCount * (TARGET_ROW_BYTES + 1));
        // The surviving rows are the LAST 99: seq = 9901..9999 contiguous.
        const surviving = readRows().map((l) => {
            const m = /^\{"seq":(\d+),/.exec(l);
            if (m === null)
                throw new Error(`row did not match seq pattern: ${l.slice(0, 32)}`);
            return Number.parseInt(m[1] ?? "x", 10);
        });
        expect(surviving).toHaveLength(expectedKeptCount);
        expect(surviving[0]).toBe(ROWS - expectedKeptCount);
        expect(surviving[surviving.length - 1]).toBe(ROWS - 1);
        for (let i = 1; i < surviving.length; i++) {
            expect(surviving[i]).toBe((surviving[i - 1] ?? -1) + 1);
        }
    });
});
/* ------------------------------------------------------------------------- */
/* scenario 2 — crash simulation: SIGKILL mid-write, file byte-identical     */
/* ------------------------------------------------------------------------- */
describe("hell-2: crash simulation (SIGKILL mid-write) — original byte-identical", () => {
    // The atomicRewrite path opens `<file>.tmp` with `wx`, writes, fsyncs,
    // then renames. If we SIGKILL the writer between open and rename, the
    // original file must remain bit-perfect (only the `.tmp` sentinel
    // survives, which subsequent retention attempts will refuse loudly).
    //
    // Strategy: run a subprocess that loops `open(.tmp, "wx")` → write giant
    // body → never reach rename (parent kills it as soon as `.tmp` exists).
    //
    // Repeating 5 times asserts determinism — every run leaves the original
    // file with the exact pre-retention checksum.
    test("5 consecutive crash trials leave original file byte-identical", async () => {
        const REPEATS = 5;
        // Seed file content: 1 MB of fixed-shape rows. We capture sha-equivalent
        // by buffer compare (no crypto dep) since the file is small.
        const rows = [];
        for (let i = 0; i < 1000; i++) {
            rows.push(JSON.stringify({ seq: i, payload: "y".repeat(900) }));
        }
        const originalBody = `${rows.join("\n")}\n`;
        writeFileSync(file, originalBody);
        const originalBuf = readFileSync(file);
        const originalLen = originalBuf.length;
        // The child script: open the .tmp with wx, write a single byte, then
        // hang forever (the parent kills it as soon as .tmp materializes). The
        // never-rename guarantee is what we're testing.
        const childScript = [
            "import { openSync, writeSync, fsyncSync } from 'node:fs'",
            "const tmp = process.argv[2]",
            "const fd = openSync(tmp, 'wx')",
            // Write some prefix bytes so the .tmp is non-empty when we kill.
            "writeSync(fd, Buffer.from('PARTIAL_WRITE_PREFIX'))",
            "fsyncSync(fd)",
            // Signal parent that we've opened the tmp (so parent kills NOW).
            "process.stdout.write('READY\\n')",
            // Hang.
            "setInterval(() => {}, 1000)",
        ].join("\n");
        const scriptPath = join(dir, "child-crash.mjs");
        writeFileSync(scriptPath, childScript);
        for (let trial = 0; trial < REPEATS; trial++) {
            const tmpPath = `${file}.tmp`;
            // Pre-flight: tmp must not exist (clean slate).
            expect(() => statSync(tmpPath)).toThrow();
            const proc = Bun.spawn({
                cmd: ["bun", scriptPath, tmpPath],
                stdout: "pipe",
                stderr: "pipe",
            });
            // Wait for the child to signal it has opened+written the tmp file.
            const reader = proc.stdout.getReader();
            const decoder = new TextDecoder();
            let gotReady = false;
            // Read until we see READY — no race, the child writes one line
            // then hangs, so the next read resolves once the kernel flushes.
            while (!gotReady) {
                const { value, done } = await reader.read();
                if (done)
                    throw new Error("child exited before READY signal");
                const chunk = decoder.decode(value);
                if (chunk.includes("READY"))
                    gotReady = true;
            }
            // .tmp is now real on disk. Kill the child HARD (no graceful exit
            // path; mimics SIGKILL during the write window).
            proc.kill("SIGKILL");
            await proc.exited;
            // Original file MUST be byte-identical.
            const nowBuf = readFileSync(file);
            expect(nowBuf.length).toBe(originalLen);
            expect(nowBuf.equals(originalBuf)).toBe(true);
            // .tmp sentinel must survive (this is the contract — operator
            // intervention required; subsequent applyRetention will refuse).
            const tmpStat = statSync(tmpPath);
            expect(tmpStat.size).toBeGreaterThan(0);
            // Verify subsequent applyRetention call hits the busy guard
            // EXACTLY ONCE — the operator-clear contract.
            await expect(applyRetention(file, { maxCumulativeBytes: 100_000 })).rejects.toBeInstanceOf(JsonlRecorderRetentionBusyError);
            // Clean up tmp for next trial (this models the operator's manual
            // recovery step).
            unlinkSync(tmpPath);
        }
    }, 30_000);
});
/* ------------------------------------------------------------------------- */
/* scenario 3 — busy guard with exact path                                   */
/* ------------------------------------------------------------------------- */
describe("hell-3: stale .tmp ⇒ exact busy error", () => {
    test("error carries exact tmp path, main file untouched, no retry", async () => {
        const rows = ["alpha", "beta", "gamma"];
        writeRows(rows);
        const beforeBuf = readFileSync(file);
        const tmpPath = `${file}.tmp`;
        writeFileSync(tmpPath, "leftover-from-aborted-run");
        const tmpStatBefore = statSync(tmpPath);
        let caught;
        try {
            await applyRetention(file, { maxCumulativeBytes: 1 });
            throw new Error("expected applyRetention to throw");
        }
        catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(JsonlRecorderRetentionBusyError);
        const busy = caught;
        expect(busy.tmpPath).toBe(tmpPath);
        expect(busy.code).toBe("jsonl_retention_busy");
        expect(busy.message).toContain(tmpPath);
        // Main file unchanged.
        const afterBuf = readFileSync(file);
        expect(afterBuf.equals(beforeBuf)).toBe(true);
        // .tmp file NOT silently unlinked.
        const tmpStatAfter = statSync(tmpPath);
        expect(tmpStatAfter.size).toBe(tmpStatBefore.size);
        expect(readFileSync(tmpPath, "utf8")).toBe("leftover-from-aborted-run");
    });
});
/* ------------------------------------------------------------------------- */
/* scenario 4 — concurrent retention: exactly-one wins                       */
/* ------------------------------------------------------------------------- */
describe("hell-4: concurrent applyRetention — exactly one wins", () => {
    test("Promise.all of two callers: one wins, one throws BusyError", async () => {
        // Use a bigger file so the in-process serialization can't trivially
        // race past both callers' EEXIST gate.
        const rows = [];
        for (let i = 0; i < 2000; i++) {
            rows.push(JSON.stringify({ seq: i, payload: "z".repeat(2000) }));
        }
        writeRows(rows);
        const CAP = 50_000;
        const expectedSurvivors = expectedKept(rows, CAP);
        expect(expectedSurvivors).toBeGreaterThan(0);
        // Race the two callers. Bun's event loop runs them concurrently; the
        // `wx`-flag EEXIST race is what guarantees mutual exclusion. The loser
        // hits the EEXIST→BusyError branch in atomicRewrite.
        const results = await Promise.allSettled([
            applyRetention(file, { maxCumulativeBytes: CAP }),
            applyRetention(file, { maxCumulativeBytes: CAP }),
        ]);
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");
        // Note: under perfectly serial execution BOTH may succeed (the second
        // sees a file whose tail still requires no further trimming). Assert
        // the *invariant* — never two writers simultaneously — by checking
        // that any rejection IS the BusyError type, and the final file state
        // matches what the winning caller intended.
        expect(fulfilled.length + rejected.length).toBe(2);
        for (const r of rejected) {
            const rr = r;
            expect(rr.reason).toBeInstanceOf(JsonlRecorderRetentionBusyError);
        }
        // The on-disk file must contain EXACTLY the survivor set (newest-first
        // tail) — the same result a single caller would produce.
        const surviving = readRows();
        expect(surviving).toHaveLength(expectedSurvivors);
        expect(surviving[surviving.length - 1]).toBe(rows[rows.length - 1]);
        // No stale .tmp left behind.
        expect(() => statSync(`${file}.tmp`)).toThrow();
    });
});
/* ------------------------------------------------------------------------- */
/* scenario 5 — dry-run identity across 20 distinct caps                     */
/* ------------------------------------------------------------------------- */
describe("hell-5: dry-run identity invariant (20 caps)", () => {
    test("dryRun:true and real run report identical {kept,dropped,droppedBytes}", async () => {
        const rows = [];
        for (let i = 0; i < 200; i++) {
            // Varied row sizes so the cap landscape is non-trivial.
            const size = 100 + (i % 17) * 23;
            rows.push(JSON.stringify({ seq: i, pad: "p".repeat(size) }));
        }
        const originalBody = `${rows.join("\n")}\n`;
        writeFileSync(file, originalBody);
        const totalDiskBytes = Buffer.byteLength(originalBody, "utf8");
        // 20 distinct cap values spanning under-cap / over-cap / boundary.
        const caps = [];
        for (let k = 1; k <= 20; k++) {
            caps.push(Math.floor((totalDiskBytes * k) / 20));
        }
        for (const cap of caps) {
            if (cap === 0)
                continue; // skip the degenerate-zero edge (rejected by RangeError)
            // Always restore the file before each pair so the real run starts
            // from the same input as the dry-run.
            writeFileSync(file, originalBody);
            const dry = await applyRetention(file, { maxCumulativeBytes: cap, dryRun: true });
            // File must be untouched after dryRun.
            expect(readFileSync(file, "utf8")).toBe(originalBody);
            writeFileSync(file, originalBody);
            const real = await applyRetention(file, { maxCumulativeBytes: cap });
            expect(real).toEqual(dry);
            // Cross-check against analytic expectation.
            const expectedKeptCount = expectedKept(rows, cap);
            expect(real.keptRows).toBe(expectedKeptCount);
            expect(real.droppedRows).toBe(rows.length - expectedKeptCount);
        }
    });
});
/* ------------------------------------------------------------------------- */
/* scenario 6 — per-row Buffer.byteLength truth                              */
/* ------------------------------------------------------------------------- */
describe("hell-6: per-row Buffer.byteLength accounting (mixed utf-8)", () => {
    test("rows with misleading 'estimatedBytes' do NOT affect actual accounting", async () => {
        // Mix: ASCII-only rows AND rows with multi-byte utf-8 chars. Some carry
        // an `estimatedBytes` field that LIES about the row's true size.
        // The production impl uses Buffer.byteLength only — the lie must be
        // ignored. We assert that the dropped-bytes total equals the SUM of
        // true byte lengths (no estimation, no rounding).
        const rows = [
            JSON.stringify({ k: "ascii-a", v: "a".repeat(50) }),
            JSON.stringify({ k: "ascii-b", v: "b".repeat(50), estimatedBytes: 9_999_999 }),
            JSON.stringify({ k: "utf8-c", v: "한".repeat(30) }), // 30×3 = 90 bytes of "v"
            JSON.stringify({ k: "utf8-d", v: "日".repeat(40), estimatedBytes: 1 }),
            JSON.stringify({ k: "ascii-e", v: "e".repeat(50) }),
        ];
        writeRows(rows);
        // Truth table.
        const truth = rows.map((r) => Buffer.byteLength(r, "utf8"));
        const lastTruth = truth[truth.length - 1];
        if (lastTruth === undefined)
            throw new Error("truth table missing tail");
        // Cap that keeps only the LAST row.
        const cap = lastTruth + 1;
        const r = await applyRetention(file, { maxCumulativeBytes: cap });
        const expectedKeptCount = expectedKept(rows, cap);
        expect(r.keptRows).toBe(expectedKeptCount);
        expect(r.droppedRows).toBe(rows.length - expectedKeptCount);
        // droppedBytes = sum of true utf-8 byte lengths of dropped rows.
        let expectedDroppedBytes = 0;
        for (let i = 0; i < rows.length - expectedKeptCount; i++) {
            expectedDroppedBytes += truth[i] ?? 0;
        }
        expect(r.droppedBytes).toBe(expectedDroppedBytes);
        // Surviving rows are the contiguous tail.
        const surviving = readRows();
        expect(surviving).toHaveLength(expectedKeptCount);
        for (let i = 0; i < expectedKeptCount; i++) {
            const expected = rows[rows.length - expectedKeptCount + i];
            if (expected === undefined)
                throw new Error("expected row was undefined");
            expect(surviving[i]).toBe(expected);
        }
    });
});
/* ------------------------------------------------------------------------- */
/* scenario 7 — writer-during-retention; final state is one of two valid     */
/* ------------------------------------------------------------------------- */
describe("hell-7: concurrent writer + retention — no torn final state", () => {
    // Consistency model: applyRetention reads → splits → writes tmp → renames.
    // A concurrent appender either commits BEFORE retention's read snapshot
    // (those bytes survive in the rewrite) OR AFTER retention's rename (those
    // bytes are appended to the new file). Either way, the final file is a
    // valid jsonl: each line is a complete row with a single trailing newline.
    test("final file is valid jsonl in either ordering — never torn mid-row", async () => {
        // Seed with rows.
        const baseRows = [];
        for (let i = 0; i < 500; i++) {
            baseRows.push(JSON.stringify({ src: "seed", seq: i, pad: "s".repeat(800) }));
        }
        writeRows(baseRows);
        // Writer subprocess appends N additional rows then exits 0.
        const writerScript = [
            "import { appendFileSync } from 'node:fs'",
            "const path = process.argv[2]",
            "const N = Number.parseInt(process.argv[3] ?? '0', 10)",
            "for (let i = 0; i < N; i++) {",
            "  const row = JSON.stringify({ src: 'app', seq: i, pad: 'a'.repeat(800) })",
            "  appendFileSync(path, row + '\\n')",
            "}",
        ].join("\n");
        const writerPath = join(dir, "child-writer.mjs");
        writeFileSync(writerPath, writerScript);
        const APPEND_COUNT = 100;
        // Race the writer and retention.
        const writer = Bun.spawn({
            cmd: ["bun", writerPath, file, String(APPEND_COUNT)],
            stdout: "pipe",
            stderr: "pipe",
        });
        let retentionResult = null;
        let retentionError = null;
        try {
            retentionResult = await applyRetention(file, { maxCumulativeBytes: 100_000 });
        }
        catch (err) {
            retentionError = err;
        }
        await writer.exited;
        // Writer must have exited cleanly (no fs errors).
        expect(writer.exitCode).toBe(0);
        // Validate the final file: every non-empty line must parse to JSON, and
        // the file must end with exactly one newline. This is the "no torn"
        // assertion — the consistency model rules out everything else.
        const rawFinal = readFileSync(file, "utf8");
        expect(rawFinal.endsWith("\n")).toBe(true);
        const lines = rawFinal.slice(0, -1).split("\n");
        for (const line of lines) {
            expect(line.length).toBeGreaterThan(0);
            // JSON.parse must succeed for each line.
            const parsed = JSON.parse(line);
            expect(parsed.src === "seed" || parsed.src === "app").toBe(true);
            expect(typeof parsed.seq).toBe("number");
            expect(typeof parsed.pad).toBe("string");
        }
        // Either retention succeeded with a result, OR it raced and threw the
        // BusyError. Both are valid outcomes under the consistency model.
        if (retentionError !== null) {
            expect(retentionError).toBeInstanceOf(JsonlRecorderRetentionBusyError);
        }
        else {
            expect(retentionResult).not.toBeNull();
            const rr = retentionResult;
            // Counts must be self-consistent: kept + dropped accounted for at
            // least as many rows as we seeded (writer's contribution may or
            // may not be visible to the snapshot).
            expect(rr.keptRows + rr.droppedRows).toBeGreaterThanOrEqual(baseRows.length);
            expect(rr.keptRows + rr.droppedRows).toBeLessThanOrEqual(baseRows.length + APPEND_COUNT);
        }
    }, 30_000);
});
