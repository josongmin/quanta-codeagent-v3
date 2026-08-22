/**
 * Sandbox escape — exercises the REAL `isInsideSandbox` predicate exported from
 * `synthetic/runner`, the same gate `writeFiles` uses to refuse scenario file
 * paths that resolve outside the tmp sandbox. (Previously this test re-declared
 * a private copy of the predicate and only proved the copy — a bug flipping the
 * runner's gate would have stayed green.)
 */
import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { isInsideSandbox } from "@/../src/apps/eval/synthetic/runner"

describe("sandbox-escape predicate (synthetic/runner writeFiles gate)", () => {
  const sandbox = resolve("/tmp/sandbox-xyz")

  test("dest equal to sandbox is allowed", () => {
    expect(isInsideSandbox(sandbox, sandbox)).toBe(true)
  })

  test("dest under sandbox is allowed", () => {
    expect(isInsideSandbox(sandbox, resolve(sandbox, "src/x.ts"))).toBe(true)
  })

  test("dest with ../ escape is REFUSED", () => {
    expect(isInsideSandbox(sandbox, resolve(sandbox, "../evil"))).toBe(false)
  })

  test("dest at root is REFUSED", () => {
    expect(isInsideSandbox(sandbox, "/etc/passwd")).toBe(false)
  })

  test("dest with embedded .. inside sandbox is allowed when resolved", () => {
    // resolve() collapses `..` — `sandbox/foo/../bar` ⇒ `sandbox/bar` (in)
    expect(isInsideSandbox(sandbox, resolve(sandbox, "foo/../bar"))).toBe(true)
  })

  test("dest that resolves to a sibling dir is REFUSED", () => {
    expect(isInsideSandbox("/tmp/sandbox-xyz", "/tmp/sandbox-xyz2/foo")).toBe(false)
  })
})
