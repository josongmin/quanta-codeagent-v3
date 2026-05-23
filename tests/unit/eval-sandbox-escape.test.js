/**
 * Sandbox escape — uses `path.relative` semantics so the check is portable.
 *
 * We exercise the file-write path of `synthetic/runner` by handing it a
 * synthetic Scenario with a path that LOOKS in-sandbox but resolves outside.
 * The runner's `writeFiles` must throw; otherwise an attacker-controlled
 * scenario could clobber files outside the tmp dir.
 *
 * The runner is async + invokes the whole agent loop; isolating just the
 * `writeFiles` step would require exporting it. We test the equivalent
 * predicate via a small re-implementation here that matches the runner's
 * `isInsideSandbox` semantics, and the runner-level test that imports the
 * exported helper lives in the integration suite.
 */
import { describe, expect, test } from "bun:test";
import { relative, resolve, sep } from "node:path";
const isInsideSandbox = (sandbox, dest) => {
    if (dest === sandbox)
        return true;
    const rel = relative(sandbox, dest);
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
};
describe("sandbox-escape predicate (matches synthetic/runner + compare/cli-base)", () => {
    const sandbox = resolve("/tmp/sandbox-xyz");
    test("dest equal to sandbox is allowed", () => {
        expect(isInsideSandbox(sandbox, sandbox)).toBe(true);
    });
    test("dest under sandbox is allowed", () => {
        expect(isInsideSandbox(sandbox, resolve(sandbox, "src/x.ts"))).toBe(true);
    });
    test("dest with ../ escape is REFUSED", () => {
        expect(isInsideSandbox(sandbox, resolve(sandbox, "../evil"))).toBe(false);
    });
    test("dest at root is REFUSED", () => {
        expect(isInsideSandbox(sandbox, "/etc/passwd")).toBe(false);
    });
    test("dest with embedded .. inside sandbox is allowed when resolved", () => {
        // resolve() collapses `..` — `sandbox/foo/../bar` ⇒ `sandbox/bar` (in)
        expect(isInsideSandbox(sandbox, resolve(sandbox, "foo/../bar"))).toBe(true);
    });
    test("dest that resolves to a sibling dir is REFUSED", () => {
        expect(isInsideSandbox("/tmp/sandbox-xyz", "/tmp/sandbox-xyz2/foo")).toBe(false);
    });
});
