import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignMessageIds, loadSessionById, rewindToMessage, saveSessionById, } from "@/session";
import { __resetRuntimeConfig } from "@/shared";
/**
 * Message-id rewind UX (Claude Desktop 1.7196.3 parity).
 *
 * `assignMessageIds` is the id-minting helper: every message that lacks an
 * `id` gets one; messages with an `id` are preserved byte-identically. This
 * is the seam new sessions use; old sessions on disk remain id-less by
 * default (byte-identical default-OFF posture).
 *
 * `rewindToMessage` truncates the transcript so the named message is the
 * LAST message — everything after it is removed. The named message itself
 * is preserved (Claude Desktop semantics: you rewind TO a checkpoint, not
 * past it). Missing-id and empty-session are no-ops returning `removed: 0`.
 */
const mkMeta = (overrides = {}) => ({
    id: overrides.id ?? "sess-rewind",
    title: overrides.title ?? "T",
    cwd: overrides.cwd ?? "/tmp/work",
    createdAt: overrides.createdAt ?? 1_000,
    lastTouched: overrides.lastTouched ?? 1_000,
    archived: overrides.archived ?? false,
});
const mkMessage = (text, role = "user") => ({
    role,
    content: [{ type: "text", text }],
});
describe("assignMessageIds", () => {
    test("mints unique ids on messages that lack one", () => {
        const messages = [mkMessage("a"), mkMessage("b"), mkMessage("c")];
        const out = assignMessageIds(messages);
        expect(out.length).toBe(3);
        for (const m of out) {
            expect(typeof m.id).toBe("string");
            expect(m.id.length).toBeGreaterThan(0);
        }
        const ids = new Set(out.map((m) => m.id));
        expect(ids.size).toBe(3);
    });
    test("preserves existing ids byte-identically", () => {
        const messages = [
            { ...mkMessage("a"), id: "fixed-id-A" },
            mkMessage("b"),
            { ...mkMessage("c"), id: "fixed-id-C" },
        ];
        const out = assignMessageIds(messages);
        expect(out[0]?.id).toBe("fixed-id-A");
        expect(out[2]?.id).toBe("fixed-id-C");
        // Middle one was minted.
        expect(typeof out[1]?.id).toBe("string");
        expect((out[1]?.id).length).toBeGreaterThan(0);
        // Existing ids must not collide with the minted one.
        expect(out[1]?.id).not.toBe("fixed-id-A");
        expect(out[1]?.id).not.toBe("fixed-id-C");
    });
    test("does not mutate the input array", () => {
        const messages = [mkMessage("a"), mkMessage("b")];
        const before = JSON.stringify(messages);
        assignMessageIds(messages);
        expect(JSON.stringify(messages)).toBe(before);
    });
    test("empty input returns empty array", () => {
        const out = assignMessageIds([]);
        expect(out).toEqual([]);
    });
});
describe("rewindToMessage", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "rewind-unit-"));
        process.env.QUANTA_SESSIONS_DIR = dir;
        __resetRuntimeConfig();
    });
    afterEach(() => {
        delete process.env.QUANTA_SESSIONS_DIR;
        __resetRuntimeConfig();
        rmSync(dir, { recursive: true, force: true });
    });
    test("truncates after the named message (msg itself preserved)", async () => {
        const ids = ["m0", "m1", "m2", "m3", "m4"];
        const messages = ids.map((id, i) => ({ ...mkMessage(`t${i}`), id }));
        const meta = mkMeta({ id: "s-rewind-truncate" });
        const payload = { reason: "ok", turns: 1, messages };
        await saveSessionById(meta, payload);
        const result = await rewindToMessage("s-rewind-truncate", "m2");
        expect(result.removed).toBe(2); // m3, m4 dropped
        const reloaded = await loadSessionById("s-rewind-truncate");
        expect(reloaded?.messages.length).toBe(3);
        expect(reloaded?.messages.map((m) => m.id)).toEqual([
            "m0",
            "m1",
            "m2",
        ]);
    });
    test("rewinding to the last message is a no-op", async () => {
        const ids = ["a", "b", "c"];
        const messages = ids.map((id, i) => ({ ...mkMessage(`t${i}`), id }));
        const meta = mkMeta({ id: "s-rewind-last" });
        await saveSessionById(meta, { reason: "ok", turns: 1, messages });
        const result = await rewindToMessage("s-rewind-last", "c");
        expect(result.removed).toBe(0);
        const reloaded = await loadSessionById("s-rewind-last");
        expect(reloaded?.messages.length).toBe(3);
    });
    test("missing msgId returns removed=0 (no mutation)", async () => {
        const messages = [
            { ...mkMessage("a"), id: "m0" },
            { ...mkMessage("b"), id: "m1" },
        ];
        const meta = mkMeta({ id: "s-rewind-missing" });
        await saveSessionById(meta, { reason: "ok", turns: 1, messages });
        const result = await rewindToMessage("s-rewind-missing", "does-not-exist");
        expect(result.removed).toBe(0);
        const reloaded = await loadSessionById("s-rewind-missing");
        expect(reloaded?.messages.length).toBe(2);
    });
    test("missing session is a no-op (removed=0, no throw)", async () => {
        const result = await rewindToMessage("nonexistent-session", "any");
        expect(result.removed).toBe(0);
    });
    test("empty session is a no-op", async () => {
        const meta = mkMeta({ id: "s-rewind-empty" });
        await saveSessionById(meta, { reason: "ok", turns: 0, messages: [] });
        const result = await rewindToMessage("s-rewind-empty", "anything");
        expect(result.removed).toBe(0);
        const reloaded = await loadSessionById("s-rewind-empty");
        expect(reloaded?.messages.length).toBe(0);
    });
});
