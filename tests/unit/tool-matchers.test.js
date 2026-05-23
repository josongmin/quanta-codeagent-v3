import { describe, expect, test } from "bun:test";
import { AGENT_TOOLS_MATCHER, FS_TOOLS_MATCHER, matchTool, } from "@/agent/tool-matchers";
describe("FS_TOOLS_MATCHER", () => {
    test("includes the AWF FS group verbatim", () => {
        expect(FS_TOOLS_MATCHER).toEqual([
            "read",
            "write",
            "edit",
            "multi_edit",
            "notebook_edit",
            "grep",
            "glob",
        ]);
    });
});
describe("AGENT_TOOLS_MATCHER", () => {
    test("includes the AWF agent group verbatim", () => {
        expect(AGENT_TOOLS_MATCHER).toEqual(["agent", "task", "task_output", "task_stop"]);
    });
});
describe("matchTool — identity (no matcher)", () => {
    test("undefined matcher matches every name (legacy parity)", () => {
        expect(matchTool(undefined, "anything")).toBe(true);
        expect(matchTool(undefined, "")).toBe(true);
    });
});
describe("matchTool — string", () => {
    test("exact match", () => {
        expect(matchTool("read", "read")).toBe(true);
        expect(matchTool("read", "write")).toBe(false);
    });
});
describe("matchTool — string[]", () => {
    test("membership test", () => {
        expect(matchTool(FS_TOOLS_MATCHER, "read")).toBe(true);
        expect(matchTool(FS_TOOLS_MATCHER, "agent")).toBe(false);
        expect(matchTool(AGENT_TOOLS_MATCHER, "task")).toBe(true);
    });
    test("empty array matches nothing", () => {
        expect(matchTool([], "anything")).toBe(false);
    });
});
describe("matchTool — RegExp", () => {
    test("test() result coerces to boolean", () => {
        expect(matchTool(/^lsp_/, "lsp_nav")).toBe(true);
        expect(matchTool(/^lsp_/, "agent")).toBe(false);
    });
});
describe("matchTool — function predicate", () => {
    test("truthy ⇒ match; falsy ⇒ miss", () => {
        const isUpper = (n) => n === n.toUpperCase();
        expect(matchTool(isUpper, "READ")).toBe(true);
        expect(matchTool(isUpper, "read")).toBe(false);
    });
    test("non-boolean return is coerced via Boolean()", () => {
        const truthy = () => 1;
        const falsy = () => 0;
        expect(matchTool(truthy, "x")).toBe(true);
        expect(matchTool(falsy, "x")).toBe(false);
    });
});
