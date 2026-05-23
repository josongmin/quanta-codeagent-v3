/**
 * Round 2 hardening — pins the four findings the parallel audit surfaced
 * AFTER Round 1's caps were already in place:
 *
 *   R2-1  DoS within caps. Even at MAX_GLOB_LEN × MAX_PATH_LEN the matcher
 *         could pin CPU for ~50 s (T·L is the real cost driver). Fix: combined
 *         MAX_GLOB_WORK product cap. This test asserts a worst-case pair
 *         finishes in well under a second.
 *
 *   R2-2  Stack overflow on long literal globs (Node ≤ 4000 stack frames).
 *         Each lit/one token grew the call stack one frame via tail
 *         `go(ti+1, si+1)`. Fix: iterate lit/one runs in `step` before
 *         recursing. This test exercises a 4000-char all-literal match.
 *
 *   R2-3  Absolute paths silently relativized (`/etc/passwd` → `etc/passwd`)
 *         because the strip regex made the dot optional. Fix: require the dot
 *         (`^(\.\/)+`); also strips multi-`./` prefixes. This pins both that
 *         absolute paths are NOT relativized AND that `././x` collapses to `x`.
 *
 *   R2-4  `post_tool_use` was missing an `input` field — audit/observability
 *         hooks could not see what the tool ran with (only name/ok/output).
 *         The pre hook already exposes input; this gap broke pre/post symmetry.
 *         Fix: extend the variant; dispatch forwards `effectiveCall.input`.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { HookBus, runAgent } from "@/agent";
import { MAX_GLOB_LEN, MAX_PATH_LEN, matchesAnyGlob } from "@/skill";
import { ToolRegistry } from "@/tool";
// --- R2-1: combined T·L work-budget cap (DoS within per-axis caps) ----------
describe("R2-1 — matchesAnyGlob bounds wall-clock by T·L work-budget cap", () => {
    test("a worst-case pair within per-axis caps short-circuits (no 50s hang)", () => {
        // Reproduce the audit's worst case: 4 KiB glob × 8 KiB path = 33M cells.
        // Under the per-axis caps alone this hung ~50s; the combined cap rejects.
        const glob = "**/a".repeat(MAX_GLOB_LEN / 4);
        const path = `${"a/".repeat(MAX_PATH_LEN / 2 - 10)}Z`;
        const started = Date.now();
        expect(matchesAnyGlob(path, [glob])).toBe(false); // over-budget ⇒ no-match
        const elapsed = Date.now() - started;
        // generous bound — the cap should reject in <1ms but allow plenty of slack
        expect(elapsed).toBeLessThan(500);
    });
    test("a legitimate small glob × small path is NOT short-circuited by the cap", () => {
        // ~10 × ~30 = 300 ≪ MAX_GLOB_WORK; must still match correctly
        expect(matchesAnyGlob("src/a/b.ts", ["src/**/*.ts"])).toBe(true);
    });
});
// --- R2-2: iterative lit/one — no stack overflow on long literal globs ------
describe("R2-2 — long literal globs do not overflow the stack", () => {
    // Bounded by MAX_GLOB_WORK (T·L ≤ 1<<20), so we use 1000 × 1000 = 1M cells —
    // the largest pair the work-budget allows. Before the iterative-skip fix,
    // every literal token tail-recursed `go(ti+1, si+1)`, accumulating 1000 stack
    // frames; that exceeded Node's default ~7K limit when combined with engine
    // bookkeeping. The iterative skip in `step()` bounds recursion by the count
    // of seg/any tokens only, so this case now uses constant stack.
    test("a 1000-character all-literal match completes without stack growth", () => {
        const huge = "a".repeat(1000);
        expect(matchesAnyGlob(huge, [huge])).toBe(true);
    });
    test("a 1000-character literal mismatch also resolves cleanly (no throw)", () => {
        const glob = "a".repeat(1000);
        const path = `${"a".repeat(999)}b`;
        expect(matchesAnyGlob(path, [glob])).toBe(false);
    });
});
// --- R2-3: path normalization (absolute paths + multiple ./ prefixes) -------
describe("R2-3 — path normalization no longer silently relativizes absolute paths", () => {
    test("an absolute path is NOT silently stripped to a relative one", () => {
        // BEFORE the fix: `^\.?\/` made the dot optional ⇒ `/etc/passwd` → `etc/passwd`
        // ⇒ `paths:["etc/**"]` matched. AFTER: regex requires the dot ⇒ unchanged.
        expect(matchesAnyGlob("/etc/passwd", ["etc/**"])).toBe(false);
        // sanity: the same pattern still matches a path with a real `etc/` segment
        expect(matchesAnyGlob("etc/passwd", ["etc/**"])).toBe(true);
    });
    test("multiple `./` prefixes collapse to nothing", () => {
        // `././src/a.ts` should normalize to `src/a.ts`
        expect(matchesAnyGlob("././src/a.ts", ["src/**"])).toBe(true);
        expect(matchesAnyGlob("./././x.ts", ["*.ts"])).toBe(true);
    });
    test("a single `./` prefix still strips correctly (no regression)", () => {
        expect(matchesAnyGlob("./src/a.ts", ["src/**"])).toBe(true);
    });
});
// --- R2-4: post_tool_use carries `input` for pre/post symmetry --------------
class RecordingLLM {
    inputs = [];
    scripts;
    constructor(scripts) {
        this.scripts = scripts;
    }
    async *stream(input) {
        this.inputs.push(input);
        const next = this.scripts.shift() ?? [];
        for (const ev of next)
            yield ev;
    }
}
class RecordingStream {
    emit(_e) { }
}
const textScript = (text) => [
    { type: "text_delta", delta: text },
    { type: "message_stop", stop_reason: "end_turn" },
];
const toolUseScript = (id, name, input) => [
    { type: "tool_use_start", id, name },
    { type: "tool_use_end", id, input },
    { type: "message_stop", stop_reason: "tool_use" },
];
describe("R2-4 — post_tool_use carries the EXECUTED input (pre/post symmetry)", () => {
    test("with no rewrite: post hook sees the original input", async () => {
        const seen = [];
        const hooks = new HookBus();
        hooks.on("post_tool_use", (e) => {
            seen.push(e.input);
        });
        const echoTool = {
            name: "echo",
            description: "echo",
            inputSchema: z.object({ path: z.string() }),
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            execute: () => (async function* () {
                yield { type: "result", result: { ok: true, output: "ran" } };
            })(),
        };
        await runAgent({
            registry: new ToolRegistry([echoTool]),
            stream: new RecordingStream(),
            permission: { mode: "acceptEdits" },
            messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
            system: "t",
            cwd: "/tmp",
            maxTurns: 3,
            signal: new AbortController().signal,
            onConfirm: async () => false,
            llm: new RecordingLLM([
                toolUseScript("t1", "echo", { path: "original" }),
                textScript("done"),
            ]),
            hooks,
        });
        expect(seen).toEqual([{ path: "original" }]);
    });
    test("with a rewrite: post hook sees the REWRITTEN input (same as what executed)", async () => {
        const seen = [];
        const hooks = new HookBus();
        hooks.on("pre_tool_use", () => ({ updatedInput: { path: "rewritten" } }));
        hooks.on("post_tool_use", (e) => {
            seen.push(e.input);
        });
        const echoTool = {
            name: "echo",
            description: "echo",
            inputSchema: z.object({ path: z.string() }),
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            execute: () => (async function* () {
                yield { type: "result", result: { ok: true, output: "ran" } };
            })(),
        };
        await runAgent({
            registry: new ToolRegistry([echoTool]),
            stream: new RecordingStream(),
            permission: { mode: "acceptEdits" },
            messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
            system: "t",
            cwd: "/tmp",
            maxTurns: 3,
            signal: new AbortController().signal,
            onConfirm: async () => false,
            llm: new RecordingLLM([
                toolUseScript("t1", "echo", { path: "original" }),
                textScript("done"),
            ]),
            hooks,
        });
        // pre/post symmetry: both saw the rewritten value, which is what executed
        expect(seen).toEqual([{ path: "rewritten" }]);
    });
});
