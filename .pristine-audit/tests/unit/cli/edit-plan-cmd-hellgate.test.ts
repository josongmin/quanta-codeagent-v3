/**
 * Hellgate — `/edit-plan` slash command (ADR-0225).
 *
 * 10 cases pinning the editor-discovery + spawn + temp-file + plan-port
 * contract, default-OFF parity, empty-edit semantics.
 *
 *  HELL-EDPL-01: extra positional argument ⇒ stderr + exit 1
 *  HELL-EDPL-02: planEdit unwired ⇒ "not wired" + exit 0
 *  HELL-EDPL-03: $EDITOR resolution priority (override > VISUAL > EDITOR > vi)
 *  HELL-EDPL-04: editor binary missing ⇒ spawn_failed + exit 1
 *  HELL-EDPL-05: editor exits non-zero ⇒ editor_failed + exit 1
 *  HELL-EDPL-06: editor unchanged the body ⇒ "unchanged" + exit 0 + setPlan NOT called
 *  HELL-EDPL-07: editor produced new body ⇒ setPlan called + "updated" + exit 0
 *  HELL-EDPL-08: getPlan throws ⇒ stderr + exit 1
 *  HELL-EDPL-09: setPlan throws ⇒ stderr + exit 1
 *  HELL-EDPL-10: parseEditorCommand handles "vim -O" + empty + trailing-space
 */

import { describe, expect, test } from "bun:test"
import { __test, editPlanCmd, type PlanEditPort } from "../../../src/apps/cli/edit-plan-cmd"

const collectOut = (): {
  out: string[]
  err: string[]
  outFn: (s: string) => void
  errFn: (s: string) => void
} => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, outFn: (s) => out.push(s), errFn: (s) => err.push(s) }
}

interface FakePlanState {
  current: string
  setCalls: string[]
  getError?: Error
  setError?: Error
}

const fakePlanEdit = (state: FakePlanState): PlanEditPort => ({
  getPlan: () => {
    if (state.getError !== undefined) throw state.getError
    return state.current
  },
  setPlan: (body: string) => {
    if (state.setError !== undefined) throw state.setError
    state.setCalls.push(body)
  },
})

describe("/edit-plan hellgate (ADR-0225)", () => {
  test("HELL-EDPL-01: extra positional argument ⇒ stderr + exit 1", async () => {
    const io = collectOut()
    const code = await editPlanCmd.run(["bad"], { out: io.outFn, err: io.errFn, cwd: "/" })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("takes no arguments")
  })

  test("HELL-EDPL-02: planEdit unwired ⇒ 'not wired' + exit 0", async () => {
    const io = collectOut()
    const code = await editPlanCmd.run([], { out: io.outFn, err: io.errFn, cwd: "/" })
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("not wired")
  })

  test("HELL-EDPL-03: editor resolution priority (override > VISUAL > EDITOR > vi)", () => {
    expect(__test.resolveEditor(undefined, {}).cmd).toBe("vi")
    expect(__test.resolveEditor(undefined, { EDITOR: "nano" }).cmd).toBe("nano")
    expect(__test.resolveEditor(undefined, { VISUAL: "vim", EDITOR: "nano" }).cmd).toBe("vim")
    expect(__test.resolveEditor("code --wait", { VISUAL: "vim" }).cmd).toBe("code")
    expect(__test.resolveEditor("code --wait", { VISUAL: "vim" }).args).toEqual(["--wait"])
  })

  test("HELL-EDPL-04: editor binary missing ⇒ spawn_failed + exit 1", async () => {
    const io = collectOut()
    const state: FakePlanState = { current: "x", setCalls: [] }
    const code = await editPlanCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      planEdit: fakePlanEdit(state),
      editorOverride: "definitely-not-a-real-editor-xyzzy",
      editorSpawn: async () => 127,
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("editor not found")
    expect(state.setCalls).toHaveLength(0)
  })

  test("HELL-EDPL-05: editor exits non-zero ⇒ editor_failed + exit 1", async () => {
    const io = collectOut()
    const state: FakePlanState = { current: "x", setCalls: [] }
    const code = await editPlanCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      planEdit: fakePlanEdit(state),
      editorOverride: "vi",
      editorSpawn: async () => 7,
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("code 7")
    expect(state.setCalls).toHaveLength(0)
  })

  test("HELL-EDPL-06: editor unchanged ⇒ 'unchanged' + exit 0 + setPlan NOT called", async () => {
    const io = collectOut()
    const state: FakePlanState = { current: "original body", setCalls: [] }
    // spawn that exits 0 without modifying the file.
    const code = await editPlanCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      planEdit: fakePlanEdit(state),
      editorOverride: "true",
      editorSpawn: async (_cmd, _args) => 0, // file untouched
    })
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("unchanged")
    expect(state.setCalls).toHaveLength(0)
  })

  test("HELL-EDPL-07: editor produced new body ⇒ setPlan called + 'updated' + exit 0", async () => {
    const io = collectOut()
    const state: FakePlanState = { current: "original body", setCalls: [] }
    // spawn that REWRITES the file to a new body.
    const fs = await import("node:fs/promises")
    const code = await editPlanCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      planEdit: fakePlanEdit(state),
      editorOverride: "true",
      editorSpawn: async (_cmd, args) => {
        const path = args[args.length - 1] as string
        await fs.writeFile(path, "EDITED BODY", "utf8")
        return 0
      },
    })
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("updated")
    expect(state.setCalls).toEqual(["EDITED BODY"])
  })

  test("HELL-EDPL-08: getPlan throws ⇒ stderr + exit 1", async () => {
    const io = collectOut()
    const state: FakePlanState = { current: "x", setCalls: [], getError: new Error("get boom") }
    const code = await editPlanCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      planEdit: fakePlanEdit(state),
      editorOverride: "true",
      editorSpawn: async () => 0,
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("getPlan failed")
    expect(io.err.join("")).toContain("get boom")
  })

  test("HELL-EDPL-09: setPlan throws ⇒ stderr + exit 1", async () => {
    const io = collectOut()
    const state: FakePlanState = {
      current: "orig",
      setCalls: [],
      setError: new Error("set boom"),
    }
    const fs = await import("node:fs/promises")
    const code = await editPlanCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      planEdit: fakePlanEdit(state),
      editorOverride: "true",
      editorSpawn: async (_cmd, args) => {
        const path = args[args.length - 1] as string
        await fs.writeFile(path, "NEW", "utf8")
        return 0
      },
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("setPlan failed")
    expect(io.err.join("")).toContain("set boom")
  })

  test("HELL-EDPL-10: parseEditorCommand handles 'vim -O' + empty + trailing-space", () => {
    expect(__test.parseEditorCommand("vim -O")).toEqual({ cmd: "vim", args: ["-O"] })
    expect(__test.parseEditorCommand("  ")).toEqual({ cmd: "vi", args: [] })
    expect(__test.parseEditorCommand("nano  ")).toEqual({ cmd: "nano", args: [] })
    expect(__test.parseEditorCommand("code --wait -n")).toEqual({
      cmd: "code",
      args: ["--wait", "-n"],
    })
  })
})
