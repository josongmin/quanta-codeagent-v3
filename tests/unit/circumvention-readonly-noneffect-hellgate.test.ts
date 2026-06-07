/**
 * HELLGATE — jun-7-misc 04 (b), round-3 finding: a READ-ONLY action that merely
 * carries a `path` input MUST NOT be misclassified as a WRITE effect.
 *
 * THE HOLE (round-3 adversarial audit): `extractWriteEffect` duck-typed ANY
 * non-shell action whose `input` carried a string `path` as a WRITE-to-that-path
 * effect — ignoring whether the tool actually writes. So `Read`/`Grep`/`LS`/a
 * read-only MCP tool with a `{ path }` input produced `{ kind:"write", path }`.
 *
 * Two concrete bypasses this enabled at the gate:
 *   1. CLEAR-ON-ALLOW POISONING: a prior soft-deny of a Write to /repo/X, then a
 *      NON-read-only path-bearing READ tool on /repo/X that the classifier
 *      allows ⇒ the (spurious) write-effect is `clearOnAllow`-ed, ERASING the
 *      live deny so a later bash `> /repo/X` is no longer flagged.
 *   2. FALSE-POSITIVE: a soft-denied Write to /repo/X, then a legitimate
 *      different-tool READ of /repo/X, falsely matches as "same-effect write via
 *      a different tool" — a read is not a write.
 *
 * THE FENCE: the effect of an action is a WRITE only when the action is NOT
 * read-only (the gate's `isReadOnly` signal threads through). A read-only action
 * yields NO write effect — conservative (FN over FP, §5).
 *
 * Red-on-injection: revert `extractWriteEffect` to ignore `isReadOnly` (treat any
 * path-bearing input as a write) ⇒ these assertions fail.
 *
 * Source under test: src/permission/circumvention.ts — extractWriteEffect
 */
import { describe, expect, test } from "bun:test"
import { extractWriteEffect } from "@/permission"

describe("read-only action is NOT a write effect", () => {
  test("a read-only path-bearing tool yields NO write effect", () => {
    // `Read`/`Grep`/`LS` carry a `{ path }` but do not WRITE it.
    expect(extractWriteEffect("Read", { path: "/repo/X" }, null, "/repo", true)).toBeUndefined()
    expect(
      extractWriteEffect("Grep", { path: "/repo/X" }, undefined, "/repo", true),
    ).toBeUndefined()
  })

  test("a NON-read-only write tool STILL yields the write effect (parity preserved)", () => {
    const eff = extractWriteEffect("Write", { path: "/repo/X" }, null, "/repo", false)
    expect(eff).toEqual({ kind: "write", path: "/repo/X" })
  })

  test("a read-only shell action yields NO write effect even if a redirect is present", () => {
    // (Defence-in-depth: a read-only-marked shell action never reaches the
    //  tracker live — but we also refuse to fabricate a write effect for it.)
    expect(
      extractWriteEffect("bash", { command: "echo > /repo/X" }, "echo > /repo/X", "/repo", true),
    ).toBeUndefined()
  })

  test("the isReadOnly arg defaults to write-allowed (back-compat: omitted ⇒ effect built)", () => {
    // Callers that DON'T pass the flag keep the prior behavior (a write effect is
    // extracted) — the gate is the site that supplies the real `isReadOnly`.
    const eff = extractWriteEffect("Write", { path: "/repo/X" }, null, "/repo")
    expect(eff).toEqual({ kind: "write", path: "/repo/X" })
  })
})
