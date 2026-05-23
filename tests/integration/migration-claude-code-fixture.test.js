/**
 * ADR-0038 integration: spin up a ~/.claude/-shaped fixture in tmpdir, run
 * the full importer, then assert (a) 4-event sequence, (b) result counts,
 * (c) log persistence round-trips the result.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendImportLog, loadImportLog, runImport, } from "@/migration";
let home;
beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "migration-fixture-"));
    // Build a claude_code-shaped fixture.
    await mkdir(join(home, ".claude/projects/proj-a"), { recursive: true });
    await mkdir(join(home, ".claude/projects/proj-b"), { recursive: true });
    await mkdir(join(home, ".claude/skills"), { recursive: true });
    await writeFile(join(home, ".claude/auth.json"), JSON.stringify({ token: "x" }), "utf8");
    // L4: stage 3 translates real `*.jsonl` transcripts. Seed two valid Claude
    // Code sessions (one user line each) so both translate + count.
    const seedLine = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
    await writeFile(join(home, ".claude/projects/proj-a/session-1.jsonl"), seedLine("a"), "utf8");
    await writeFile(join(home, ".claude/projects/proj-b/session-2.jsonl"), seedLine("b"), "utf8");
    await writeFile(join(home, ".claude/skills/code-review.md"), "skill", "utf8");
    await writeFile(join(home, ".claude/skills/test-writer.md"), "skill", "utf8");
    await writeFile(join(home, ".claude/skills/refactor.md"), "skill", "utf8");
});
afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});
describe("e2e: claude_code fixture import (ADR-0038)", () => {
    test("emits 4 lifecycle events + final ImportResult with non-zero counts", async () => {
        const events = [];
        const result = await runImport("claude_code", { homeDir: home }, (e) => events.push(e));
        const stages = events.map((e) => e.stage);
        expect(stages).toEqual([
            "detect_finished",
            "provider_stage_finished",
            "session_completion_finished",
            "import_finished",
        ]);
        expect(events.every((e) => e.ok)).toBe(true);
        expect(result.provider).toBe("claude_code");
        // Two project directories under projects/.
        expect(result.sessionsImported).toBe(2);
        expect(result.skillsImported).toBe(3);
        expect(result.errors).toEqual([]);
    });
    test("post-import log records the run + persists across reload", async () => {
        const events = [];
        const result = await runImport("claude_code", { homeDir: home }, (e) => events.push(e));
        // Caller is expected to write the log entry; we exercise the wiring.
        await appendImportLog(home, {
            timestamp: "2026-05-21T00:00:00.000Z",
            provider: result.provider,
            stage: "import_finished",
            ok: true,
            detail: `s=${result.sessionsImported}, k=${result.skillsImported}`,
        });
        const log = await loadImportLog(home);
        expect(log.entries).toHaveLength(1);
        expect(log.entries[0]?.detail).toBe("s=2, k=3");
        expect(log.entries[0]?.ok).toBe(true);
    });
    test("detect_finished event payload includes the detected agent", async () => {
        const events = [];
        await runImport("claude_code", { homeDir: home }, (e) => events.push(e));
        const detect = events[0];
        if (detect?.stage === "detect_finished" && detect.ok) {
            expect(detect.detected).toHaveLength(1);
            expect(detect.detected[0]?.provider).toBe("claude_code");
        }
        else {
            throw new Error("expected detect_finished ok:true");
        }
    });
});
