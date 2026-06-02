/**
 * RFC-12 / ADR-0436 — raw-line-reader `@`-mention dropdown integration
 * hellgate. Drives an INJECTED keypress stream + a fake `AtCandidateProvider`
 * through `readLine`'s test-IO seam — NO real TTY, NO fs, NO LSP.
 *
 *   §7-1  @ trigger opens dropdown + initial list("")
 *   §7-2  typing filters (list called with the growing query)
 *   §7-3  accept (Tab / Enter) splices insertText
 *   §7-4  Esc dismiss leaves buf untouched
 *   §7-5  submit round-trips through parseMentions
 *   §7-6  race: stale list result discarded (epoch guard)
 *   §7-7  paste (multi-char) never triggers
 *   §7-8  left-boundary: @ after word does not trigger
 *   §7-9  provider throws ⇒ empty dropdown, input continues
 *   §7-10 multibyte: CJK label accepted (char-index consistency)
 *   §7-11 kind-grouped: file+symbol both flow through
 *   §7-12 DEFAULT-OFF byte-identical regression anchor
 */

import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { parseMentions } from "@/agent/mention-injection"
import type { AtCandidate, AtCandidateProvider } from "../at-autocomplete"
import { type ReadLineTestIO, readLine } from "../raw-line-reader"

interface KeyEvent {
  name?: string
  ctrl?: boolean
  sequence?: string
}

/** A minimal fake stdin that satisfies the reader's narrow `ReaderStdin`
 *  contract and lets a test emit `(str, key)` keypress pairs synchronously. */
class FakeStdin extends EventEmitter {
  readonly isTTY = false
  resume(): void {}
  pause(): void {}
  /** Emit one keypress pair, exactly as `node:readline` would. */
  key(str: string | undefined, key: KeyEvent = {}): void {
    this.emit("keypress", str, key)
  }
  /** Type a single printable char (str === char, key.name === char). */
  type(ch: string): void {
    this.key(ch, { name: ch, sequence: ch })
  }
  /** Type a string char-by-char (each as a single-char keypress). */
  typeStr(s: string): void {
    for (const ch of s) this.type(ch)
  }
}

/** Captures stdout writes so byte-identical regression can diff them. */
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
  const io: ReadLineTestIO = {
    stdin: stdin as unknown as ReadLineTestIO["stdin"],
    stdout,
    skipKeypressSetup: true,
  }
  return { io, stdin, stdout }
}

/** A synchronous fake provider that records every query + returns canned
 *  candidates. Resolution is via a settled promise so the reader's async
 *  `runAtList` completes on the next microtask. */
const fakeProvider = (
  candidatesFor: (query: string) => readonly AtCandidate[],
): { provider: AtCandidateProvider; queries: string[] } => {
  const queries: string[] = []
  return {
    queries,
    provider: {
      list: async (query: string): Promise<readonly AtCandidate[]> => {
        queries.push(query)
        return candidatesFor(query)
      },
    },
  }
}

const FILE_CANDS: readonly AtCandidate[] = [
  { kind: "file", insertText: "@src/util.ts", label: "src/util.ts", detail: "file" },
  { kind: "file", insertText: "@src/utils-log.ts", label: "src/utils-log.ts", detail: "file" },
]

/** Run one keypress script against `readLine` and resolve with the final
 *  submitted string + the captured stdout. The `script` runs AFTER the reader
 *  has attached its listener; microtask flushes let async `list()` settle. */
const drive = async (
  opts: Parameters<typeof readLine>[0],
  script: (
    stdin: FakeStdin,
    flush: () => Promise<void>,
    stdout: FakeStdout,
  ) => Promise<void> | void,
): Promise<{ result: string; stdout: string }> => {
  const { io, stdin, stdout } = makeIO()
  const flush = async (): Promise<void> => {
    // Three microtask turns: drain the awaited list() + the redraw chain.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  const p = readLine(opts, io)
  await script(stdin, flush, stdout)
  const result = await p
  return { result, stdout: stdout.bytes }
}

describe("readLine @-mention dropdown (RFC-12)", () => {
  test("§7-1 — @ at boundary opens dropdown + initial list('')", async () => {
    const { provider, queries } = fakeProvider(() => FILE_CANDS)
    const { result } = await drive({ prompt: "› ", atProvider: provider }, async (stdin, flush) => {
      stdin.type("@")
      await flush()
      expect(queries).toContain("")
      // Dismiss the dropdown first so the second Enter submits the raw buffer
      // (an Enter while the dropdown holds a selection ACCEPTS — see §7-3b).
      stdin.key("escape", { name: "escape" })
      stdin.key("return", { name: "return" })
    })
    expect(result).toBe("@")
  })

  test("§7-2 — typing filters: list() called with the growing query", async () => {
    const { provider, queries } = fakeProvider((q) => FILE_CANDS.filter((c) => c.label.includes(q)))
    await drive({ prompt: "› ", atProvider: provider }, async (stdin, flush) => {
      stdin.type("@")
      await flush()
      stdin.type("u")
      await flush()
      stdin.type("t")
      await flush()
      expect(queries).toEqual(["", "u", "ut"])
      stdin.key("escape", { name: "escape" })
      stdin.key("return", { name: "return" })
    })
  })

  test("§7-3 — accept via Tab splices insertText; cursor at end", async () => {
    const { provider } = fakeProvider(() => FILE_CANDS)
    const { result } = await drive({ prompt: "› ", atProvider: provider }, async (stdin, flush) => {
      stdin.typeStr("hi ")
      stdin.type("@")
      await flush()
      stdin.typeStr("ut")
      await flush()
      stdin.key("\t", { name: "tab" })
      await flush()
      stdin.key("return", { name: "return" })
    })
    expect(result).toBe("hi @src/util.ts")
  })

  test("§7-3b — accept via Enter (selection present) then submit", async () => {
    const { provider } = fakeProvider(() => FILE_CANDS)
    const { result } = await drive({ prompt: "› ", atProvider: provider }, async (stdin, flush) => {
      stdin.type("@")
      await flush()
      stdin.typeStr("ut")
      await flush()
      // Enter with a highlighted candidate commits, then a second Enter submits.
      stdin.key("return", { name: "return" })
      await flush()
      stdin.key("return", { name: "return" })
    })
    expect(result).toBe("@src/util.ts")
  })

  test("§7-4 — Esc dismiss leaves buf untouched", async () => {
    const { provider } = fakeProvider(() => FILE_CANDS)
    const { result } = await drive({ prompt: "› ", atProvider: provider }, async (stdin, flush) => {
      stdin.type("@")
      await flush()
      stdin.typeStr("ut")
      await flush()
      stdin.key("escape", { name: "escape" })
      await flush()
      stdin.key("return", { name: "return" })
    })
    expect(result).toBe("@ut")
  })

  test("§7-5 — submitted accepted mention round-trips through parseMentions", async () => {
    const { provider } = fakeProvider(() => FILE_CANDS)
    const { result } = await drive({ prompt: "› ", atProvider: provider }, async (stdin, flush) => {
      stdin.typeStr("see ")
      stdin.type("@")
      await flush()
      stdin.typeStr("ut")
      await flush()
      stdin.key("\t", { name: "tab" })
      await flush()
      stdin.key("return", { name: "return" })
    })
    expect(result).toBe("see @src/util.ts")
    const mentions = parseMentions(result)
    expect(mentions).toHaveLength(1)
    expect(mentions[0]?.kind).toBe("file")
    expect(mentions[0]?.target).toBe("src/util.ts")
  })

  test("§7-6 — race: a stale slow list() result is discarded (epoch guard)", async () => {
    // Provider where the SHORTER query resolves LAST. The reader must show the
    // candidates of the LATEST query ("ut"), not the stale "u".
    const queries: string[] = []
    let resolveU: ((c: readonly AtCandidate[]) => void) | null = null
    const provider: AtCandidateProvider = {
      list: async (q: string): Promise<readonly AtCandidate[]> => {
        queries.push(q)
        if (q === "u") {
          return await new Promise<readonly AtCandidate[]>((res) => {
            resolveU = res
          })
        }
        return [{ kind: "file", insertText: "@UT-LATEST", label: "UT-LATEST" }]
      },
    }
    const { result } = await drive({ prompt: "› ", atProvider: provider }, async (stdin, flush) => {
      stdin.type("@") // list("")
      await flush()
      stdin.type("u") // list("u") — hangs
      await flush()
      stdin.type("t") // list("ut") — resolves first
      await flush()
      // Now resolve the STALE "u" query late; it must be ignored.
      resolveU?.([{ kind: "file", insertText: "@U-STALE", label: "U-STALE" }])
      await flush()
      // Accept the highlighted candidate (must be the latest, "UT-LATEST").
      stdin.key("\t", { name: "tab" })
      await flush()
      stdin.key("return", { name: "return" })
    })
    expect(result).toBe("@UT-LATEST")
  })

  test("§7-7 — paste (multi-char str containing @) does NOT trigger", async () => {
    const { provider, queries } = fakeProvider(() => FILE_CANDS)
    const { result } = await drive({ prompt: "› ", atProvider: provider }, async (stdin, flush) => {
      // Single keypress carrying a multi-char string = a bracketed paste.
      stdin.key("foo@bar", { sequence: "foo@bar" })
      await flush()
      stdin.key("return", { name: "return" })
    })
    expect(result).toBe("foo@bar")
    expect(queries).toEqual([]) // dropdown never opened
  })

  test("§7-8 — @ immediately after a word char does NOT trigger", async () => {
    const { provider, queries } = fakeProvider(() => FILE_CANDS)
    const { result } = await drive({ prompt: "› ", atProvider: provider }, async (stdin, flush) => {
      stdin.typeStr("foo")
      stdin.type("@") // foo@ ⇒ email-like, no trigger
      await flush()
      stdin.key("return", { name: "return" })
    })
    expect(result).toBe("foo@")
    expect(queries).toEqual([])
  })

  test("§7-9 — provider throws ⇒ empty dropdown, input continues, submits raw", async () => {
    const provider: AtCandidateProvider = {
      list: async (): Promise<readonly AtCandidate[]> => {
        throw new Error("hostile provider")
      },
    }
    const { result } = await drive({ prompt: "› ", atProvider: provider }, async (stdin, flush) => {
      stdin.type("@")
      await flush()
      stdin.typeStr("ut")
      await flush()
      // No candidates ⇒ Tab cannot accept; Esc + submit yields the raw text.
      stdin.key("escape", { name: "escape" })
      stdin.key("return", { name: "return" })
    })
    expect(result).toBe("@ut")
  })

  test("§7-10 — multibyte CJK label accepted with char-index consistency", async () => {
    const provider: AtCandidateProvider = {
      list: async (): Promise<readonly AtCandidate[]> => [
        { kind: "file", insertText: "@자료/요약.ts", label: "자료/요약.ts", detail: "파일" },
      ],
    }
    const { result } = await drive({ prompt: "› ", atProvider: provider }, async (stdin, flush) => {
      stdin.typeStr("보다 ")
      stdin.type("@")
      await flush()
      stdin.type("자")
      await flush()
      stdin.key("\t", { name: "tab" })
      await flush()
      stdin.key("return", { name: "return" })
    })
    expect(result).toBe("보다 @자료/요약.ts")
  })

  test("§7-11 — kind-grouped: file + symbol candidates both surface + accept", async () => {
    const provider: AtCandidateProvider = {
      list: async (): Promise<readonly AtCandidate[]> => [
        { kind: "file", insertText: "@src/util.ts", label: "src/util.ts", detail: "file" },
        { kind: "symbol", insertText: "@Utf8Decoder", label: "Utf8Decoder", detail: "src/c.ts:9" },
      ],
    }
    const { result } = await drive(
      { prompt: "› ", atProvider: provider },
      async (stdin, flush, out) => {
        stdin.type("@")
        await flush()
        // both kind headers should be painted
        expect(out.bytes).toContain("file")
        expect(out.bytes).toContain("symbol")
        // move to the symbol row and accept
        stdin.key("down", { name: "down" })
        await flush()
        stdin.key("\t", { name: "tab" })
        await flush()
        stdin.key("return", { name: "return" })
      },
    )
    expect(result).toBe("@Utf8Decoder")
  })
})

describe("readLine @-mention DEFAULT-OFF byte-identical (§7-12 anchor)", () => {
  /** The same keypress script run with NO atProvider must (a) treat `@` as an
   *  ordinary char and (b) emit IDENTICAL stdout bytes + final string to a
   *  build that never knew about the feature. We assert against the literal
   *  expected buffer (the regression anchor). */
  test("§7-12a — @ is an ordinary input char with no provider", async () => {
    const { result } = await drive({ prompt: "› " }, async (stdin) => {
      stdin.typeStr("hi @src/util.ts ok")
      stdin.key("return", { name: "return" })
    })
    expect(result).toBe("hi @src/util.ts ok")
  })

  test("§7-12b — identical stdout bytes with vs without provider for non-@ input", async () => {
    const script = (stdin: FakeStdin): void => {
      stdin.typeStr("hello world")
      stdin.key("left", { name: "left" })
      stdin.key("backspace", { name: "backspace" })
      stdin.key("return", { name: "return" })
    }
    const a = await drive({ prompt: "› " }, script)
    const { provider } = fakeProvider(() => FILE_CANDS)
    const b = await drive({ prompt: "› ", atProvider: provider }, script)
    // Input contains no boundary @, so the provider is never consulted and the
    // byte stream + result must match exactly.
    expect(b.result).toBe(a.result)
    expect(b.stdout).toBe(a.stdout)
  })

  test("§7-12c — slash palette byte-identical with vs without provider", async () => {
    const completer = (line: string): readonly string[] =>
      line.startsWith("/") ? ["/help", "/exit"].filter((c) => c.startsWith(line)) : []
    const script = (stdin: FakeStdin): void => {
      stdin.typeStr("/he")
      stdin.key("down", { name: "down" })
      stdin.key("\t", { name: "tab" })
      stdin.key("return", { name: "return" })
    }
    const a = await drive({ prompt: "› ", completer }, script)
    const { provider } = fakeProvider(() => FILE_CANDS)
    const b = await drive({ prompt: "› ", completer, atProvider: provider }, script)
    expect(b.result).toBe(a.result)
    expect(b.stdout).toBe(a.stdout)
    expect(a.result).toBe("/help")
  })
})
