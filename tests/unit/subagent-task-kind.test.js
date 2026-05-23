import { describe, expect, test } from "bun:test";
import { createAgentTool, } from "../../src/subagent";
/**
 * Round 2 — task_kind ⇒ default toolFilter derivation in `agent-tool.ts`.
 *
 * `buildRequest` consults `deriveToolFilter(task_kind)` ONLY when `tools` is
 * absent. An explicit `tools` ALWAYS wins. The four new structured fields
 * (`taskKind`/`resultShape`/`ownedSurfaces`/`forbiddenSurfaces`) must also
 * thread byte-for-byte from the tool input onto the SubagentRequest.
 */
const ctxAt = (depth) => ({
    cwd: "/tmp",
    signal: new AbortController().signal,
    ...(depth !== undefined ? { depth } : {}),
});
const run = async (tool, input, ctx) => {
    let last;
    for await (const ev of tool.execute(input, ctx))
        last = ev;
    if (!last)
        throw new Error("tool yielded no events");
    return last;
};
const result = (r = {}) => ({
    ok: true,
    finalText: "done",
    turns: 1,
    ...r,
});
/** Build a runner that captures the SubagentRequest it observes, exposing it
 *  via `seen()` (single-shot capture; the runner resolves the next tick). */
const capturingRunner = () => {
    let captured;
    const runner = async (req) => {
        captured = req;
        return result();
    };
    return { runner, seen: () => captured };
};
// Canonical sets mirrored from `agent-tool.ts#deriveToolFilter`. Pinned here
// so a silent drift in the source set fails this test loudly.
const READ_SET = [
    "read",
    "grep",
    "glob",
    "lsp_references",
    "lsp_document_symbol",
    "lsp_workspace_symbol",
    "diagnostics",
    "localize",
];
const EDIT_SET = [...READ_SET, "write", "edit", "bash"];
const REVIEW_SET = [
    "read",
    "grep",
    "glob",
    "lsp_references",
    "lsp_document_symbol",
    "lsp_workspace_symbol",
    "diagnostics",
];
describe("createAgentTool — task_kind ⇒ default toolFilter", () => {
    test('task_kind: "read" with no `tools` ⇒ toolFilter is the read-only set', async () => {
        const { runner, seen } = capturingRunner();
        const tool = createAgentTool({ runner });
        await run(tool, { prompt: "explore", task_kind: "read" }, ctxAt(0));
        expect(seen()?.toolFilter).toEqual(READ_SET);
    });
    test('task_kind: "edit" with no `tools` ⇒ toolFilter includes write/edit/bash', async () => {
        const { runner, seen } = capturingRunner();
        const tool = createAgentTool({ runner });
        await run(tool, { prompt: "patch", task_kind: "edit" }, ctxAt(0));
        expect(seen()?.toolFilter).toEqual(EDIT_SET);
        // Strong invariant: the edit set is a strict superset of the read set.
        expect(seen()?.toolFilter).toEqual(expect.arrayContaining(READ_SET));
        expect(seen()?.toolFilter).toContain("write");
        expect(seen()?.toolFilter).toContain("edit");
        expect(seen()?.toolFilter).toContain("bash");
    });
    test('task_kind: "review" with no `tools` ⇒ strict read-only subset (excludes localize)', async () => {
        const { runner, seen } = capturingRunner();
        const tool = createAgentTool({ runner });
        await run(tool, { prompt: "critique", task_kind: "review" }, ctxAt(0));
        const tf = seen()?.toolFilter;
        expect(tf).toEqual(REVIEW_SET);
        // Review is a strict subset of read (no localize, no writers).
        expect(tf).not.toContain("localize");
        expect(tf).not.toContain("write");
        expect(tf).not.toContain("edit");
        expect(tf).not.toContain("bash");
        // Subset relation: every review-set entry is in the read set.
        for (const name of tf ?? [])
            expect(READ_SET).toContain(name);
    });
    test('task_kind: "read" WITH explicit `tools: ["read"]` ⇒ explicit wins; toolFilter is ["read"]', async () => {
        const { runner, seen } = capturingRunner();
        const tool = createAgentTool({ runner });
        await run(tool, { prompt: "explore", task_kind: "read", tools: ["read"] }, ctxAt(0));
        expect(seen()?.toolFilter).toEqual(["read"]);
    });
    test("task_kind absent + no `tools` ⇒ toolFilter is undefined (inherit parent registry)", async () => {
        const { runner, seen } = capturingRunner();
        const tool = createAgentTool({ runner });
        await run(tool, { prompt: "go" }, ctxAt(0));
        expect(seen()?.toolFilter).toBeUndefined();
    });
});
describe("createAgentTool — new structured fields thread byte-for-byte", () => {
    test("taskKind/resultShape/ownedSurfaces/forbiddenSurfaces propagate verbatim", async () => {
        const { runner, seen } = capturingRunner();
        const tool = createAgentTool({ runner });
        await run(tool, {
            prompt: "investigate X and write a summary",
            task_kind: "review",
            result_shape: "JSON: {ok, summary, files[]}",
            owned_surfaces: ["src/foo.ts", "src/bar.ts"],
            forbidden_surfaces: ["node_modules/**", "dist/**"],
        }, ctxAt(0));
        const r = seen();
        expect(r?.taskKind).toBe("review");
        expect(r?.resultShape).toBe("JSON: {ok, summary, files[]}");
        expect(r?.ownedSurfaces).toEqual(["src/foo.ts", "src/bar.ts"]);
        expect(r?.forbiddenSurfaces).toEqual(["node_modules/**", "dist/**"]);
    });
    test("absent structured fields are OMITTED (not undefined) on the request", async () => {
        const { runner, seen } = capturingRunner();
        const tool = createAgentTool({ runner });
        await run(tool, { prompt: "go" }, ctxAt(0));
        const r = seen();
        expect(r).toBeDefined();
        expect("taskKind" in r).toBe(false);
        expect("resultShape" in r).toBe(false);
        expect("ownedSurfaces" in r).toBe(false);
        expect("forbiddenSurfaces" in r).toBe(false);
        // Sanity: prompt+depth still present.
        expect(r?.prompt).toBe("go");
        expect(r?.depth).toBe(1);
    });
    test("only some structured fields set ⇒ others omitted (exactOptionalPropertyTypes)", async () => {
        const { runner, seen } = capturingRunner();
        const tool = createAgentTool({ runner });
        await run(tool, { prompt: "go", result_shape: "one-liner: <result>" }, ctxAt(0));
        const r = seen();
        expect(r?.resultShape).toBe("one-liner: <result>");
        expect("ownedSurfaces" in r).toBe(false);
        expect("forbiddenSurfaces" in r).toBe(false);
        expect("taskKind" in r).toBe(false);
    });
});
