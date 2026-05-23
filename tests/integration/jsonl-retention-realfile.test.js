import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRetention, inspectRetentionState } from "@/stream";
let dir;
let file;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jsonl-retention-int-"));
    file = join(dir, "trajectory.jsonl");
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});
describe("jsonl retention — real ~2MB file with 1MB cap", () => {
    test("preserves exactly the newest-first prefix that fits", async () => {
        // Build ~2 MB of jsonl-shaped rows. Each row carries its own sequence
        // index so the survival pattern is verifiable.
        const ROW_COUNT = 2000;
        const rows = [];
        for (let i = 0; i < ROW_COUNT; i++) {
            // Pad each row to ~1024 bytes so 2000 rows ≈ 2 MB on disk.
            const padding = "x".repeat(960);
            rows.push(JSON.stringify({ seq: i, payload: padding }));
        }
        writeFileSync(file, `${rows.join("\n")}\n`);
        const before = await inspectRetentionState(file);
        expect(before.rowCount).toBe(ROW_COUNT);
        expect(before.fileBytes).toBeGreaterThan(1_500_000);
        const CAP = 1_000_000; // 1 MB
        const r = await applyRetention(file, { maxCumulativeBytes: CAP });
        // Verify counts add up.
        expect(r.keptRows + r.droppedRows).toBe(ROW_COUNT);
        expect(r.keptRows).toBeGreaterThan(0);
        expect(r.droppedRows).toBeGreaterThan(0);
        // The remaining file fits within the cap.
        const after = await inspectRetentionState(file);
        expect(after.fileBytes).toBeLessThanOrEqual(CAP);
        expect(after.rowCount).toBe(r.keptRows);
        // Newest-first preservation: the LAST seq in the file is ROW_COUNT - 1,
        // and the kept window is contiguous from (ROW_COUNT - r.keptRows) up.
        const remaining = readFileSync(file, "utf8")
            .split("\n")
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l));
        expect(remaining.length).toBe(r.keptRows);
        expect(remaining[remaining.length - 1]?.seq).toBe(ROW_COUNT - 1);
        expect(remaining[0]?.seq).toBe(ROW_COUNT - r.keptRows);
        // No gaps in the surviving seq window.
        for (let i = 1; i < remaining.length; i++) {
            expect(remaining[i]?.seq).toBe((remaining[i - 1]?.seq ?? -1) + 1);
        }
    });
    test("dry-run on 2MB file: identical counts, untouched on disk", async () => {
        const rows = [];
        for (let i = 0; i < 2000; i++) {
            rows.push(JSON.stringify({ seq: i, payload: "x".repeat(960) }));
        }
        writeFileSync(file, `${rows.join("\n")}\n`);
        const sizeBefore = readFileSync(file, "utf8").length;
        const r1 = await applyRetention(file, { maxCumulativeBytes: 1_000_000, dryRun: true });
        expect(readFileSync(file, "utf8").length).toBe(sizeBefore);
        // Real run produces the same counts.
        const r2 = await applyRetention(file, { maxCumulativeBytes: 1_000_000 });
        expect(r2).toEqual(r1);
    });
});
