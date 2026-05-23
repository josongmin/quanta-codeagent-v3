import { describe, expect, test } from "bun:test";
import { createSubagentRunner } from "../../src/agent/subagent-runner";
import { ToolRegistry } from "../../src/tool";
/**
 * Round 2 — `buildSeedPrompt` injection in `subagent-runner.ts`.
 *
 * The runner appends Codex-style boundary + output-shape blocks to the child's
 * seed user-message when `req.ownedSurfaces` / `req.forbiddenSurfaces` /
 * `req.resultShape` are set. With none of them set the seed text is BYTE-
 * IDENTICAL to `req.prompt` (preserves the legacy non-opt-in call path).
 * Order (intentional): prompt → owned → forbidden → resultShape.
 */
const at = (arr, i) => {
    const v = arr[i];
    if (v === undefined)
        throw new Error(`expected element at index ${i}`);
    return v;
};
const parentConfig = (over = {}) => ({
    // biome-ignore lint/suspicious/noExplicitAny: inert port stub
    llm: { stream: async function* () { } },
    registry: new ToolRegistry([]),
    stream: { emit: () => { } },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "PARENT" }] }],
    system: "PARENT",
    cwd: "/repo",
    maxTurns: 5,
    signal: new AbortController().signal,
    ...over,
});
const outcome = (over = {}) => ({
    reason: "completed",
    turns: 1,
    messages: [
        { role: "user", content: [{ type: "text", text: "x" }] },
        { role: "assistant", content: [{ type: "text", text: "y" }] },
    ],
    ...over,
});
const req = (over = {}) => ({
    prompt: "investigate the bug in foo.ts",
    depth: 1,
    ...over,
});
const capturing = () => {
    const seen = [];
    const run = (async (c) => {
        seen.push(c);
        return outcome();
    });
    return { run, seen };
};
/** Pluck the child's seed user-message text. The seed is always exactly one
 *  user message containing one text block (see `buildChildConfig`). */
const seedText = (child) => {
    const msgs = child.messages;
    expect(msgs).toHaveLength(1);
    const first = at(msgs, 0);
    expect(first.role).toBe("user");
    expect(first.content).toHaveLength(1);
    const block = first.content[0];
    if (!block || block.type !== "text")
        throw new Error("expected text block");
    return block.text;
};
describe("buildSeedPrompt — no opt-in", () => {
    test("none of the three fields set ⇒ seed is BYTE-IDENTICAL to req.prompt", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        const prompt = "do the thing\nwith multiple lines\nand 'punctuation' too";
        await runner(req({ prompt }));
        expect(seedText(at(seen, 0))).toBe(prompt);
    });
    test("empty arrays do NOT render a block (ownedSurfaces: [])", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        await runner(req({ ownedSurfaces: [], forbiddenSurfaces: [] }));
        const text = seedText(at(seen, 0));
        // No block markers anywhere.
        expect(text).toBe("investigate the bug in foo.ts");
        expect(text).not.toContain("**Owned surfaces**");
        expect(text).not.toContain("**Forbidden surfaces**");
    });
});
describe("buildSeedPrompt — individual augmentations", () => {
    test("resultShape set ⇒ seed appends `**Final answer format**: <shape>`", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        await runner(req({ resultShape: "JSON: {ok, summary}" }));
        const text = seedText(at(seen, 0));
        expect(text.startsWith("investigate the bug in foo.ts")).toBe(true);
        expect(text).toContain("**Final answer format**: JSON: {ok, summary}");
    });
    test("ownedSurfaces set ⇒ `**Owned surfaces**` block with `- ` per path", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        await runner(req({ ownedSurfaces: ["src/a.ts", "src/b.ts"] }));
        const text = seedText(at(seen, 0));
        expect(text).toContain("**Owned surfaces**");
        expect(text).toContain("- src/a.ts");
        expect(text).toContain("- src/b.ts");
    });
    test("forbiddenSurfaces set ⇒ `**Forbidden surfaces**` block with `- ` per path", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        await runner(req({ forbiddenSurfaces: ["node_modules/**", "dist/**"] }));
        const text = seedText(at(seen, 0));
        expect(text).toContain("**Forbidden surfaces**");
        expect(text).toContain("- node_modules/**");
        expect(text).toContain("- dist/**");
    });
});
describe("buildSeedPrompt — composition order", () => {
    test("all three set ⇒ order is prompt → owned → forbidden → resultShape", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        await runner(req({
            prompt: "PROMPT-MARK",
            ownedSurfaces: ["src/foo.ts"],
            forbiddenSurfaces: ["dist/**"],
            resultShape: "JSON: {ok}",
        }));
        const text = seedText(at(seen, 0));
        const iPrompt = text.indexOf("PROMPT-MARK");
        const iOwned = text.indexOf("**Owned surfaces**");
        const iForb = text.indexOf("**Forbidden surfaces**");
        const iShape = text.indexOf("**Final answer format**");
        expect(iPrompt).toBeGreaterThanOrEqual(0);
        expect(iOwned).toBeGreaterThan(iPrompt);
        expect(iForb).toBeGreaterThan(iOwned);
        expect(iShape).toBeGreaterThan(iForb);
    });
    test("only ownedSurfaces + resultShape ⇒ owned precedes shape; no forbidden block", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        await runner(req({ ownedSurfaces: ["src/a.ts"], resultShape: "one-liner: <result>" }));
        const text = seedText(at(seen, 0));
        expect(text).not.toContain("**Forbidden surfaces**");
        expect(text.indexOf("**Owned surfaces**")).toBeLessThan(text.indexOf("**Final answer format**"));
    });
});
/**
 * Round 3 — `priorAttempt` (Codex `resume_agent`) and `checkpointPath`
 * (Codex `checkpoint`) seed augmentations.
 *
 * `priorAttempt` PREPENDS a `## Previous attempt's findings\n<text>\n\n## Current task\n`
 * block BEFORE `req.prompt`. `checkpointPath` APPENDS a `**Checkpoint**: ...`
 * guidance block. Empty strings are treated as absent. With none of the five
 * fields set, the seed remains byte-identical to `req.prompt`.
 *
 * Full ordering when all are set:
 *   1. priorAttempt block (prepended ABOVE prompt)
 *   2. req.prompt
 *   3. ownedSurfaces block
 *   4. forbiddenSurfaces block
 *   5. checkpointPath block
 *   6. resultShape block
 */
describe("buildSeedPrompt — priorAttempt (resume_agent)", () => {
    test("priorAttempt set ⇒ seed STARTS with `## Previous attempt's findings\\n<text>\\n\\n## Current task\\n<prompt>`", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        const priorAttempt = "found that foo.ts had a null check missing on line 42";
        const prompt = "now also check bar.ts for the same pattern";
        await runner(req({ prompt, priorAttempt }));
        const text = seedText(at(seen, 0));
        const expectedStart = `## Previous attempt's findings\n${priorAttempt}\n\n## Current task\n${prompt}`;
        expect(text.startsWith(expectedStart)).toBe(true);
        // Prior-attempt header precedes the prompt body.
        expect(text.indexOf("## Previous attempt's findings")).toBe(0);
        expect(text.indexOf(prompt)).toBeGreaterThan(text.indexOf("## Current task"));
    });
    test("priorAttempt set to empty string ⇒ no prepend (treated as absent)", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        await runner(req({ priorAttempt: "" }));
        const text = seedText(at(seen, 0));
        expect(text).toBe("investigate the bug in foo.ts");
        expect(text).not.toContain("## Previous attempt's findings");
        expect(text).not.toContain("## Current task");
    });
});
describe("buildSeedPrompt — checkpointPath (checkpoint)", () => {
    test("checkpointPath set ⇒ seed contains `**Checkpoint**: Write your interim progress to \\`<path>\\`` AFTER req.prompt", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        const checkpointPath = "/repo/.subagent-state/task-abc.md";
        await runner(req({ checkpointPath }));
        const text = seedText(at(seen, 0));
        expect(text).toContain(`**Checkpoint**: Write your interim progress to \`${checkpointPath}\``);
        // Checkpoint block sits after the prompt body.
        expect(text.indexOf("**Checkpoint**")).toBeGreaterThan(text.indexOf("investigate the bug in foo.ts"));
    });
    test("checkpointPath set to empty string ⇒ no append (treated as absent)", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        await runner(req({ checkpointPath: "" }));
        const text = seedText(at(seen, 0));
        expect(text).toBe("investigate the bug in foo.ts");
        expect(text).not.toContain("**Checkpoint**");
    });
});
describe("buildSeedPrompt — full composition order (Round 3)", () => {
    test("all five fields set ⇒ order is priorAttempt → prompt → owned → forbidden → checkpoint → resultShape", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        await runner(req({
            prompt: "PROMPT-MARK",
            priorAttempt: "PRIOR-MARK",
            ownedSurfaces: ["src/foo.ts"],
            forbiddenSurfaces: ["dist/**"],
            checkpointPath: "/repo/.subagent-state/task-xyz.md",
            resultShape: "JSON: {ok}",
        }));
        const text = seedText(at(seen, 0));
        const iPrior = text.indexOf("## Previous attempt's findings");
        const iPrompt = text.indexOf("PROMPT-MARK");
        const iOwned = text.indexOf("**Owned surfaces**");
        const iForb = text.indexOf("**Forbidden surfaces**");
        const iCheckpoint = text.indexOf("**Checkpoint**");
        const iShape = text.indexOf("**Final answer format**");
        expect(iPrior).toBe(0);
        expect(iPrompt).toBeGreaterThan(iPrior);
        expect(iOwned).toBeGreaterThan(iPrompt);
        expect(iForb).toBeGreaterThan(iOwned);
        expect(iCheckpoint).toBeGreaterThan(iForb);
        expect(iShape).toBeGreaterThan(iCheckpoint);
    });
    test("regression: NONE of the five fields set ⇒ seed === req.prompt byte-identically", async () => {
        const { run, seen } = capturing();
        const runner = createSubagentRunner(parentConfig(), { run });
        const prompt = "literal prompt with\nnewlines\tand\ttabs and 'quotes'";
        await runner(req({ prompt }));
        expect(seedText(at(seen, 0))).toBe(prompt);
    });
});
