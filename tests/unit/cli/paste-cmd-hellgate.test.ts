/**
 * Hellgate — `/paste` slash command (ADR-0224).
 *
 * 11 cases pinning the platform reader contract, path-attachment branch,
 * inbox routing, default-OFF parity, error paths.
 *
 *  HELL-PASTE-01: no_backend ⇒ stderr + exit 1
 *  HELL-PASTE-02: error from reader ⇒ stderr + exit 1
 *  HELL-PASTE-03: empty clipboard ⇒ stderr + exit 1
 *  HELL-PASTE-04: image clipboard ⇒ "use /image add" hint + exit 1
 *  HELL-PASTE-05: text + inbox wired ⇒ queued + size advances
 *  HELL-PASTE-06: text + inbox unwired ⇒ printed inline + exit 0
 *  HELL-PASTE-07: text == absolute existing file ⇒ file body queued
 *  HELL-PASTE-08: text == abs path but not a file ⇒ treated as text (no path probe trigger)
 *  HELL-PASTE-09: text == abs path but oversize ⇒ stderr + exit 1
 *  HELL-PASTE-10: relative path looks ⇒ treated as text (we don't speculate)
 *  HELL-PASTE-11: extra positional argument ⇒ stderr + exit 1
 */

import { describe, expect, test } from "bun:test"
import { __test, type ClipboardReader, pasteCmd } from "../../../src/apps/cli/paste-cmd"
import { createTextInbox } from "../../../src/apps/cli/text-inbox"

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

const fakeReader =
  (content: Awaited<ReturnType<ClipboardReader>>): ClipboardReader =>
  async () =>
    content

describe("/paste hellgate (ADR-0224)", () => {
  test("HELL-PASTE-01: no_backend ⇒ stderr + exit 1", async () => {
    const io = collectOut()
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "no_backend", hint: "install xclip" }),
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("install xclip")
  })

  test("HELL-PASTE-02: error from reader ⇒ stderr + exit 1", async () => {
    const io = collectOut()
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "error", message: "boom" }),
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("boom")
  })

  test("HELL-PASTE-03: empty clipboard ⇒ stderr + exit 1", async () => {
    const io = collectOut()
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "empty" }),
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("empty")
  })

  test("HELL-PASTE-04: image clipboard ⇒ '/image add' hint + exit 1", async () => {
    const io = collectOut()
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "image", bytes: 1024 }),
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("/image add")
  })

  test("HELL-PASTE-05: text + inbox wired ⇒ queued + size advances", async () => {
    const io = collectOut()
    const inbox = createTextInbox()
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "text", text: "hello clipboard" }),
      textInbox: inbox,
    })
    expect(code).toBe(0)
    expect(inbox.size()).toBe(1)
    const drained = inbox.drain()
    expect(drained[0]?.kind).toBe("paste")
    expect(drained[0]?.text).toBe("hello clipboard")
    expect(drained[0]?.label).toBe("clipboard")
  })

  test("HELL-PASTE-06: text + inbox unwired ⇒ printed inline + exit 0", async () => {
    const io = collectOut()
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "text", text: "no inbox here" }),
    })
    expect(code).toBe(0)
    const joined = io.out.join("")
    expect(joined).toContain("no inbox here")
    expect(joined).toContain("inbox not wired — printed inline")
  })

  test("HELL-PASTE-07: text == absolute existing file ⇒ file body queued", async () => {
    const io = collectOut()
    const inbox = createTextInbox()
    const fakeFs = {
      readFile: async (_p: string) => "FILE BODY",
      stat: async (_p: string) => ({ isFile: true, size: 9 }),
    }
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "text", text: "/tmp/some/abs/path" }),
      textInbox: inbox,
      clipboardFs: fakeFs,
    })
    expect(code).toBe(0)
    const drained = inbox.drain()
    expect(drained[0]?.text).toBe("FILE BODY")
    expect(drained[0]?.label).toBe("/tmp/some/abs/path")
  })

  test("HELL-PASTE-08: text == abs path but not a file ⇒ treated as text", async () => {
    const io = collectOut()
    const inbox = createTextInbox()
    const fakeFs = {
      readFile: async (_p: string) => "should not be read",
      stat: async (_p: string) => ({ isFile: false, size: 0 }), // directory
    }
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "text", text: "/etc/passwd" }),
      textInbox: inbox,
      clipboardFs: fakeFs,
    })
    expect(code).toBe(0)
    const drained = inbox.drain()
    // Falls through to literal text branch — label is "clipboard", text is the path string.
    expect(drained[0]?.text).toBe("/etc/passwd")
    expect(drained[0]?.label).toBe("clipboard")
  })

  test("HELL-PASTE-09: text == abs path but oversize ⇒ stderr + exit 1", async () => {
    const io = collectOut()
    const fakeFs = {
      readFile: async (_p: string) => "...",
      stat: async (_p: string) => ({ isFile: true, size: 9_999_999 }),
    }
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "text", text: "/tmp/big.log" }),
      clipboardFs: fakeFs,
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("too large")
  })

  test("HELL-PASTE-10: relative path looks ⇒ treated as text (we don't speculate)", async () => {
    const io = collectOut()
    const inbox = createTextInbox()
    const probeCalled = { n: 0 }
    const fakeFs = {
      readFile: async (_p: string) => {
        probeCalled.n += 1
        return "should not be read"
      },
      stat: async (_p: string) => {
        probeCalled.n += 1
        return { isFile: true, size: 5 }
      },
    }
    const code = await pasteCmd.run([], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      clipboardReader: fakeReader({ kind: "text", text: "README.md" }),
      textInbox: inbox,
      clipboardFs: fakeFs,
    })
    expect(code).toBe(0)
    expect(probeCalled.n).toBe(0)
    const drained = inbox.drain()
    expect(drained[0]?.text).toBe("README.md")
  })

  test("HELL-PASTE-11: extra positional argument ⇒ stderr + exit 1", async () => {
    const io = collectOut()
    const code = await pasteCmd.run(["extra"], { out: io.outFn, err: io.errFn, cwd: "/" })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("takes no arguments")
  })

  test("HELL-PASTE-12: probePath rejects multi-line clipboard text", async () => {
    const fakeFs = {
      readFile: async (_p: string) => "n/a",
      stat: async (_p: string) => ({ isFile: true, size: 1 }),
    }
    const res = await __test.probePath("/tmp/abc\n/etc/passwd", fakeFs)
    expect(res).toBeNull()
  })
})
