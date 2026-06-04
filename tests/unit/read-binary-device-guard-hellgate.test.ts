import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { readTool } from "@/tool/read"

// B5 device + binary read guard hellgate. Adversarial: a FIFO / device read
// would hang the agent loop forever (DoS); a binary read token-explodes garbage
// into the transcript. Every case here proves the `read` tool refuses BEFORE
// opening (device) or BEFORE rendering (binary), and that the FIFO case does
// NOT hang (the whole test is wrapped in bun's per-test timeout below).

const dir = mkdtempSync(join(tmpdir(), "read-guard-hellgate-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const run = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of readTool.execute(input as never, ctx(dir))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("read binary/device guard (B5)", () => {
  test("reading a FIFO is REJECTED device_file and does NOT hang", async () => {
    const fifo = join(dir, "pipe.fifo")
    // mkfifo creates a named pipe with no writer attached — an unguarded
    // read() blocks forever. The 5s per-test timeout is the hang tripwire.
    execFileSync("mkfifo", [fifo])
    const r = await run({ path: fifo })
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "device_file" })
    expect(r.output).toContain("device file")
  }, 5000)

  test("reading /dev/random (character device) is REJECTED device_file and does NOT hang", async () => {
    // /dev/random is an infinite character device; an unguarded read streams
    // forever. Jail is OFF so the absolute /dev path resolves.
    const prev = process.env.QUANTA_FS_JAIL
    process.env.QUANTA_FS_JAIL = "off"
    try {
      let result: ToolResult | undefined
      for await (const ev of readTool.execute({ path: "/dev/random" } as never, ctx("/"))) {
        if (ev.type === "result") result = ev.result
      }
      expect(result?.ok).toBe(false)
      expect(result?.failure).toEqual({ mode: "rejected", reason: "device_file" })
    } finally {
      if (prev === undefined) delete process.env.QUANTA_FS_JAIL
      else process.env.QUANTA_FS_JAIL = prev
    }
  }, 5000)

  test("a file containing a NUL byte is REJECTED binary_file", async () => {
    const f = join(dir, "blob.bin")
    // PNG-ish header: NUL appears in the first bytes (as it does for real
    // PNG/ZIP/ELF). The leading-window sniff catches it.
    writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a, 0x42]))
    const r = await run({ path: f })
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "binary_file" })
    expect(r.output).toContain("binary")
  })

  test("a NUL appearing only AFTER the sniff window is still allowed (bounded)", async () => {
    // Defense-in-depth note: the sniff is a BOUNDED 8KiB window — a NUL beyond
    // it is intentionally not scanned (git uses the same leading-window probe).
    // This proves the bound holds: a large text prefix followed by a late NUL
    // reads ok (text-classified by its head).
    const f = join(dir, "late-nul.txt")
    const head = "a".repeat(9000) // > 8 KiB of clean text
    writeFileSync(f, Buffer.concat([Buffer.from(head, "utf8"), Buffer.from([0x00])]))
    const r = await run({ path: f })
    expect(r.ok).toBe(true)
  })

  test("a normal UTF-8 text file reads ok with byte-identical content", async () => {
    const f = join(dir, "plain.txt")
    writeFileSync(f, "alpha\nbeta\ngamma")
    const r = await run({ path: f })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("1\talpha\n2\tbeta\n3\tgamma")
  })

  test("UTF-8 multibyte (high bytes, no NUL) is NOT falsely rejected", async () => {
    const f = join(dir, "unicode.txt")
    // Emoji + CJK + accented Latin: many bytes >= 0x80 but ZERO NUL bytes.
    // The NUL discriminator must NOT misclassify these as binary.
    const content = "héllo 世界 🚀 café ñoño"
    writeFileSync(f, content)
    const r = await run({ path: f })
    expect(r.ok).toBe(true)
    expect(r.output).toBe(`1\t${content}`)
  })

  test("an empty file is text (no NUL) and reads ok", async () => {
    const f = join(dir, "empty.txt")
    writeFileSync(f, "")
    const r = await run({ path: f })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("1\t")
  })

  test("device guard takes precedence — FIFO rejected even though it would also pass binary sniff", async () => {
    // Ordering invariant: the device check runs BEFORE the binary byte-read, so
    // we never attempt the hanging read() on a FIFO to sniff it.
    const fifo = join(dir, "pipe2.fifo")
    execFileSync("mkfifo", [fifo])
    const r = await run({ path: fifo })
    expect(r.failure).toEqual({ mode: "rejected", reason: "device_file" })
  }, 5000)
})
