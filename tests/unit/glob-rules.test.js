/**
 * File-scoped rule auto-injection (Cursor `.cursor/rules/*.mdc` parity).
 * Covers: loading + frontmatter parsing, the per-turn selection (alwaysApply ∪
 * glob-matched), rendering, symlink rejection, and the prompt integration that
 * lands the block in the per-turn `<system-reminder>`.
 *
 * Every test uses a fresh tmpdir.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTurnContext, loadGlobRules, renderGlobRulesBlock, selectGlobRules, } from "@/agent";
let root;
beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "glob-rules-"));
});
afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});
/** Create a workspace with rule files under `.cursor/rules`. */
const workspace = async (files, dir = ".cursor/rules") => {
    const cwd = await mkdtemp(join(root, "ws-"));
    const rulesDir = join(cwd, dir);
    await mkdir(rulesDir, { recursive: true });
    for (const f of files)
        await writeFile(join(rulesDir, f.name), f.content);
    return cwd;
};
describe("loadGlobRules", () => {
    test("absent rule dir ⇒ [] (byte-identical no-op)", async () => {
        const cwd = await mkdtemp(join(root, "empty-"));
        expect(await loadGlobRules(cwd)).toEqual([]);
    });
    test("parses globs (comma string), alwaysApply, and description", async () => {
        const cwd = await workspace([
            {
                name: "react.mdc",
                content: `---\ndescription: React conventions\nglobs: *.tsx, *.jsx\n---\nUse function components.`,
            },
            {
                name: "always.mdc",
                content: `---\nalwaysApply: true\n---\nNever commit secrets.`,
            },
        ]);
        const rules = await loadGlobRules(cwd);
        expect(rules).toHaveLength(2);
        const react = rules.find((r) => r.sourcePath.endsWith("react.mdc"));
        expect(react?.globs).toEqual(["*.tsx", "*.jsx"]);
        expect(react?.alwaysApply).toBe(false);
        expect(react?.description).toBe("React conventions");
        expect(react?.body).toBe("Use function components.");
        const always = rules.find((r) => r.sourcePath.endsWith("always.mdc"));
        expect(always?.alwaysApply).toBe(true);
        expect(always?.globs).toEqual([]);
    });
    test("parses array-form globs", async () => {
        const cwd = await workspace([
            { name: "arr.mdc", content: `---\nglobs: ["src/**", "*.ts"]\n---\nbody here` },
        ]);
        const rules = await loadGlobRules(cwd);
        expect(rules[0]?.globs).toEqual(["src/**", "*.ts"]);
    });
    test("drops a rule with neither globs nor alwaysApply (can never inject)", async () => {
        const cwd = await workspace([{ name: "inert.mdc", content: `---\ndescription: x\n---\nbody` }]);
        expect(await loadGlobRules(cwd)).toEqual([]);
    });
    test("drops a rule with an empty body", async () => {
        const cwd = await workspace([
            { name: "empty.mdc", content: `---\nalwaysApply: true\n---\n   ` },
        ]);
        expect(await loadGlobRules(cwd)).toEqual([]);
    });
    test("rejects a symlinked rule file (no secret exfil into the prompt)", async () => {
        const cwd = await mkdtemp(join(root, "symlink-"));
        const rulesDir = join(cwd, ".cursor/rules");
        await mkdir(rulesDir, { recursive: true });
        const secret = join(cwd, "secret.md");
        await writeFile(secret, `---\nalwaysApply: true\n---\nleaked`);
        await symlink(secret, join(rulesDir, "link.mdc"));
        expect(await loadGlobRules(cwd)).toEqual([]);
    });
    test("scans both .cursor/rules and .quanta/rules", async () => {
        const cwd = await workspace([{ name: "a.mdc", content: `---\nalwaysApply: true\n---\nA` }]);
        const quanta = join(cwd, ".quanta/rules");
        await mkdir(quanta, { recursive: true });
        await writeFile(join(quanta, "b.md"), `---\nalwaysApply: true\n---\nB`);
        const rules = await loadGlobRules(cwd);
        expect(rules.map((r) => r.body).sort()).toEqual(["A", "B"]);
    });
});
describe("selectGlobRules", () => {
    const rules = [
        { sourcePath: "/r/always.mdc", globs: [], alwaysApply: true, body: "ALWAYS" },
        { sourcePath: "/r/ts.mdc", globs: ["*.ts"], alwaysApply: false, body: "TS" },
        { sourcePath: "/r/docs.mdc", globs: ["docs/**"], alwaysApply: false, body: "DOCS" },
    ];
    test("alwaysApply rules ride regardless of changedPaths", () => {
        expect(selectGlobRules(rules, []).map((r) => r.body)).toEqual(["ALWAYS"]);
    });
    test("glob rule injects only when a changed path matches", () => {
        const sel = selectGlobRules(rules, ["src/index.ts"]).map((r) => r.body);
        expect(sel).toEqual(["ALWAYS", "TS"]);
    });
    test("nested glob (docs/**) matches a deep path", () => {
        const sel = selectGlobRules(rules, ["docs/guide/intro.md"]).map((r) => r.body);
        expect(sel).toEqual(["ALWAYS", "DOCS"]);
    });
    test("non-matching change ⇒ only alwaysApply", () => {
        expect(selectGlobRules(rules, ["README"]).map((r) => r.body)).toEqual(["ALWAYS"]);
    });
});
describe("renderGlobRulesBlock", () => {
    test("empty selection ⇒ undefined", () => {
        expect(renderGlobRulesBlock([])).toBeUndefined();
    });
    test("renders source basename + scope + body", () => {
        const block = renderGlobRulesBlock([
            { sourcePath: "/r/ts.mdc", globs: ["*.ts"], alwaysApply: false, body: "Use strict mode." },
        ]);
        expect(block).toContain("## File-scoped rules");
        expect(block).toContain("### ts.mdc (globs: *.ts)");
        expect(block).toContain("Use strict mode.");
    });
});
describe("buildTurnContext glob-rule integration", () => {
    const rules = [
        { sourcePath: "/r/ts.mdc", globs: ["*.ts"], alwaysApply: false, body: "TS-RULE-BODY" },
    ];
    const reminderOf = (ctx) => {
        const last = ctx.messages.at(-1);
        const block = last?.content?.[0];
        return block && "text" in block ? block.text : "";
    };
    test("a matching changedPath lands the rule body in the per-turn reminder", () => {
        const ctx = buildTurnContext({
            baseMessages: [],
            cwd: "/repo",
            globRules: rules,
            changedPaths: ["src/a.ts"],
        });
        expect(reminderOf(ctx)).toContain("TS-RULE-BODY");
    });
    test("no matching changedPath ⇒ rule body absent (no block)", () => {
        const ctx = buildTurnContext({
            baseMessages: [],
            cwd: "/repo",
            globRules: rules,
            changedPaths: ["README.md"],
        });
        expect(reminderOf(ctx)).not.toContain("TS-RULE-BODY");
    });
    test("absent globRules ⇒ byte-identical (no File-scoped rules section)", () => {
        const ctx = buildTurnContext({ baseMessages: [], cwd: "/repo" });
        expect(reminderOf(ctx)).not.toContain("File-scoped rules");
    });
});
