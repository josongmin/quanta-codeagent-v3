/**
 * Hellgate — `/edit-message` slash command (ADR-0225).
 *
 * 9 cases pinning the composer-port contract, default-OFF parity,
 * editor-spawn + temp-file lifecycle, empty-edit semantics.
 *
 *  HELL-EDMSG-01: extra positional argument ⇒ stderr + exit 1
 *  HELL-EDMSG-02: composerEdit unwired ⇒ "not wired" + exit 0
 *  HELL-EDMSG-03: editor binary missing ⇒ spawn_failed + exit 1
 *  HELL-EDMSG-04: editor exits non-zero ⇒ editor_failed + exit 1
 *  HELL-EDMSG-05: editor unchanged ⇒ "unchanged" + exit 0 + setPending NOT called
 *  HELL-EDMSG-06: editor produced new body ⇒ setPending called + exit 0
 *  HELL-EDMSG-07: getPending throws ⇒ stderr + exit 1
 *  HELL-EDMSG-08: setPending throws ⇒ stderr + exit 1
 *  HELL-EDMSG-09: empty starting buffer ⇒ user types text ⇒ setPending(typed)
 */

import { describe, expect, test } from "bun:test"
import { type ComposerEditPort, editMessageCmd } from "../../../src/apps/cli/edit-message-cmd"

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

interface FakeComposerState {
  pending: string
  setCalls: string[]
  getError?: Error
  setError?: Error
}

const fakeComposer = (state: FakeComposerState): ComposerEditPort => ({
  getPending: () => {
    if (state.getError !== undefined) throw state.getError
    return state.pending
  },
  setPending: (body: string) => {
    if (state.setError !== undefined) throw state.setError
    state.setCalls.push(body)
  },
})

describe("/edit-message hellgate (ADR-0225)", () => {
  test("HELL-EDMSG-01: extra positional argument ⇒ stderr + exit 1", async () => {
    const io = collectOut()
    const code = await editMessageCmd.run(["x"], { out: io.outFn, err: io.errFn, cwd: "/" })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("takes no arguments")
  })

  test("HELL-EDMSG-02: composerEdit unwired ⇒ 'not wired' + exit 0", async () => {
    const io = collectOut()
    const code = await editMessageCmd.run([], { out: io.outFn, err: io.errFn, cwd: "/" })
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("not wired")
  })

  test("HELL-EDMSG-03: editor binary missing ⇒ spawn_failed + exit 1", async () => {
    const io = collectOut()
    const state: FakeComposerState = { pending: "hi", setCalls: [] }
    const code = await editMessageCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      composerEdit: fakeComposer(state),
      editorOverride: "no-such-editor-xyzzy",
      editorSpawn: async () => 127,
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("editor not found")
    expect(state.setCalls).toHaveLength(0)
  })

  test("HELL-EDMSG-04: editor exits non-zero ⇒ editor_failed + exit 1", async () => {
    const io = collectOut()
    const state: FakeComposerState = { pending: "hi", setCalls: [] }
    const code = await editMessageCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      composerEdit: fakeComposer(state),
      editorOverride: "vi",
      editorSpawn: async () => 13,
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("code 13")
    expect(state.setCalls).toHaveLength(0)
  })

  test("HELL-EDMSG-05: editor unchanged ⇒ 'unchanged' + exit 0 + setPending NOT called", async () => {
    const io = collectOut()
    const state: FakeComposerState = { pending: "draft", setCalls: [] }
    const code = await editMessageCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      composerEdit: fakeComposer(state),
      editorOverride: "true",
      editorSpawn: async () => 0,
    })
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("unchanged")
    expect(state.setCalls).toHaveLength(0)
  })

  test("HELL-EDMSG-06: editor produced new body ⇒ setPending called + exit 0", async () => {
    const io = collectOut()
    const state: FakeComposerState = { pending: "draft", setCalls: [] }
    const fs = await import("node:fs/promises")
    const code = await editMessageCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      composerEdit: fakeComposer(state),
      editorOverride: "true",
      editorSpawn: async (_cmd, args) => {
        const path = args[args.length - 1] as string
        await fs.writeFile(path, "FINAL TEXT", "utf8")
        return 0
      },
    })
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("updated")
    expect(io.out.join("")).toContain("press Enter to send")
    expect(state.setCalls).toEqual(["FINAL TEXT"])
  })

  test("HELL-EDMSG-07: getPending throws ⇒ stderr + exit 1", async () => {
    const io = collectOut()
    const state: FakeComposerState = {
      pending: "x",
      setCalls: [],
      getError: new Error("get boom"),
    }
    const code = await editMessageCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      composerEdit: fakeComposer(state),
      editorOverride: "true",
      editorSpawn: async () => 0,
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("getPending failed")
    expect(io.err.join("")).toContain("get boom")
  })

  test("HELL-EDMSG-08: setPending throws ⇒ stderr + exit 1", async () => {
    const io = collectOut()
    const state: FakeComposerState = {
      pending: "orig",
      setCalls: [],
      setError: new Error("set boom"),
    }
    const fs = await import("node:fs/promises")
    const code = await editMessageCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      composerEdit: fakeComposer(state),
      editorOverride: "true",
      editorSpawn: async (_cmd, args) => {
        const path = args[args.length - 1] as string
        await fs.writeFile(path, "NEW", "utf8")
        return 0
      },
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("setPending failed")
    expect(io.err.join("")).toContain("set boom")
  })

  test("HELL-EDMSG-09: empty starting buffer ⇒ user types text ⇒ setPending(typed)", async () => {
    const io = collectOut()
    const state: FakeComposerState = { pending: "", setCalls: [] }
    const fs = await import("node:fs/promises")
    const code = await editMessageCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      composerEdit: fakeComposer(state),
      editorOverride: "true",
      editorSpawn: async (_cmd, args) => {
        const path = args[args.length - 1] as string
        await fs.writeFile(path, "FRESH MESSAGE FROM EDITOR", "utf8")
        return 0
      },
    })
    expect(code).toBe(0)
    expect(state.setCalls).toEqual(["FRESH MESSAGE FROM EDITOR"])
  })
})
