import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { readLine } from "../../../../src/apps/cli/raw-line-reader"

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
  process.stderr.write = ((_chunk: unknown): boolean => true) as typeof process.stderr.write
  return {
    stdin,
    restore: (): void => {
      Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true })
      process.stderr.write = originalStderrWrite
    },
  }
}

const sendKeys = async (stdin: StdinMock, sequence: string): Promise<void> => {
  for (const ch of sequence) {
    stdin.write(ch)
    await new Promise<void>((r) => setImmediate(r))
  }
}

describe("raw-line-reader — heredoc multiline", () => {
  let mock: ReturnType<typeof mountFakeStdio>
  beforeEach(() => {
    mock = mountFakeStdio()
  })
  afterEach(() => mock.restore())

  test("multiline=false: triple-quote line submits as-is (byte-identical)", async () => {
    const p = readLine({ prompt: "› " })
    await sendKeys(mock.stdin, '"""\r')
    const out = await p
    expect(out).toBe('"""')
  })

  test("triple-quote opens heredoc; second triple-quote closes; lines joined by \\n", async () => {
    const p = readLine({ prompt: "› ", multiline: true })
    await sendKeys(mock.stdin, '"""\r') // open
    await sendKeys(mock.stdin, "line one\r")
    await sendKeys(mock.stdin, "line two\r")
    await sendKeys(mock.stdin, '"""\r') // close
    const out = await p
    expect(out).toBe("line one\nline two")
  })

  test("triple-backtick fence is also supported", async () => {
    const p = readLine({ prompt: "› ", multiline: true })
    await sendKeys(mock.stdin, "'''\r")
    await sendKeys(mock.stdin, "hello\r")
    await sendKeys(mock.stdin, "'''\r")
    const out = await p
    expect(out).toBe("hello")
  })

  test("closing fence must match the opening fence (mismatched is body text)", async () => {
    const p = readLine({ prompt: "› ", multiline: true })
    await sendKeys(mock.stdin, '"""\r') // open with """
    await sendKeys(mock.stdin, "'''\r") // mismatched: body, not close
    await sendKeys(mock.stdin, '"""\r') // close
    const out = await p
    expect(out).toBe("'''")
  })

  test("empty heredoc body yields empty string", async () => {
    const p = readLine({ prompt: "› ", multiline: true })
    await sendKeys(mock.stdin, '"""\r')
    await sendKeys(mock.stdin, '"""\r')
    const out = await p
    expect(out).toBe("")
  })

  test("non-fence single-line submit still works in multiline mode", async () => {
    const p = readLine({ prompt: "› ", multiline: true })
    await sendKeys(mock.stdin, "regular line\r")
    const out = await p
    expect(out).toBe("regular line")
  })
})
