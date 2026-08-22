/**
 * HELLGATE — UUX-2-03 / D-2 (jul-10): Ctrl+D = EOF on an EMPTY line.
 *
 * The bug: `/help` advertised "Ctrl+D — EOF (exit on empty line)" but the
 * reader's printable-insert guard dropped ALL control chars — Ctrl+D did
 * nothing. Decision D-2: IMPLEMENT the advertised behavior rather than
 * deleting the copy.
 *
 * Contract (mirrors the Ctrl+C quit signal — settleReject(AbortError), which
 * prompt-pipeline maps to `null` ⇒ REPL loop exit):
 *   - empty buffer  ⇒ the read rejects with AbortError (EOF/quit path),
 *   - non-empty     ⇒ consumed no-op (never submits, never deletes, never
 *                     quits; readline parity for "ignore when line has text"),
 *   - heredoc body  ⇒ NOT an empty line — a blank continuation row must not
 *                     tear the REPL down mid-composition,
 *   - a user keybinding remap of ctrl+d wins over the EOF branch (the remap
 *     layer rewrites the event before the EOF branch sees it).
 *
 * RED-first proof: at HEAD there is no ctrl+d branch — the empty-buffer test
 * times out awaiting a rejection that never comes (control char dropped).
 */

import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { KeybindingMap } from "../keybindings/types"
import { AbortError, type ReadLineTestIO, readLine } from "../raw-line-reader"

interface KeyEvent {
  name?: string
  ctrl?: boolean
  sequence?: string
}

class FakeStdin extends EventEmitter {
  isTTY = false
  isRaw = false
  setRawMode(mode: boolean): void {
    this.isRaw = mode
  }
  resume(): void {}
  pause(): void {}
  key(str: string | undefined, key: KeyEvent = {}): void {
    this.emit("keypress", str, key)
  }
  type(ch: string): void {
    this.key(ch, { name: ch, sequence: ch })
  }
  ctrlD(): void {
    this.key("\x04", { name: "d", ctrl: true })
  }
  retn(): void {
    this.key("\r", { name: "return" })
  }
}

class FakeStdout {
  chunks: string[] = []
  write(chunk: string): void {
    this.chunks.push(chunk)
  }
}

const makeIO = (): { io: ReadLineTestIO; stdin: FakeStdin } => {
  const stdin = new FakeStdin()
  return {
    io: {
      stdin: stdin as unknown as ReadLineTestIO["stdin"],
      stdout: new FakeStdout(),
      skipKeypressSetup: true,
    },
    stdin,
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

/** Race the readLine promise against a short timer so the RED state (no EOF
 *  branch ⇒ promise never settles) fails fast instead of hanging the suite. */
const settledWithin = async (p: Promise<string>, ms: number): Promise<"eof" | "timeout"> => {
  const outcome = await Promise.race([
    p.then(
      () => "resolved" as const,
      (e) => (e instanceof AbortError ? ("eof" as const) : ("rejected-other" as const)),
    ),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms)),
  ])
  if (outcome === "resolved" || outcome === "rejected-other") {
    throw new Error(`readLine settled unexpectedly: ${outcome}`)
  }
  return outcome
}

describe("UUX-2-03 — Ctrl+D EOF-on-empty-buffer", () => {
  test("empty buffer: Ctrl+D rejects with AbortError (the quit path Ctrl+C uses)", async () => {
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› " }, io)
    await flush()
    stdin.ctrlD()
    expect(await settledWithin(p, 250)).toBe("eof")
  })

  test("non-empty buffer: Ctrl+D is a no-op — the line still submits intact on Enter", async () => {
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› " }, io)
    await flush()
    for (const ch of "keep") stdin.type(ch)
    stdin.ctrlD() // must not quit, must not submit, must not delete
    await flush()
    stdin.retn()
    expect(await p).toBe("keep")
  })

  test("after clearing back to empty, Ctrl+D is EOF again (state, not history)", async () => {
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› " }, io)
    await flush()
    stdin.type("x")
    stdin.key(undefined, { name: "backspace" })
    stdin.ctrlD()
    expect(await settledWithin(p, 250)).toBe("eof")
  })

  test("heredoc body: Ctrl+D on a blank continuation row does NOT tear down the read", async () => {
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› ", multiline: true }, io)
    await flush()
    // Open a heredoc fence (`"""`), then land on a blank continuation row.
    for (const ch of '"""') stdin.type(ch)
    stdin.retn()
    stdin.ctrlD() // buffer empty BUT heredoc open ⇒ not an EOF
    for (const ch of "body") stdin.type(ch)
    stdin.retn()
    for (const ch of '"""') stdin.type(ch)
    stdin.retn()
    expect(await p).toBe("body")
  })

  test("keybinding remap of ctrl+d wins over the EOF branch", async () => {
    const { io, stdin } = makeIO()
    // Operator rebinds ctrl+d to cursor-home: the remap layer rewrites the
    // event to the canonical Home key BEFORE the EOF branch, so no quit.
    const keybindings: KeybindingMap = new Map([["ctrl+d", "cursor-home"]])
    const p = readLine({ prompt: "› ", keybindings }, io)
    await flush()
    for (const ch of "ab") stdin.type(ch)
    stdin.key(undefined, { name: "backspace" })
    stdin.key(undefined, { name: "backspace" })
    stdin.ctrlD() // empty buffer, but remapped ⇒ cursor-home, not EOF
    await flush()
    for (const ch of "ok") stdin.type(ch)
    stdin.retn()
    expect(await p).toBe("ok")
  })
})
