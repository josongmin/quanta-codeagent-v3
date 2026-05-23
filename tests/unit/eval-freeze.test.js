/**
 * Freeze — promotion of a JSONL session into the fixtures dir.
 *
 *   1. Source with a meta sidecar ⇒ copied into <root>/<usecase>/.
 *   2. Source without meta + no inline prompt ⇒ refused (null).
 *   3. Source without meta + inline prompt ⇒ synthesised meta written.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeFixture } from "@/../src/apps/eval/trajectory/freeze";
import { writeMeta } from "@/../src/apps/eval/trajectory/meta";
describe("freezeFixture", () => {
    test("with meta sidecar ⇒ copies fixture + meta", () => {
        const dir = mkdtempSync(join(tmpdir(), "freeze-"));
        const src = join(dir, "session.jsonl");
        writeFileSync(src, "{}\n");
        writeMeta(src, {
            schema: 1,
            userPrompt: "do it",
            cwd: "/tmp",
            producer: { name: "test" },
            recordedAt: "2026-01-01T00:00:00Z",
        });
        const root = mkdtempSync(join(tmpdir(), "freeze-root-"));
        const r = freezeFixture({
            source: src,
            usecase: "software-quality.debugging.error-message-paste",
            fixturesRoot: root,
        });
        expect(r).not.toBeNull();
        if (r === null)
            return;
        expect(existsSync(r.fixturePath)).toBe(true);
        expect(existsSync(r.metaPath)).toBe(true);
        const meta = JSON.parse(readFileSync(r.metaPath, "utf8"));
        expect(meta.usecase).toBe("software-quality.debugging.error-message-paste");
    });
    test("no meta + no prompt ⇒ refused", () => {
        const dir = mkdtempSync(join(tmpdir(), "freeze-nometa-"));
        const src = join(dir, "session.jsonl");
        writeFileSync(src, "{}\n");
        const root = mkdtempSync(join(tmpdir(), "freeze-root-"));
        const r = freezeFixture({
            source: src,
            usecase: "software-quality.debugging.error-message-paste",
            fixturesRoot: root,
        });
        expect(r).toBeNull();
    });
    test("no meta + inline prompt ⇒ synthesises meta", () => {
        const dir = mkdtempSync(join(tmpdir(), "freeze-syn-"));
        const src = join(dir, "session.jsonl");
        writeFileSync(src, "{}\n");
        const root = mkdtempSync(join(tmpdir(), "freeze-root-"));
        const r = freezeFixture({
            source: src,
            usecase: "software-quality.debugging.error-message-paste",
            fixturesRoot: root,
            prompt: "hello",
        });
        expect(r).not.toBeNull();
        if (r === null)
            return;
        const meta = JSON.parse(readFileSync(r.metaPath, "utf8"));
        expect(meta.userPrompt).toBe("hello");
    });
});
