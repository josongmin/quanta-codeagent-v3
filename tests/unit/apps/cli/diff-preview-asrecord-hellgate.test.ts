/**
 * Hellgate — diff-preview `asRecord` array guard (jun-7 hardening).
 *
 * `asRecord` now rejects arrays (`v !== null && typeof v === "object" &&
 * !Array.isArray(v)`) so a JSON array `input` (which `typeof` reports as
 * "object") is NOT treated as a `{path,content,…}` record.
 *
 * REACHABILITY: `asRecord` is module-INTERNAL (not exported). It is exercised
 * through the public `renderActionDiff`, which calls `asRecord(action.input)` at
 * the head of EVERY per-tool branch (write/edit/apply_patch/scripted_replace).
 * So:
 *   - an ARRAY `input` ⇒ `asRecord` returns undefined ⇒ branch returns undefined
 *     ⇒ `renderActionDiff` returns undefined (no preview, falls back to legacy);
 *   - a real RECORD `input` with the right keys ⇒ a preview string is produced.
 *
 * Red-on-injection: drop the `!Array.isArray` clause and an array input would be
 * coerced to a record (`{path: arr[?]}` ⇒ undefined fields), so write/edit would
 * still return undefined — but apply_patch (`asString(i.patch)`) on an array
 * stays undefined regardless. The load-bearing case is therefore the array vs
 * record contrast on `renderActionDiff`, asserted below.
 *
 * Hermetic: a stubbed `readFile` (no disk), no env, no TTY dependence.
 */

import { describe, expect, test } from "bun:test"
import { renderActionDiff } from "@/apps/cli/diff-preview"
import type { ToolAction } from "@/permission"

const action = (tool: string, input: unknown): ToolAction =>
  ({ tool, input }) as unknown as ToolAction

// Reader that yields an empty "previous" file so write previews are deterministic
// and never touch the real filesystem.
const emptyReader = async (): Promise<string> => ""

describe("renderActionDiff — array input is rejected (asRecord !Array.isArray guard)", () => {
  test("write with an ARRAY input ⇒ undefined (array is NOT a record)", async () => {
    const out = await renderActionDiff(action("write", [1, 2]), { readFile: emptyReader })
    expect(out).toBeUndefined()
  })

  test("edit with an ARRAY input ⇒ undefined", async () => {
    const out = await renderActionDiff(action("edit", ["a", "b"]), { readFile: emptyReader })
    expect(out).toBeUndefined()
  })

  test("apply_patch with an ARRAY input ⇒ undefined", async () => {
    const out = await renderActionDiff(action("apply_patch", [{ patch: "x" }]), {
      readFile: emptyReader,
    })
    expect(out).toBeUndefined()
  })

  test("scripted_replace with an ARRAY input ⇒ undefined", async () => {
    const out = await renderActionDiff(action("scripted_replace", [1]), { readFile: emptyReader })
    expect(out).toBeUndefined()
  })
})

describe("renderActionDiff — a real RECORD input still produces a preview", () => {
  test("write with a {path,content} RECORD ⇒ a non-empty preview string", async () => {
    const out = await renderActionDiff(action("write", { path: "f.txt", content: "hello\n" }), {
      readFile: emptyReader,
    })
    expect(typeof out).toBe("string")
    expect(out).toContain("f.txt")
  })

  test("apply_patch with a {patch} RECORD ⇒ a preview string", async () => {
    const out = await renderActionDiff(
      action("apply_patch", { patch: "*** Begin Patch\n+added\n*** End Patch" }),
      { readFile: emptyReader },
    )
    expect(typeof out).toBe("string")
    expect(out).toContain("added")
  })

  test("a primitive (non-object) input ⇒ undefined too (asRecord rejects)", async () => {
    expect(await renderActionDiff(action("write", "str"), { readFile: emptyReader })).toBeUndefined()
    expect(await renderActionDiff(action("write", null), { readFile: emptyReader })).toBeUndefined()
    expect(await renderActionDiff(action("write", 42), { readFile: emptyReader })).toBeUndefined()
  })
})
