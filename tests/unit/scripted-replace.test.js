import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyScriptedReplace, scriptedReplaceTool } from "@/tool/scripted-replace";
const dir = mkdtempSync(join(tmpdir(), "scripted-replace-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ctx = (cwd) => ({
    cwd,
    signal: new AbortController().signal,
});
const run = async (input, cwd = dir) => {
    let result;
    for await (const ev of scriptedReplaceTool.execute(input, ctx(cwd))) {
        if (ev.type === "result")
            result = ev.result;
    }
    if (!result)
        throw new Error("no result");
    return result;
};
describe("scriptedReplaceTool metadata", () => {
    test("name + flags", () => {
        expect(scriptedReplaceTool.name).toBe("scripted_replace");
        expect(scriptedReplaceTool.isReadOnly()).toBe(false);
        expect(scriptedReplaceTool.isConcurrencySafe({
            file: "x",
            pattern: "a",
            replacement: "b",
        })).toBe(false);
    });
});
describe("applyScriptedReplace (pure core)", () => {
    test("literal substring replaces every occurrence by default", () => {
        const r = applyScriptedReplace("foo bar foo baz foo", {
            pattern: "foo",
            replacement: "qux",
        });
        expect(r.ok).toBe(true);
        expect(r.next).toBe("qux bar qux baz qux");
        expect(r.replacements).toBe(3);
    });
    test("count caps the replacement number", () => {
        const r = applyScriptedReplace("foo foo foo foo", {
            pattern: "foo",
            replacement: "X",
            count: 2,
        });
        expect(r.ok).toBe(true);
        expect(r.next).toBe("X X foo foo");
        expect(r.replacements).toBe(2);
    });
    test("regex mode honours capture groups in replacement", () => {
        const r = applyScriptedReplace("foo_1 foo_22 foo_333", {
            pattern: "foo_(\\d+)",
            replacement: "bar_$1",
            isRegex: true,
        });
        expect(r.ok).toBe(true);
        expect(r.next).toBe("bar_1 bar_22 bar_333");
        expect(r.replacements).toBe(3);
    });
    test("regex mode supports $& whole-match expansion", () => {
        const r = applyScriptedReplace("apple banana cherry", {
            pattern: "\\w+",
            replacement: "<$&>",
            isRegex: true,
        });
        expect(r.ok).toBe(true);
        expect(r.next).toBe("<apple> <banana> <cherry>");
    });
    test("literal mode escapes regex metacharacters", () => {
        const r = applyScriptedReplace("a.b a.b a+b", {
            pattern: "a.b",
            replacement: "X",
        });
        // `.` should NOT act as a wildcard — literal mode escapes it.
        expect(r.ok).toBe(true);
        expect(r.next).toBe("X X a+b");
        expect(r.replacements).toBe(2);
    });
    test("empty pattern is rejected", () => {
        const r = applyScriptedReplace("hello", { pattern: "", replacement: "x" });
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/must not be empty/);
    });
    test("invalid regex is rejected with a clear message", () => {
        const r = applyScriptedReplace("hello", {
            pattern: "(unclosed",
            replacement: "x",
            isRegex: true,
        });
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/invalid regex/);
    });
    test("no match ⇒ ok:false with a clear message", () => {
        const r = applyScriptedReplace("hello", { pattern: "world", replacement: "x" });
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/not found/);
        expect(r.next).toBeUndefined();
    });
    test("$$ escapes a literal dollar", () => {
        const r = applyScriptedReplace("price=10", {
            pattern: "10",
            replacement: "$$10",
            isRegex: true,
        });
        expect(r.ok).toBe(true);
        expect(r.next).toBe("price=$10");
    });
    // SECURITY: catastrophic-backtracking patterns must be rejected by the
    // static sanity check BEFORE compilation. A pattern like `(a+)+$` is
    // syntactically valid but pumps backtracking exponentially on non-matching
    // input — sending it through `new RegExp(...).exec(...)` can hang the
    // agent turn. We reject patterns that match the nested-quantifier shape.
    describe("ReDoS guard (static sanity check)", () => {
        test("rejects nested unbounded quantifier `(a+)+$`", () => {
            const r = applyScriptedReplace("ignored", {
                pattern: "(a+)+$",
                replacement: "x",
                isRegex: true,
            });
            expect(r.ok).toBe(false);
            expect(r.message).toMatch(/catastrophic-backtracking/i);
        });
        test("rejects `(a*)*` and `(a+)+?`", () => {
            const a = applyScriptedReplace("x", {
                pattern: "(a*)*",
                replacement: "y",
                isRegex: true,
            });
            expect(a.ok).toBe(false);
            const b = applyScriptedReplace("x", {
                pattern: "(a+)+?",
                replacement: "y",
                isRegex: true,
            });
            expect(b.ok).toBe(false);
        });
        test("rejects a 257-char pattern (length cap)", () => {
            const r = applyScriptedReplace("x", {
                pattern: "a".repeat(257),
                replacement: "y",
                isRegex: true,
            });
            expect(r.ok).toBe(false);
            expect(r.message).toMatch(/catastrophic-backtracking|256/i);
        });
        test("literal-mode patterns are NOT checked (the source is escaped)", () => {
            // Even with the nested-quantifier shape in the literal substring, the
            // literal path escapes every metachar so the engine sees an inert
            // regex. The sanity check is only for regex mode.
            const r = applyScriptedReplace("(a+)+$ is literal", {
                pattern: "(a+)+$",
                replacement: "x",
            });
            expect(r.ok).toBe(true);
            expect(r.next).toBe("x is literal");
        });
        test("benign regexes with single quantifiers are not flagged", () => {
            const r = applyScriptedReplace("foo_123", {
                pattern: "foo_(\\d+)",
                replacement: "bar_$1",
                isRegex: true,
            });
            expect(r.ok).toBe(true);
        });
        // Round 2: alternation-with-overlap ReDoS — `(a|a)+`, `(a|a)*b`,
        // `(\w|\d)+x`. Catastrophic-backtracking is driven by overlapping
        // alternatives under an unbounded quantifier, NOT by an inner quantifier.
        // The Round 1 heuristic missed this; the Round 2 heuristic adds a
        // separate rule for `(…|…)<quantifier>`.
        test("rejects alternation-with-overlap `(a|a)+`", () => {
            const r = applyScriptedReplace("a".repeat(20), {
                pattern: "(a|a)+",
                replacement: "x",
                isRegex: true,
            });
            expect(r.ok).toBe(false);
            expect(r.message).toMatch(/catastrophic-backtracking/i);
        });
        test("rejects alternation-with-overlap `(a|a)*b` and `(\\w|\\d)+x`", () => {
            const a = applyScriptedReplace("xx", {
                pattern: "(a|a)*b",
                replacement: "y",
                isRegex: true,
            });
            expect(a.ok).toBe(false);
            const b = applyScriptedReplace("xx", {
                pattern: "(\\w|\\d)+x",
                replacement: "y",
                isRegex: true,
            });
            expect(b.ok).toBe(false);
        });
        test("benign alternation without unbounded quantifier is NOT flagged", () => {
            // `(a|b)` alone is fine; `(a|b)?` (bounded) is fine.
            const a = applyScriptedReplace("apple", {
                pattern: "(a|b)",
                replacement: "X",
                isRegex: true,
            });
            expect(a.ok).toBe(true);
            const b = applyScriptedReplace("apple", {
                pattern: "(a|b)?",
                replacement: "X",
                isRegex: true,
            });
            expect(b.ok).toBe(true);
        });
    });
    describe("ReDoS guard — heuristic alone is the defense", () => {
        // The earlier `applyScriptedReplaceBounded` wrapper was removed: a sync
        // regex pins the event loop, so the racing setTimeout never fires (the
        // "timeout" only resolved cases where the engine was already returning
        // quickly). The static `isReDoSSuspicious` heuristic + MAX_PATTERN_LEN
        // cap are now the entire defense — see scripted-replace.ts module note.
        test("catastrophic-backtracking pattern is rejected by the static heuristic", () => {
            const source = `${"a".repeat(40)}X`;
            const r = applyScriptedReplace(source, {
                pattern: "(a+)+$",
                replacement: "y",
                isRegex: true,
            });
            expect(r.ok).toBe(false);
            expect(r.message).toMatch(/catastrophic-backtracking/i);
        });
        test("benign pattern completes in the synchronous path", () => {
            const r = applyScriptedReplace("foo bar foo", {
                pattern: "foo",
                replacement: "X",
            });
            expect(r.ok).toBe(true);
            expect(r.next).toBe("X bar X");
        });
    });
    // Native JS semantics: `$N` where N is OUT OF RANGE (e.g. `$5` for a
    // regex with two groups) must stay LITERAL. The prior Codex-style
    // "out-of-range = empty" behaviour surprised callers used to the
    // standard. In-range-but-didn't-participate still maps to empty string
    // (native behaviour).
    describe("$N capture-group expansion (native JS semantics)", () => {
        test("`$5` out-of-range stays literal `$5`", () => {
            const r = applyScriptedReplace("hello", {
                pattern: "h(e)(l)lo",
                replacement: "[$1][$2][$5]",
                isRegex: true,
            });
            expect(r.ok).toBe(true);
            expect(r.next).toBe("[e][l][$5]");
        });
        test("`$N` in-range but group didn't participate ⇒ empty string", () => {
            const r = applyScriptedReplace("a", {
                pattern: "(a)|(b)",
                replacement: "[$1][$2]",
                isRegex: true,
            });
            expect(r.ok).toBe(true);
            // The `(b)` group didn't participate — JS native renders empty there.
            expect(r.next).toBe("[a][]");
        });
        test("`$9` out-of-range stays literal when regex has only one group", () => {
            const r = applyScriptedReplace("foo_1", {
                pattern: "foo_(\\d+)",
                replacement: "$1:$9",
                isRegex: true,
            });
            expect(r.ok).toBe(true);
            expect(r.next).toBe("1:$9");
        });
    });
});
describe("scriptedReplaceTool integration (FS)", () => {
    test("literal substring replacement, all occurrences", async () => {
        const f = join(dir, "lit-all.txt");
        writeFileSync(f, "foo bar foo baz foo");
        const r = await run({ file: f, pattern: "foo", replacement: "qux" });
        expect(r.ok).toBe(true);
        expect(r.output).toContain("Replaced 3 occurrence(s)");
        expect(r.output).toContain("replacements=3");
        expect(readFileSync(f, "utf8")).toBe("qux bar qux baz qux");
    });
    test("literal with count: 2 limits replacements", async () => {
        const f = join(dir, "lit-cap.txt");
        writeFileSync(f, "foo foo foo foo");
        const r = await run({ file: f, pattern: "foo", replacement: "X", count: 2 });
        expect(r.ok).toBe(true);
        expect(readFileSync(f, "utf8")).toBe("X X foo foo");
        expect(r.output).toContain("replacements=2");
    });
    test("regex mode with capture-group replacement", async () => {
        const f = join(dir, "regex.txt");
        writeFileSync(f, "foo_1 + foo_22 + foo_333");
        const r = await run({
            file: f,
            pattern: "foo_(\\d+)",
            replacement: "bar_$1",
            isRegex: true,
        });
        expect(r.ok).toBe(true);
        expect(readFileSync(f, "utf8")).toBe("bar_1 + bar_22 + bar_333");
    });
    test("file missing → error result, no write", async () => {
        const f = join(dir, "does-not-exist.txt");
        const r = await run({ file: f, pattern: "foo", replacement: "x" });
        expect(r.ok).toBe(false);
        expect(r.output).toMatch(/File not found/);
        expect(existsSync(f)).toBe(false);
    });
    test("pattern doesn't match → error result with clear message, file unchanged", async () => {
        const f = join(dir, "no-match.txt");
        writeFileSync(f, "hello world");
        const r = await run({ file: f, pattern: "absent_token", replacement: "x" });
        expect(r.ok).toBe(false);
        expect(r.output).toMatch(/not found/);
        expect(readFileSync(f, "utf8")).toBe("hello world");
    });
    test("FS jail blocks paths outside cwd", async () => {
        // Create a jail subdir, target a sibling OUTSIDE it.
        const jail = mkdtempSync(join(tmpdir(), "scripted-replace-jail-"));
        const outside = mkdtempSync(join(tmpdir(), "scripted-replace-outside-"));
        const victim = join(outside, "secret.txt");
        writeFileSync(victim, "original-content");
        try {
            // Ensure the jail enforcement is on (default-on, but be explicit).
            const prev = process.env.QUANTA_FS_JAIL;
            delete process.env.QUANTA_FS_JAIL;
            const r = await run({ file: victim, pattern: "original", replacement: "x" }, jail);
            expect(r.ok).toBe(false);
            expect(r.output).toMatch(/jail/i);
            // Victim file is byte-identical.
            expect(readFileSync(victim, "utf8")).toBe("original-content");
            if (prev !== undefined)
                process.env.QUANTA_FS_JAIL = prev;
        }
        finally {
            rmSync(jail, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });
    test("relative path resolves against ctx.cwd", async () => {
        writeFileSync(join(dir, "rel.txt"), "alpha beta alpha");
        const r = await run({ file: "rel.txt", pattern: "alpha", replacement: "gamma" });
        expect(r.ok).toBe(true);
        expect(readFileSync(join(dir, "rel.txt"), "utf8")).toBe("gamma beta gamma");
    });
    test("schema rejects non-positive count", () => {
        expect(scriptedReplaceTool.inputSchema.safeParse({
            file: "f",
            pattern: "x",
            replacement: "y",
            count: 0,
        }).success).toBe(false);
        expect(scriptedReplaceTool.inputSchema.safeParse({
            file: "f",
            pattern: "x",
            replacement: "y",
            count: -1,
        }).success).toBe(false);
    });
});
describe("scriptedReplaceTool typed failure.mode (absorb #2)", () => {
    test("missing file → failure.mode not_found with path", async () => {
        const f = join(dir, "ghost-typed.txt");
        const r = await run({ file: f, pattern: "foo", replacement: "x" });
        expect(r.ok).toBe(false);
        expect(r.failure).toEqual({ mode: "not_found", path: f });
        // Human-readable output preserved alongside the typed failure.
        expect(r.output).toMatch(/File not found/);
    });
    test("pattern-not-found → failure.mode not_found (no path: file exists)", async () => {
        const f = join(dir, "no-match-typed.txt");
        writeFileSync(f, "hello world");
        const r = await run({ file: f, pattern: "absent_token", replacement: "x" });
        expect(r.ok).toBe(false);
        expect(r.failure).toEqual({ mode: "not_found" });
        expect(r.output).toMatch(/not found/);
    });
    test("rejected pattern (empty) → failure.mode rejected with reason", async () => {
        const f = join(dir, "reject-typed.txt");
        writeFileSync(f, "abc");
        const r = await run({ file: f, pattern: "", replacement: "x" });
        expect(r.ok).toBe(false);
        expect(r.failure?.mode).toBe("rejected");
        if (r.failure?.mode === "rejected")
            expect(r.failure.reason).toMatch(/pattern must not be empty/);
    });
    test("FS jail → failure.mode permission_denied with isReadonly:false", async () => {
        const jail = mkdtempSync(join(tmpdir(), "scripted-replace-jail-typed-"));
        const outside = mkdtempSync(join(tmpdir(), "scripted-replace-outside-typed-"));
        const victim = join(outside, "secret.txt");
        writeFileSync(victim, "original-content");
        try {
            const prev = process.env.QUANTA_FS_JAIL;
            delete process.env.QUANTA_FS_JAIL;
            const r = await run({ file: victim, pattern: "original", replacement: "x" }, jail);
            expect(r.ok).toBe(false);
            expect(r.failure).toEqual({ mode: "permission_denied", path: victim, isReadonly: false });
            if (prev !== undefined)
                process.env.QUANTA_FS_JAIL = prev;
        }
        finally {
            rmSync(jail, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });
});
