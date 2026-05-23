import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "@/tool/edit";
import { classifyMismatch, EDIT_MISMATCH_MARKER_PREFIX, formatEditMismatchMarker, formatStrategyHint, parseKindFromText, STRATEGY_HINT_PREFIX, } from "@/tool/edit/strategy-hint";
const dir = mkdtempSync(join(tmpdir(), "edit-strategy-hint-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ctx = (cwd) => ({
    cwd,
    signal: new AbortController().signal,
});
const run = async (input) => {
    let result;
    for await (const ev of editTool.execute(input, ctx(dir))) {
        if (ev.type === "result")
            result = ev.result;
    }
    if (!result)
        throw new Error("no result");
    return result;
};
/**
 * CONTRACT: every {@link EditMismatchKind} maps to a known {@link NextStrategy}.
 * Adding a new `EditMismatchKind` is a compile-time obligation on
 * `classifyMismatch`'s switch; adding it to this table forces the runtime
 * routing to be reviewed too. The two tables together are the spec.
 */
const KIND_TO_STRATEGY = {
    "not-found": "read_then_patch",
    ambiguous: "scripted_replace",
    "fuzzy-no-confident": "read_then_patch",
};
describe("classifyMismatch (structural — preferred path)", () => {
    test("every EditMismatchKind routes to its expected NextStrategy", () => {
        for (const [kind, expected] of Object.entries(KIND_TO_STRATEGY)) {
            expect(classifyMismatch({ kind })).toBe(expected);
        }
    });
});
describe("classifyMismatch (text fallback — legacy + marker)", () => {
    test("'not unique' ⇒ scripted_replace (legacy substring)", () => {
        expect(classifyMismatch("old_string is not unique (3 matches); pass replace_all")).toBe("scripted_replace");
    });
    test("fuzzy 'ambiguous' ⇒ scripted_replace (legacy substring)", () => {
        expect(classifyMismatch("whitespace-flexible matched 2 spans; ambiguous (...)")).toBe("scripted_replace");
    });
    test("'not found' ⇒ read_then_patch (legacy substring)", () => {
        expect(classifyMismatch("old_string not found in file")).toBe("read_then_patch");
    });
    test("'no confident match' ⇒ read_then_patch (legacy substring)", () => {
        expect(classifyMismatch("no confident match (exact, whitespace-flexible, ...)")).toBe("read_then_patch");
    });
    test("unrecognized message ⇒ ambiguous fallback (we still emit a hint)", () => {
        expect(classifyMismatch("some other failure mode")).toBe("ambiguous");
    });
    test("in-text marker is parsed even when prose is unrecognizable", () => {
        // The marker is the load-bearing channel: even a fully reworded message
        // still classifies correctly as long as the marker is present.
        expect(classifyMismatch("totally different prose [edit-mismatch:not-found]")).toBe("read_then_patch");
        expect(classifyMismatch("totally different prose [edit-mismatch:ambiguous]")).toBe("scripted_replace");
        expect(classifyMismatch("totally different prose [edit-mismatch:fuzzy-no-confident]")).toBe("read_then_patch");
    });
});
describe("parseKindFromText", () => {
    test("recovers the kind from the marker for every EditMismatchKind", () => {
        for (const kind of Object.keys(KIND_TO_STRATEGY)) {
            const marker = formatEditMismatchMarker(kind);
            expect(marker.startsWith(EDIT_MISMATCH_MARKER_PREFIX)).toBe(true);
            expect(parseKindFromText(`prose ${marker} more prose`)).toBe(kind);
        }
    });
    test("returns undefined for prose with no signal at all", () => {
        expect(parseKindFromText("just some unrelated text")).toBeUndefined();
    });
});
describe("formatStrategyHint", () => {
    test("each strategy renders a prefixed, parseable hint", () => {
        for (const s of ["scripted_replace", "read_then_patch", "ambiguous"]) {
            const text = formatStrategyHint(s);
            expect(text.startsWith(STRATEGY_HINT_PREFIX)).toBe(true);
            expect(text).toContain(`nextStrategy: ${s}`);
        }
    });
    test("scripted_replace hint specifically names the tool by name", () => {
        expect(formatStrategyHint("scripted_replace")).toMatch(/scripted_replace/);
    });
    test("read_then_patch hint names the remediation (re-read)", () => {
        expect(formatStrategyHint("read_then_patch")).toMatch(/read/i);
    });
});
/** End-to-end contract: editTool must emit a marker for every
 *  {@link EditMismatchKind} on its corresponding failure path. This is the
 *  test that catches a divergence between the producer (exact.ts/fuzzy.ts)
 *  and the consumer (strategy-hint.ts) — if a future commit forgets to
 *  attach `kind` on a failure path, this test fails. */
describe("editTool emits structural EditMismatchKind on each failure path", () => {
    test("'old_string not found' ⇒ kind=not-found marker + read_then_patch hint", async () => {
        const f = join(dir, "not-found.txt");
        writeFileSync(f, "alpha beta");
        const r = await run({ path: f, old_string: "gamma", new_string: "delta" });
        expect(r.ok).toBe(false);
        expect(r.output).toContain("old_string not found in file");
        expect(r.output).toContain(formatEditMismatchMarker("not-found"));
        expect(r.output).toContain(STRATEGY_HINT_PREFIX);
        expect(r.output).toContain("nextStrategy: read_then_patch");
    });
    test("multiple exact matches ⇒ kind=ambiguous marker + scripted_replace hint", async () => {
        const f = join(dir, "dupe.txt");
        writeFileSync(f, "x x x");
        const r = await run({ path: f, old_string: "x", new_string: "y" });
        expect(r.ok).toBe(false);
        expect(r.output).toContain("not unique");
        expect(r.output).toContain(formatEditMismatchMarker("ambiguous"));
        expect(r.output).toContain(STRATEGY_HINT_PREFIX);
        expect(r.output).toContain("nextStrategy: scripted_replace");
    });
    test("fuzzy ambiguous spans ⇒ kind=ambiguous marker + scripted_replace hint", async () => {
        const f = join(dir, "fuzzy-ambig.txt");
        // Two whitespace-equivalent line windows so the fuzzy ladder is forced
        // and reports the ambiguous match.
        writeFileSync(f, "  foo bar\n  baz\n\nfoo  bar\n  baz\n");
        const r = await run({
            path: f,
            old_string: "foo bar\nbaz",
            new_string: "REPLACED",
            fuzzy: true,
        });
        expect(r.ok).toBe(false);
        expect(r.output).toContain(formatEditMismatchMarker("ambiguous"));
        expect(r.output).toContain(STRATEGY_HINT_PREFIX);
        expect(r.output).toContain("nextStrategy: scripted_replace");
    });
    test("fuzzy ladder exhausted ⇒ kind=fuzzy-no-confident marker + read_then_patch hint", async () => {
        const f = join(dir, "fuzzy-noconf.txt");
        // A file where neither exact nor whitespace-flexible nor anchored-trim
        // matches the old_string at all.
        writeFileSync(f, "alpha beta gamma\n");
        const r = await run({
            path: f,
            old_string: "completely unrelated content that won't match",
            new_string: "REPLACED",
            fuzzy: true,
        });
        expect(r.ok).toBe(false);
        expect(r.output).toContain("no confident match");
        expect(r.output).toContain(formatEditMismatchMarker("fuzzy-no-confident"));
        expect(r.output).toContain(STRATEGY_HINT_PREFIX);
        expect(r.output).toContain("nextStrategy: read_then_patch");
    });
    test("successful patch does NOT include the hint or marker", async () => {
        const f = join(dir, "ok.txt");
        writeFileSync(f, "const a = 1");
        const r = await run({ path: f, old_string: "1", new_string: "2" });
        expect(r.ok).toBe(true);
        expect(r.output).not.toContain(STRATEGY_HINT_PREFIX);
        expect(r.output).not.toContain(EDIT_MISMATCH_MARKER_PREFIX);
    });
});
