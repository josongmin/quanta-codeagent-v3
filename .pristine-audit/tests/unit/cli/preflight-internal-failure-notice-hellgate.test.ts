/**
 * WS-G item 8 (UUX-6-16) — preflight INTERNAL failures were silent: the
 * best-effort catch collapses any unexpected internal error to `undefined`
 * ("no concern"), so a structurally-broken preview ran every approval with the
 * operator believing pre-flight was checking. Fix: one LATCHED warn per
 * session on the first internal failure (the collapse itself stays — the
 * confirm path must remain unaffected).
 *
 * Injection: an `input` object whose property access THROWS reaches the outer
 * best-effort catch (a real verdict path like "file not found" must NOT
 * count as internal failure — paired control).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ToolAction } from "@/permission"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "@/shared"
import {
  __resetPreflightFailureNoticeForTest,
  preflightApplyWarning,
} from "../../../src/apps/cli/preflight"

const notices: OperatorNotice[] = []

beforeEach(() => {
  __resetPreflightFailureNoticeForTest()
  installOperatorNoticeSink((n) => notices.push(n))
})

afterEach(() => {
  __resetOperatorNoticeSinkForTest()
  __resetPreflightFailureNoticeForTest()
  notices.length = 0
})

/** An edit action whose input EXPLODES on property access — the class of
 *  unexpected internal failure the outer catch collapses. */
const boobyTrappedAction = (): ToolAction => {
  const input = new Proxy(
    {},
    {
      get: () => {
        throw new Error("internal preview bug")
      },
    },
  )
  return { tool: "edit", input, isReadOnly: false }
}

describe("preflight internal-failure notice (UUX-6-16)", () => {
  test("internal failure ⇒ undefined verdict (unchanged) + ONE latched warn", async () => {
    const w1 = await preflightApplyWarning(boobyTrappedAction(), { cwd: "/tmp" })
    const w2 = await preflightApplyWarning(boobyTrappedAction(), { cwd: "/tmp" })
    expect(w1).toBeUndefined()
    expect(w2).toBeUndefined()
    const warns = notices.filter((n) => n.source === "preflight")
    expect(warns).toHaveLength(1)
    expect(warns[0]?.severity).toBe("warn")
  })

  test("paired control: a REAL verdict path (missing file) emits NO notice", async () => {
    const action: ToolAction = {
      tool: "edit",
      input: { path: "nope.txt", old_string: "a", new_string: "b" },
      isReadOnly: false,
    }
    const w = await preflightApplyWarning(action, {
      cwd: "/tmp",
      readFile: async () => {
        throw new Error("ENOENT")
      },
    })
    expect(w).toContain("file not found")
    expect(notices).toHaveLength(0)
  })
})
