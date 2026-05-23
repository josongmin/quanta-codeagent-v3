import { describe, expect, test } from "bun:test";
import { isExemptFromFc, parseDiffNameStatus, runCheckChanged, } from "../../tools/feature-catalog/check-changed";
function feature(code) {
    return {
        id: "x",
        title: "x",
        section: 1,
        subsystem: "x",
        order: 0,
        maturity: "L4",
        status: "stable",
        purpose: "x",
        evidence: { code: code.slice(), adrs: [], tests: { unit: [], integration: [], contract: [] } },
        knobs: [],
        deliberate_hold: null,
    };
}
const f = (code) => ({ feature: feature(code), path: "x.yaml" });
describe("isExemptFromFc", () => {
    test("test files are exempt", () => {
        expect(isExemptFromFc("tests/unit/foo.test.ts")).toBe(true);
        expect(isExemptFromFc("src/foo.test.ts")).toBe(true);
        expect(isExemptFromFc("src/foo.spec.ts")).toBe(true);
    });
    test("barrel index.ts is exempt", () => {
        expect(isExemptFromFc("src/foo/index.ts")).toBe(true);
    });
    test("d.ts files are exempt", () => {
        expect(isExemptFromFc("src/foo.d.ts")).toBe(true);
    });
    test("docs / scripts / worktrees / fc-tool itself are exempt", () => {
        expect(isExemptFromFc("docs/foo.md")).toBe(true);
        expect(isExemptFromFc("scripts/foo.ts")).toBe(true);
        expect(isExemptFromFc(".claude/worktrees/agent-abc/src/foo.ts")).toBe(true);
        expect(isExemptFromFc("tools/feature-catalog/audit.ts")).toBe(true);
    });
    test("non-.ts files are exempt (covered by extension check)", () => {
        expect(isExemptFromFc("src/foo.json")).toBe(true);
        expect(isExemptFromFc("README.md")).toBe(true);
    });
    test("regular src/.ts files are NOT exempt", () => {
        expect(isExemptFromFc("src/agent/loop.ts")).toBe(false);
        expect(isExemptFromFc("src/tool/edit/exact.ts")).toBe(false);
    });
});
describe("runCheckChanged", () => {
    test("ADDED src file referenced in fc passes", () => {
        const diff = [{ path: "src/foo.ts", status: "A" }];
        const result = runCheckChanged(diff, [f(["src/foo.ts"])]);
        expect(result.ok).toBe(true);
        expect(result.addedUntracked).toEqual([]);
    });
    test("ADDED src file NOT in fc blocks", () => {
        const diff = [{ path: "src/foo.ts", status: "A" }];
        const result = runCheckChanged(diff, [f(["src/other.ts"])]);
        expect(result.ok).toBe(false);
        expect(result.addedUntracked).toEqual(["src/foo.ts"]);
    });
    test("MODIFIED src file NOT in fc warns but does NOT block", () => {
        const diff = [{ path: "src/foo.ts", status: "M" }];
        const result = runCheckChanged(diff, []);
        expect(result.ok).toBe(true);
        expect(result.modifiedUntracked).toEqual(["src/foo.ts"]);
        expect(result.addedUntracked).toEqual([]);
    });
    test("test files are skipped entirely (not added/modified untracked)", () => {
        const diff = [
            { path: "tests/unit/foo.test.ts", status: "A" },
            { path: "src/foo.test.ts", status: "A" },
        ];
        const result = runCheckChanged(diff, []);
        expect(result.ok).toBe(true);
        expect(result.addedUntracked).toEqual([]);
        expect(result.modifiedUntracked).toEqual([]);
    });
    test("multiple ADD violations are all reported", () => {
        const diff = [
            { path: "src/a.ts", status: "A" },
            { path: "src/b.ts", status: "A" },
            { path: "src/c.ts", status: "A" },
        ];
        const result = runCheckChanged(diff, [f(["src/b.ts"])]);
        expect(result.ok).toBe(false);
        expect(result.addedUntracked).toEqual(["src/a.ts", "src/c.ts"]);
    });
    test("Deletions and renames don't block (status A is the only blocker)", () => {
        const diff = [
            { path: "src/old.ts", status: "D" },
            { path: "src/renamed.ts", status: "R" },
        ];
        const result = runCheckChanged(diff, []);
        expect(result.ok).toBe(true);
    });
});
describe("parseDiffNameStatus", () => {
    test("parses A / M / D lines", () => {
        const out = parseDiffNameStatus("A\tsrc/a.ts\nM\tsrc/b.ts\nD\tsrc/c.ts\n");
        expect(out).toEqual([
            { path: "src/a.ts", status: "A" },
            { path: "src/b.ts", status: "M" },
            { path: "src/c.ts", status: "D" },
        ]);
    });
    test("parses rename — uses destination path", () => {
        const out = parseDiffNameStatus("R100\tsrc/old.ts\tsrc/new.ts\n");
        expect(out).toEqual([{ path: "src/new.ts", status: "R" }]);
    });
    test("ignores blank lines", () => {
        const out = parseDiffNameStatus("A\tsrc/a.ts\n\n\nM\tsrc/b.ts\n");
        expect(out.length).toBe(2);
    });
    test("ignores unknown status codes", () => {
        const out = parseDiffNameStatus("X\tsrc/x.ts\n");
        expect(out).toEqual([]);
    });
});
