import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEnvelope, assignMessageIds, iterateSessionFile, loadSessionById, rewindToMessage, SESSION_ENVELOPE_VERSION, saveSessionById, sessionEnvelopePath, } from "@/session";
import { __resetRuntimeConfig } from "@/shared";
/**
 * End-to-end coverage for the message-granularity rewind UX (Claude Desktop
 * 1.7196.3 parity).
 *
 * Locks in:
 *   - Round-trip: save → assignMessageIds → rewindToMessage → loadSessionById
 *     returns the expected truncated transcript.
 *   - The JSONL envelope log is NOT touched by rewind (phase-A scope) — the
 *     append-only rail keeps its event log intact, and replay/reconciliation
 *     stays the consumer's job.
 *
 * Phase scope note: rewind only truncates the snapshot JSON. Envelope-log
 * truncation (turn_context / event_msg / response_item shadow-removal for
 * post-rewind turn_ids) is deferred — the JSONL stays append-only so any
 * external replay can intersect it with the post-rewind snapshot.
 */
const isoAt = (sec) => new Date(1_716_000_000_000 + sec * 1000).toISOString();
const mkMeta = (overrides = {}) => ({
    id: overrides.id ?? "sess-rewind-e2e",
    title: overrides.title ?? "T",
    cwd: overrides.cwd ?? "/tmp/work",
    createdAt: overrides.createdAt ?? 1_000,
    lastTouched: overrides.lastTouched ?? 1_000,
    archived: overrides.archived ?? false,
});
describe("session-rewind-e2e", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "session-rewind-e2e-"));
        process.env.QUANTA_SESSIONS_DIR = dir;
        __resetRuntimeConfig();
    });
    afterEach(() => {
        delete process.env.QUANTA_SESSIONS_DIR;
        __resetRuntimeConfig();
        rmSync(dir, { recursive: true, force: true });
    });
    test("save 5 messages, rewind to messages[2], reload yields 3 messages", async () => {
        const raw = [
            { role: "user", content: [{ type: "text", text: "m0" }] },
            { role: "assistant", content: [{ type: "text", text: "m1" }] },
            { role: "user", content: [{ type: "text", text: "m2" }] },
            { role: "assistant", content: [{ type: "text", text: "m3" }] },
            { role: "user", content: [{ type: "text", text: "m4" }] },
        ];
        // assignMessageIds is the canonical seam for new-session id minting.
        const withIds = assignMessageIds(raw, (i) => `mid-${i}`);
        const meta = mkMeta({ id: "rewind-roundtrip" });
        const payload = { reason: "ok", turns: 1, messages: withIds };
        await saveSessionById(meta, payload);
        const targetId = withIds[2]?.id;
        if (typeof targetId !== "string")
            throw new Error("test setup: expected id at index 2");
        const result = await rewindToMessage("rewind-roundtrip", targetId);
        expect(result.removed).toBe(2);
        const reloaded = await loadSessionById("rewind-roundtrip");
        expect(reloaded).toBeDefined();
        expect(reloaded?.messages.length).toBe(3);
        const ids = reloaded?.messages.map((m) => m.id);
        expect(ids).toEqual(["mid-0", "mid-1", "mid-2"]);
        // Text payload also preserved (no body mutation).
        const last = reloaded?.messages[2];
        if (last === undefined)
            throw new Error("expected reloaded[2]");
        const lastBlock = last.content[0];
        if (lastBlock === undefined || lastBlock.type !== "text") {
            throw new Error("expected text block");
        }
        expect(lastBlock.text).toBe("m2");
        // lastTouched was bumped relative to the original.
        expect((reloaded?.meta.lastTouched ?? 0) >= 1_000).toBe(true);
    });
    test("envelope JSONL is NOT truncated by rewind (phase-A scope)", async () => {
        // Setup: write 4 envelope events spanning 4 turns.
        const sessionId = "rewind-envelope-untouched";
        const events = [];
        for (let i = 0; i < 4; i += 1) {
            const ev = {
                type: "event_msg",
                schema_version: SESSION_ENVELOPE_VERSION,
                ts: isoAt(i),
                turn_id: `t-${i}`,
                kind: "token_count",
                input_tokens: i,
                output_tokens: i * 2,
            };
            events.push(ev);
            await appendEnvelope(sessionId, ev);
        }
        // And a snapshot with 5 ided messages.
        const withIds = assignMessageIds([
            { role: "user", content: [{ type: "text", text: "m0" }] },
            { role: "assistant", content: [{ type: "text", text: "m1" }] },
            { role: "user", content: [{ type: "text", text: "m2" }] },
            { role: "assistant", content: [{ type: "text", text: "m3" }] },
            { role: "user", content: [{ type: "text", text: "m4" }] },
        ], (i) => `mid-${i}`);
        await saveSessionById(mkMeta({ id: sessionId }), {
            reason: "ok",
            turns: 4,
            messages: withIds,
        });
        const result = await rewindToMessage(sessionId, "mid-1");
        expect(result.removed).toBe(3);
        // Snapshot truncated correctly.
        const reloaded = await loadSessionById(sessionId);
        expect(reloaded?.messages.length).toBe(2);
        // Envelope log is intact — append-only invariant preserved.
        const path = sessionEnvelopePath(sessionId);
        let count = 0;
        for await (const r of iterateSessionFile(path)) {
            expect(r.ok).toBe(true);
            count += 1;
        }
        expect(count).toBe(4);
    });
    test("rewind on a session without ids yields removed=0 (byte-identical default-OFF)", async () => {
        // Sessions that pre-date the id-rewind feature have id-less messages on
        // disk. `rewindToMessage` MUST treat them as a no-op so legacy files are
        // never silently mutated.
        const messages = [
            { role: "user", content: [{ type: "text", text: "a" }] },
            { role: "assistant", content: [{ type: "text", text: "b" }] },
        ];
        await saveSessionById(mkMeta({ id: "legacy-noid" }), {
            reason: "ok",
            turns: 1,
            messages,
        });
        const result = await rewindToMessage("legacy-noid", "any-id");
        expect(result.removed).toBe(0);
        const reloaded = await loadSessionById("legacy-noid");
        expect(reloaded?.messages.length).toBe(2);
    });
});
