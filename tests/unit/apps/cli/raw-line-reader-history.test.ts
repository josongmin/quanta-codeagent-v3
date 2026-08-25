import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { __createSeededHistoryForTest } from "../../../../src/apps/cli/prompt-history"
import { readLine } from "../../../../src/apps/cli/raw-line-reader"

/** Patch `process.stdin` + `process.stderr` with PassThrough streams so the
 *  raw-line-reader can be driven from a unit test. The reader uses keypress
 *  events on stdin and writes ANSI sequences to stderr (we discard the
 *  output — these tests only verify the resolved value). */
type StdinMock = PassThrough & {
  isTTY: boolean
  isRaw: boolean
  setRawMode: (b: boolean) => StdinMock
}

const mountFakeStdio = (): { stdin: StdinMock; restore: () => void } => {
  const originalStdin = process.stdin
  const originalStderrWrite = process.stderr.write.bind(process.stderr)
  const stdin = new PassThrough() as unknown as StdinMock
  stdin.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = (b: boolean): StdinMock => {
    stdin.isRaw = b
    return stdin
  }
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true })
  // Swallow stderr writes (escape codes) so they don't pollute test output.
  process.stderr.write = ((_chunk: unknown): boolean => true) as typeof process.stderr.write
  return {
    stdin,
    restore: (): void => {
      Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true })
      process.stderr.write = originalStderrWrite
    },
  }
}

/** Helper: drive a key sequence into the fake stdin, advancing the event
 *  loop after each chunk so the reader's keypress handler runs. */
const sendKeys = async (stdin: StdinMock, sequence: string): Promise<void> => {
  for (const ch of sequence) {
    stdin.write(ch)
    await new Promise<void>((r) => setImmediate(r))
  }
}

describe("raw-line-reader — history navigation", () => {
  let mock: ReturnType<typeof mountFakeStdio>
  beforeEach(() => {
    mock = mountFakeStdio()
  })
  afterEach(() => mock.restore())

  test("plain Enter submits the typed buf (byte-identical no-history path)", async () => {
    const p = readLine({ prompt: "› " })
    await sendKeys(mock.stdin, "hi\r")
    const out = await p
    expect(out).toBe("hi")
  })

  test("raw key activity is observable before Enter submits the draft", async () => {
    let activity = 0
    const p = readLine({
      prompt: "› ",
      onActivity: () => {
        activity++
      },
    })
    await sendKeys(mock.stdin, "draft")
    expect(activity).toBeGreaterThanOrEqual(5)
    await sendKeys(mock.stdin, "\r")
    expect(await p).toBe("draft")
  })

  test("↑ recalls the most recent history entry; Enter submits it", async () => {
    const history = __createSeededHistoryForTest(["echo one", "echo two"])
    const p = readLine({ prompt: "› ", history })
    // Send ESC[A (Up arrow). node:readline parses this as a keypress with
    // name="up". Two presses ⇒ "echo one"; one press ⇒ "echo two".
    await sendKeys(mock.stdin, "\x1b[A")
    await sendKeys(mock.stdin, "\r")
    const out = await p
    expect(out).toBe("echo two")
  })

  test("↑ ↑ then ↓ navigates older then newer", async () => {
    const history = __createSeededHistoryForTest(["alpha", "beta", "gamma"])
    const p = readLine({ prompt: "› ", history })
    await sendKeys(mock.stdin, "\x1b[A") // up → "gamma"
    await sendKeys(mock.stdin, "\x1b[A") // up → "beta"
    await sendKeys(mock.stdin, "\x1b[B") // down → "gamma"
    await sendKeys(mock.stdin, "\r")
    const out = await p
    expect(out).toBe("gamma")
  })

  test("Enter pushes the submitted line into history", async () => {
    const history = __createSeededHistoryForTest([])
    const p = readLine({ prompt: "› ", history })
    await sendKeys(mock.stdin, "first\r")
    await p
    expect(history.__snapshot()).toEqual(["first"])
  })

  test("history is NOT pushed when option omitted (byte-identical)", async () => {
    // No history option → no push side effect (we just verify no crash and
    // the buf still resolves cleanly).
    const p = readLine({ prompt: "› " })
    await sendKeys(mock.stdin, "raw\r")
    const out = await p
    expect(out).toBe("raw")
  })

  test("Ctrl+R enters reverse-i-search; typing filters; Enter commits", async () => {
    const history = __createSeededHistoryForTest(["git status", "ls -la", "git diff"])
    const p = readLine({ prompt: "› ", history })
    // Ctrl+R = 0x12
    await sendKeys(mock.stdin, "\x12")
    await sendKeys(mock.stdin, "git")
    await sendKeys(mock.stdin, "\r")
    const out = await p
    expect(out).toBe("git diff") // most recent match
  })

  test("Ctrl+R step (second Ctrl+R) walks to the older match", async () => {
    const history = __createSeededHistoryForTest(["git status", "ls -la", "git diff"])
    const p = readLine({ prompt: "› ", history })
    await sendKeys(mock.stdin, "\x12") // enter search mode
    await sendKeys(mock.stdin, "git")
    await sendKeys(mock.stdin, "\x12") // step to next-older match
    await sendKeys(mock.stdin, "\r")
    const out = await p
    expect(out).toBe("git status")
  })

  test("Ctrl+G in search mode cancels (returns to draft, Enter submits empty)", async () => {
    // We test with Ctrl+G (readline's `abort` chord) rather than bare Esc:
    // the node:readline keypress decoder buffers a lone `\x1b` waiting to
    // see if it's the start of an escape sequence, which makes the bare-Esc
    // cancel ambiguous to drive from a unit test. The keybinding is exercised
    // identically by either chord (same `cancelSearch()` path).
    const history = __createSeededHistoryForTest(["git diff"])
    const p = readLine({ prompt: "› ", history })
    await sendKeys(mock.stdin, "\x12") // Ctrl+R
    await sendKeys(mock.stdin, "g")
    await sendKeys(mock.stdin, "\x07") // Ctrl+G ⇒ cancel
    await sendKeys(mock.stdin, "\r")
    const out = await p
    expect(out).toBe("")
  })
})
