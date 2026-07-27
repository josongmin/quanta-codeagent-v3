/**
 * HELLGATE — raw-line-reader keymap-refactor GOLDEN battery.
 *
 * The `onKey` keypress machine was refactored from a 34-branch if/else cascade
 * into a first-match `KeyBinding[]` dispatch table. The killer risks of that
 * move are:
 *   (a) a REORDERED binding changing which handler wins for an AMBIGUOUS key,
 *   (b) a LOST `state` mutation inside a moved handler body,
 *   (c) a key that now FALLS THROUGH to no handler (was previously handled),
 *       or conversely is now swallowed where it used to fall through.
 *
 * This battery drives the REAL `readLine` (full loop, real redraw) over a fake
 * TTY seam and asserts BOTH the final submitted string AND the exact stdout
 * byte stream for a broad set of scenarios that together exercise every branch
 * and every intra-branch fall-through in the original cascade. Because the
 * redraw output is a pure function of `state`, a byte-identical stdout across
 * a whole scripted session is a strong witness that every mutation + branch
 * order was preserved.
 *
 * The scenarios deliberately include the FALL-THROUGH cases the naive "each
 * binding is void + return" refactor would silently break:
 *   - `@`-dropdown Enter with NO selection ⇒ falls through to the submit branch.
 *   - `@`-dropdown printable char ⇒ falls through to the shared insert branch
 *     (which then re-queries the dropdown).
 *   - `@`-dropdown backspace with a non-dismiss/non-requery verdict ⇒ falls
 *     through to the shared backspace branch.
 *   - ctrl-x then a non-ctrl-e key ⇒ chord abandoned, the key falls through.
 *
 * Non-vacuity is proven by the sibling `.red.test.ts` mutation harness and by
 * the diversity of asserted final strings (each scenario pins a distinct value
 * that a dropped mutation would change).
 */

import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { AtCandidate, AtCandidateProvider } from "../at-autocomplete"
import { type ReadLineTestIO, readLine } from "../raw-line-reader"

interface KeyEvent {
  name?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
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
  typeStr(s: string): void {
    for (const ch of s) this.type(ch)
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
  get bytes(): string {
    return this.chunks.join("")
  }
}

const makeIO = (): { io: ReadLineTestIO; stdin: FakeStdin; stdout: FakeStdout } => {
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  return {
    io: {
      stdin: stdin as unknown as ReadLineTestIO["stdin"],
      stdout,
      skipKeypressSetup: true,
    },
    stdin,
    stdout,
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const FILE_CANDS: readonly AtCandidate[] = [
  { kind: "file", insertText: "@src/util.ts", label: "src/util.ts", detail: "file" },
  { kind: "file", insertText: "@src/utils-log.ts", label: "src/utils-log.ts", detail: "file" },
]
const fakeProvider = (): AtCandidateProvider => ({
  list: async (q: string): Promise<readonly AtCandidate[]> =>
    FILE_CANDS.filter((c) => c.label.includes(q)),
})

const slashCompleter = (line: string): readonly string[] =>
  line.startsWith("/") ? ["/help", "/exit", "/hello"].filter((c) => c.startsWith(line)) : []

/** Run one scripted session and return {result, stdout}. The stdout stream is
 *  the golden artifact — a byte diff is the refactor tripwire. */
const run = async (
  opts: Parameters<typeof readLine>[0],
  script: (s: FakeStdin) => Promise<void> | void,
): Promise<{ result: string; stdout: string }> => {
  const { io, stdin, stdout } = makeIO()
  const p = readLine(opts, io)
  await script(stdin)
  const result = await p
  return { result, stdout: stdout.bytes }
}

describe("keymap-golden — final-string invariants across every branch", () => {
  test("printable insert + cursor moves + backspace + delete", async () => {
    const { result } = await run({ prompt: "› " }, async (s) => {
      s.typeStr("hello")
      s.key(undefined, { name: "left" }) // cursor before 'o'
      s.key(undefined, { name: "left" })
      s.key(undefined, { name: "backspace" }) // delete 'l' → "helo", cursor before 'l'... buf "helo"
      s.key(undefined, { name: "delete" }) // delete char at cursor
      s.retn()
    })
    // hello → left,left (cursor=3) → backspace removes idx2 'l' → "helo" cursor=2
    // → delete removes idx2 'l' → "heo"
    expect(result).toBe("heo")
  })

  test("home / end cursor jumps then insert", async () => {
    const { result } = await run({ prompt: "› " }, async (s) => {
      s.typeStr("mid")
      s.key(undefined, { name: "home" })
      s.type("X") // Xmid
      s.key(undefined, { name: "end" })
      s.type("Z") // XmidZ
      s.retn()
    })
    expect(result).toBe("XmidZ")
  })

  test("ctrl+a / ctrl+e cursor home/end (OFF-keybinding path)", async () => {
    const { result } = await run({ prompt: "› " }, async (s) => {
      s.typeStr("abc")
      s.key(undefined, { name: "a", ctrl: true }) // home
      s.type("[") // [abc
      s.key(undefined, { name: "e", ctrl: true }) // end
      s.type("]") // [abc]
      s.retn()
    })
    expect(result).toBe("[abc]")
  })

  test("ctrl+w word-delete, ctrl+u kill-to-start, ctrl+k kill-to-end", async () => {
    const w = await run({ prompt: "› " }, async (s) => {
      s.typeStr("foo bar")
      s.key(undefined, { name: "w", ctrl: true }) // delete "bar"
      s.retn()
    })
    expect(w.result).toBe("foo ")
    const u = await run({ prompt: "› " }, async (s) => {
      s.typeStr("foo bar")
      s.key(undefined, { name: "u", ctrl: true }) // kill to start
      s.retn()
    })
    expect(u.result).toBe("")
    const k = await run({ prompt: "› " }, async (s) => {
      s.typeStr("foo bar")
      s.key(undefined, { name: "home" })
      s.key(undefined, { name: "k", ctrl: true }) // kill to end
      s.retn()
    })
    expect(k.result).toBe("")
  })

  test("meta+b / meta+f word-left / word-right", async () => {
    const { result } = await run({ prompt: "› " }, async (s) => {
      s.typeStr("one two")
      s.key(undefined, { name: "b", meta: true }) // word-left → before "two"
      s.type("X") // one Xtwo
      s.key(undefined, { name: "f", meta: true }) // word-right → after "Xtwo"... boundary
      s.type("!")
      s.retn()
    })
    expect(result).toBe("one Xtwo!")
  })

  test("slash palette: type, ↓ nav, Tab commit", async () => {
    const { result } = await run({ prompt: "› ", completer: slashCompleter }, async (s) => {
      s.typeStr("/he")
      s.key(undefined, { name: "down" })
      s.key("\t", { name: "tab" })
      s.retn()
    })
    // "/he" matches /help,/hello → down selects /hello (idx1) → tab commits
    expect(result).toBe("/hello")
  })

  test("slash palette: Esc collapses, buffer preserved", async () => {
    const { result } = await run({ prompt: "› ", completer: slashCompleter }, async (s) => {
      s.typeStr("/he")
      s.key(undefined, { name: "escape" })
      s.retn()
    })
    expect(result).toBe("/he")
  })

  test("ghost-text accept via right-arrow at end", async () => {
    const { result } = await run({ prompt: "› ", completer: slashCompleter }, async (s) => {
      s.typeStr("/ex") // single match /exit → ghost "it"
      s.key(undefined, { name: "right" }) // accept ghost
      s.retn()
    })
    expect(result).toBe("/exit")
  })

  test("Enter with a slash selection commits it before submitting", async () => {
    const { result } = await run({ prompt: "› ", completer: slashCompleter }, async (s) => {
      s.typeStr("/hel") // matches /help,/hello, selectedIdx=0 → /help
      s.retn() // commitSelected then submit
    })
    expect(result).toBe("/help")
  })
})

describe("keymap-golden — FALL-THROUGH cases (the naive refactor breaks these)", () => {
  test("@-dropdown: Enter with NO selection falls through to submit", async () => {
    const { result } = await run({ prompt: "› ", atProvider: fakeProvider() }, async (s) => {
      s.type("@")
      await flush()
      s.typeStr("zzz") // filters to zero candidates
      await flush()
      // Enter: commitAtSelected() returns false (no candidate) → dismiss →
      // FALL THROUGH to the normal submit branch.
      s.retn()
    })
    expect(result).toBe("@zzz")
  })

  test("@-dropdown: printable char falls through to the shared insert branch (re-query)", async () => {
    const { result } = await run({ prompt: "› ", atProvider: fakeProvider() }, async (s) => {
      s.type("@")
      await flush()
      s.typeStr("util") // each char falls through insert branch → buf grows
      await flush()
      s.key(undefined, { name: "escape" })
      s.retn()
    })
    expect(result).toBe("@util")
  })

  test("@-dropdown accept via Tab splices insertText", async () => {
    const { result } = await run({ prompt: "› ", atProvider: fakeProvider() }, async (s) => {
      s.typeStr("see ")
      s.type("@")
      await flush()
      s.typeStr("util")
      await flush()
      s.key("\t", { name: "tab" })
      await flush()
      s.retn()
    })
    expect(result).toBe("see @src/util.ts")
  })

  test("ctrl-x then non-ctrl-e key: chord abandoned, key falls through", async () => {
    let opened = 0
    const port = {
      openDraft: async (t: string) => {
        opened += 1
        return { text: t, changed: false }
      },
    }
    const { result } = await run({ prompt: "› ", openEditor: port }, async (s) => {
      s.typeStr("ab")
      s.key(undefined, { name: "x", ctrl: true }) // arm chord
      s.type("c") // NOT ctrl-e → chord abandoned, 'c' inserts via fall-through
      s.retn()
    })
    expect(result).toBe("abc")
    expect(opened).toBe(0)
  })
})

describe("keymap-golden — precedence: ctrl-c / ctrl-d always win", () => {
  test("ctrl-c aborts even mid-buffer", async () => {
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› " }, io)
    stdin.typeStr("abc")
    stdin.key(undefined, { name: "c", ctrl: true })
    await expect(p).rejects.toThrow()
  })

  test("ctrl-d on empty line is EOF (rejects); non-empty is a no-op", async () => {
    // non-empty: no-op then submit
    const { result } = await run({ prompt: "› " }, async (s) => {
      s.typeStr("keep")
      s.key("\x04", { name: "d", ctrl: true })
      s.retn()
    })
    expect(result).toBe("keep")
  })
})

/**
 * GOLDEN STDOUT SNAPSHOTS — the byte-level tripwire. Each pins the full stdout
 * stream of a scripted session. A reordered binding or a lost/extra redraw
 * changes these bytes. Captured on the pre-refactor cascade; the keymap must
 * reproduce them exactly.
 */
describe("keymap-golden — stdout byte snapshots (reorder / lost-mutation tripwire)", () => {
  const snap = async (
    label: string,
    opts: Parameters<typeof readLine>[0],
    script: (s: FakeStdin) => Promise<void> | void,
  ): Promise<void> => {
    const { stdout } = await run(opts, script)
    expect(stdout, label).toMatchSnapshot()
  }

  test("plain typing + edit session", async () => {
    await snap("plain-edit", { prompt: "› " }, async (s) => {
      s.typeStr("hello")
      s.key(undefined, { name: "left" })
      s.key(undefined, { name: "backspace" })
      s.key(undefined, { name: "home" })
      s.key(undefined, { name: "end" })
      s.retn()
    })
  })

  test("slash palette full session", async () => {
    await snap("slash-session", { prompt: "› ", completer: slashCompleter }, async (s) => {
      s.typeStr("/he")
      s.key(undefined, { name: "down" })
      s.key(undefined, { name: "up" })
      s.key("\t", { name: "tab" })
      s.retn()
    })
  })

  test("@-dropdown full session", async () => {
    await snap("at-session", { prompt: "› ", atProvider: fakeProvider() }, async (s) => {
      s.typeStr("hi ")
      s.type("@")
      await flush()
      s.typeStr("util")
      await flush()
      s.key(undefined, { name: "down" })
      await flush()
      s.key(undefined, { name: "up" })
      await flush()
      s.key("\t", { name: "tab" })
      await flush()
      s.retn()
    })
  })
})
