import { describe, expect, test } from "bun:test";
import { __longestCommonPrefixForTest } from "../../../../src/apps/cli/raw-line-reader";
describe("longestCommonPrefix (raw-line-reader internal)", () => {
    test("empty list → empty prefix", () => {
        expect(__longestCommonPrefixForTest([])).toBe("");
    });
    test("single string → that string", () => {
        expect(__longestCommonPrefixForTest(["/login"])).toBe("/login");
    });
    test("shared prefix /log from /login + /logout", () => {
        // login / logout diverge at the 5th char (i vs o), so the LCP is "/log".
        expect(__longestCommonPrefixForTest(["/login", "/logout"])).toBe("/log");
    });
    test("no common prefix → empty string (no false-positive accept)", () => {
        expect(__longestCommonPrefixForTest(["/status", "/login"])).toBe("/");
    });
    test("zero common chars across siblings → empty", () => {
        expect(__longestCommonPrefixForTest(["abc", "xyz"])).toBe("");
    });
    test("varying lengths: prefix bounded by shortest", () => {
        expect(__longestCommonPrefixForTest(["/lo", "/login", "/logout"])).toBe("/lo");
    });
    test("identical strings → that string", () => {
        expect(__longestCommonPrefixForTest(["/exit", "/exit"])).toBe("/exit");
    });
});
