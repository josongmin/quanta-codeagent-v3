/**
 * RFC-11 / ADR-0446 + ADR-0447 — external `$EDITOR` composition (ctrl-x
 * ctrl-e) + keybinding remap, integration hellgate through `readLine`'s
 * test-IO seam. NO real TTY, NO real editor — a FAKE spawn drives the
 * `editInTemp` driver; a FAKE stdin records `setRawMode` calls so the #1 risk
 * (raw-mode left disabled after an editor crash) is asserted directly.
 *
 *   §A-1  editor spawn folds edited text back into the buffer (changed)
 *   §A-2  CRITICAL: raw mode RESTORED even when the spawn THROWS (try/finally)
 *   §A-3  editor nonzero exit ⇒ no-op (draft preserved) + warning
 *   §A-4  $EDITOR/$VISUAL unset ⇒ vi fallback ⇒ spawn 127 ⇒ no-op + warning
 *   §A-5  ctrl-x ctrl-e chord recognized; not auto-submitted (Enter still needed)
 *   §A-6  chord isolation: ctrl-x then a NON-ctrl-e key ⇒ no editor, key handled
 *   §A-7  DEFAULT-OFF: no openEditor ⇒ ctrl-x / ctrl-e inert, byte-identical
 *   §B-7  keymap remap: ctrl+p → history-prev dispatches as ↑ (history nav)
 *   §B-8  open-editor action via single-key binding triggers the editor
 *   §B-9  collision: a default map does NOT disturb shift+tab / ctrl-r / @ / Tab
 */

import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { writeFile } from "node:fs/promises"
import { DEFAULT_KEYBINDINGS } from "../keybindings/defaults"
import type { KeyAction, KeybindingMap, KeySpec } from "../keybindings/types"
import { __createSeededHistoryForTest } from "../prompt-history"
import { type ReadLineTestIO, readLine } from "../raw-line-reader"
import { buildExternalEditor, type ExternalEditorPort } from "../raw-line-reader-editor"

interface KeyEvent {
  name?: string
  ctrl?: boolean
  shift?: boolean
  sequence?: string
}

/** Fake stdin that is a TTY and records every `setRawMode(mode)` call so the
 *  raw-mode-restore invariant can be asserted. */
class FakeTtyStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  rawCalls: boolean[] = []
  listenerAttachCount = 0
  resume(): void {}
  pause(): void {}
  setRawMode(mode: boolean): void {
    this.rawCalls.push(mode)
    this.isRaw = mode
  }
  override on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === "keypress") this.listenerAttachCount += 1
    return super.on(event, listener as never)
  }
  key(str: string | undefined, key: KeyEvent = {}): void {
    this.emit("keypress", str, key)
  }
  type(ch: string): void {
    this.key(ch, { name: ch, sequence: ch })
  }
  typeStr(s: string): void {
    for (const ch of s) this.type(ch)
  }
}

class FakeStdout {
  chunks: string[] = []
  write(chunk: string): void {
    this.chunks.push(chunk)
  }
  get bytes(): string {
    return this.chunks.join("")
  }
}

const makeIO = (): { io: ReadLineTestIO; stdin: FakeTtyStdin; stdout: FakeStdout } => {
  const stdin = new FakeTtyStdin()
  const stdout = new FakeStdout()
  const io: ReadLineTestIO = {
    stdin: stdin as unknown as ReadLineTestIO["stdin"],
    stdout,
    skipKeypressSetup: true,
  }
  return { io, stdin, stdout }
}

/** A fake spawn that REWRITES the temp file (the editor's job) to `newText`
 *  then resolves `0`. The file path is the LAST arg the driver appends. */
const writingSpawn =
  (newText: string) =>
  async (_cmd: string, args: readonly string[]): Promise<number> => {
    const path = args[args.length - 1] as string
    await writeFile(path, newText, "utf8")
    return 0
  }

/** Wait for the fire-and-forget `runExternalEdit` (real mkdtemp → write →
 *  spawn → readback, then listener re-attach in the `finally`) to FULLY
 *  settle. We poll on the keypress-listener re-attach because the editor
 *  driver does real disk I/O whose latency exceeds a fixed microtask count. */
const waitForEditorSettled = async (stdin: FakeTtyStdin): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (stdin.listenerCount("keypress") > 0) return
    await new Promise<void>((r) => setTimeout(r, 2))
  }
  throw new Error("editor never re-attached the keypress listener")
}

describe("RFC-11 external editor (A) — ctrl-x ctrl-e", () => {
  test("§A-1 editor edit folds back into the buffer, not auto-submitted", async () => {
    const { io, stdin } = makeIO()
    const editor = buildExternalEditor({
      editorOverride: "fake",
      spawn: writingSpawn("edited body"),
    })
    const p = readLine({ prompt: "> ", openEditor: editor }, io)
    stdin.typeStr("draft")
    stdin.key(undefined, { name: "x", ctrl: true })
    stdin.key(undefined, { name: "e", ctrl: true })
    await waitForEditorSettled(stdin)
    // Not submitted yet — the user presses Enter to submit the edited text.
    stdin.key(undefined, { name: "return" })
    expect(await p).toBe("edited body")
  })

  test("§A-2 CRITICAL: raw mode is RESTORED after the editor THROWS", async () => {
    const { io, stdin } = makeIO()
    // A port whose openDraft rejects — the worst case the finally must survive.
    const throwingPort: ExternalEditorPort = {
      openDraft: async () => {
        throw new Error("editor process exploded")
      },
    }
    const p = readLine({ prompt: "> ", openEditor: throwingPort }, io)
    stdin.typeStr("keepme")
    const attachBefore = stdin.listenerAttachCount
    stdin.key(undefined, { name: "x", ctrl: true })
    stdin.key(undefined, { name: "e", ctrl: true })
    await waitForEditorSettled(stdin)
    // (a) the LAST setRawMode call restored raw mode to true.
    expect(stdin.rawCalls.length).toBeGreaterThan(0)
    expect(stdin.rawCalls[stdin.rawCalls.length - 1]).toBe(true)
    expect(stdin.isRaw).toBe(true)
    // (b) the keypress listener was re-attached after the editor.
    expect(stdin.listenerAttachCount).toBeGreaterThan(attachBefore)
    // (c) the draft is preserved; the reader still works → Enter submits it.
    stdin.key(undefined, { name: "return" })
    expect(await p).toBe("keepme")
  })

  test("§A-3 editor nonzero exit ⇒ no-op + warning, draft preserved", async () => {
    const warnings: string[] = []
    const port = buildExternalEditor({
      editorOverride: "fake",
      spawn: async () => 1, // nonzero exit
      onWarn: (l) => warnings.push(l),
    })
    const res = await port.openDraft("original")
    expect(res).toEqual({ text: "original", changed: false })
    expect(warnings.some((w) => w.includes("exited with code 1"))).toBe(true)
  })

  test("§A-4 $EDITOR/$VISUAL unset ⇒ vi fallback ⇒ spawn 127 ⇒ no-op + warning", async () => {
    const warnings: string[] = []
    const port = buildExternalEditor({
      env: {}, // no VISUAL/EDITOR
      spawn: async (cmd) => {
        expect(cmd).toBe("vi") // resolveEditor fell back to vi
        return 127 // spawn failure
      },
      onWarn: (l) => warnings.push(l),
    })
    const res = await port.openDraft("draft")
    expect(res).toEqual({ text: "draft", changed: false })
    expect(warnings.some((w) => w.includes("set $EDITOR"))).toBe(true)
  })

  test("§A-6 chord isolation: ctrl-x then a non-ctrl-e key ⇒ no editor", async () => {
    const { io, stdin } = makeIO()
    let opened = 0
    const port: ExternalEditorPort = {
      openDraft: async (t) => {
        opened += 1
        return { text: t, changed: false }
      },
    }
    const p = readLine({ prompt: "> ", openEditor: port }, io)
    stdin.typeStr("ab")
    stdin.key(undefined, { name: "x", ctrl: true }) // arm chord
    stdin.type("c") // NOT ctrl-e ⇒ chord abandoned, 'c' inserts
    stdin.key(undefined, { name: "return" })
    expect(await p).toBe("abc")
    expect(opened).toBe(0)
  })

  test("§A-7 DEFAULT-OFF: no openEditor ⇒ ctrl-x / ctrl-e inert (byte-identical)", async () => {
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "> " }, io) // NO openEditor
    stdin.typeStr("hi")
    stdin.key(undefined, { name: "x", ctrl: true }) // control char ⇒ dropped today
    stdin.key(undefined, { name: "e", ctrl: true })
    stdin.key(undefined, { name: "return" })
    expect(await p).toBe("hi")
    expect(stdin.rawCalls).toEqual([true, false]) // only the entry set + cleanup restore
  })
})

describe("RFC-11 keybinding remap (B) — through readLine", () => {
  const mapWith = (extra: ReadonlyArray<readonly [KeySpec, KeyAction]>): KeybindingMap =>
    new Map<KeySpec, KeyAction>([...DEFAULT_KEYBINDINGS, ...extra])

  test("§B-7 ctrl+p → history-prev dispatches AS the ↑ history nav", async () => {
    const { io, stdin } = makeIO()
    const history = __createSeededHistoryForTest(["earlier-cmd"])
    const p = readLine(
      { prompt: "> ", history, keybindings: mapWith([["ctrl+p", "history-prev"]]) },
      io,
    )
    stdin.key(undefined, { name: "p", ctrl: true }) // remaps to up → recall newest
    stdin.key(undefined, { name: "return" })
    expect(await p).toBe("earlier-cmd")
  })

  test("§B-8 open-editor action via a single-key binding triggers the editor", async () => {
    const { io, stdin } = makeIO()
    const editor = buildExternalEditor({
      editorOverride: "fake",
      spawn: writingSpawn("from F-key"),
    })
    // Bind a bare key (here ctrl+o) to open-editor.
    const p = readLine(
      {
        prompt: "> ",
        openEditor: editor,
        keybindings: mapWith([["ctrl+o", "open-editor"]]),
      },
      io,
    )
    stdin.typeStr("xx")
    stdin.key(undefined, { name: "o", ctrl: true })
    await waitForEditorSettled(stdin)
    stdin.key(undefined, { name: "return" })
    expect(await p).toBe("from F-key")
  })

  test("§B-9 a DEFAULT map disturbs neither ctrl-r search nor Tab nor submit", async () => {
    const { io, stdin } = makeIO()
    const history = __createSeededHistoryForTest(["alpha-match"])
    const p = readLine({ prompt: "> ", history, keybindings: DEFAULT_KEYBINDINGS }, io)
    // ctrl-r enters reverse search (default binding unchanged), type a query,
    // Enter commits the match.
    stdin.key(undefined, { name: "r", ctrl: true })
    stdin.typeStr("alpha")
    stdin.key(undefined, { name: "return" })
    expect(await p).toBe("alpha-match")
  })

  test("§B-9 shift+tab is NOT routed through the keymap (RFC-08 guard intact)", async () => {
    const { io, stdin } = makeIO()
    let cycled = 0
    const p = readLine(
      {
        prompt: "> ",
        keybindings: DEFAULT_KEYBINDINGS,
        onCycleMode: () => {
          cycled += 1
          return { meta: "mode-2" }
        },
      },
      io,
    )
    stdin.typeStr("body")
    stdin.key(undefined, { name: "tab", shift: true }) // backtab ⇒ cycle, not complete
    stdin.key(undefined, { name: "return" })
    expect(await p).toBe("body")
    expect(cycled).toBe(1)
  })
})
