import { describe, expect, test } from "bun:test"
import type { ToolContext, ToolEvent } from "../types"
import type { ContainerExec, ContainerExecResult } from "./port"
import { buildWriteCommand, containerWriteFileTool, MAX_WRITE_BYTES } from "./write-tool"

const ctx = { signal: new AbortController().signal } as ToolContext
const run = async (tool: ReturnType<typeof containerWriteFileTool>, input: unknown) => {
  let last: ToolEvent | undefined
  for await (const e of tool.execute(input as never, ctx)) last = e
  if (last?.type !== "result") throw new Error("no result")
  return last.result
}
/** Fake port scripting one result; records the exact command handed to the transport. */
const fakePort = (impl: (cmd: string) => Promise<ContainerExecResult>) => {
  const commands: string[] = []
  const port: ContainerExec = {
    exec: (cmd) => {
      commands.push(cmd)
      return impl(cmd)
    },
  }
  return { port, commands }
}
/** The wc -c readback a healthy overwrite returns for `content`. */
const wcOf = (content: string) => `${Buffer.byteLength(content, "utf8")}\n`

describe("container_write_file — exact-byte authoring over the exec port (B2)", () => {
  test("round-trip: the command's base64 payload decodes to EXACTLY the input content", async () => {
    // The mangle-prone shapes heredocs get wrong: quotes, EOF marker, $interp, backticks, CRLF, unicode.
    const nasty = "line1 'single' \"double\"\nEOF\n$HOME `id` \\ \r\n한글 ✓  -free"
    const { port, commands } = fakePort(async () => ({ stdout: wcOf(nasty), stderr: "", code: 0 }))
    const r = await run(containerWriteFileTool(port), { path: "/app/solve.py", content: nasty })
    expect(r.ok).toBe(true)
    const m = commands[0]?.match(/printf '%s' '([A-Za-z0-9+/=]*)'/)
    expect(m).not.toBeNull()
    expect(Buffer.from(m?.[1] ?? "", "base64").toString("utf8")).toBe(nasty)
    // shape: mkdir -p parent, single overwrite redirect, wc readback
    expect(commands[0]).toContain(`mkdir -p "$(dirname '/app/solve.py')"`)
    expect(commands[0]).toContain("> '/app/solve.py'")
    expect(commands[0]).toContain("wc -c < '/app/solve.py'")
  })

  test("fresh-readback verify: a byte-count MISMATCH (silent truncation) is a typed failure", async () => {
    const { port } = fakePort(async () => ({ stdout: "3\n", stderr: "", code: 0 })) // wrote 3 of 11 bytes
    const r = await run(containerWriteFileTool(port), { path: "/app/x", content: "hello world" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("INCOMPLETE")
    expect(r.output).toContain("11")
  })

  test("clean overwrite: verified byte count ⇒ ok with the count in the output", async () => {
    const content = "print('hi')\n"
    const { port } = fakePort(async () => ({ stdout: wcOf(content), stderr: "", code: 0 }))
    const r = await run(containerWriteFileTool(port), { path: "solve.py", content })
    expect(r.ok).toBe(true)
    expect(r.output).toContain(`${Buffer.byteLength(content, "utf8")} bytes`)
    expect(r.evidence?.exitCode).toBe(0)
  })

  test("append mode: `>>` redirect, NO wc readback (total unknowable host-side), ok on exit 0", async () => {
    const { port, commands } = fakePort(async () => ({ stdout: "", stderr: "", code: 0 }))
    const r = await run(containerWriteFileTool(port), {
      path: "/app/big.txt",
      content: "chunk-2",
      append: true,
    })
    expect(r.ok).toBe(true)
    expect(commands[0]).toContain(">> '/app/big.txt'")
    expect(commands[0]).not.toContain("wc -c")
  })

  test("non-zero exit (disk full / no perms) ⇒ typed error with stderr surfaced", async () => {
    const { port } = fakePort(async () => ({
      stdout: "",
      stderr: "sh: cannot create /ro/x: Read-only file system",
      code: 1,
    }))
    const r = await run(containerWriteFileTool(port), { path: "/ro/x", content: "y" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("exit 1")
    expect(r.output).toContain("Read-only file system")
  })

  test("path guard is FAIL-CLOSED: single quotes / newlines are rejected before any exec", async () => {
    const { port, commands } = fakePort(async () => ({ stdout: "", stderr: "", code: 0 }))
    for (const bad of ["/app/it's.txt", "/app/a\nb", "a'b"]) {
      const r = await run(containerWriteFileTool(port), { path: bad, content: "x" })
      expect(r.ok).toBe(false)
      expect(r.failure?.mode).toBe("rejected")
    }
    expect(commands).toHaveLength(0) // nothing ever reached the transport
  })

  test("over-cap content ⇒ typed failure steering to append-chunking (never silent truncation)", async () => {
    const { port, commands } = fakePort(async () => ({ stdout: "", stderr: "", code: 0 }))
    const big = "A".repeat(MAX_WRITE_BYTES + 1)
    const r = await run(containerWriteFileTool(port), { path: "/app/big", content: big })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("append")
    expect(commands).toHaveLength(0)
  })

  test("a timed-out transport result ⇒ typed timeout failure, file state flagged UNKNOWN", async () => {
    const { port } = fakePort(async () => ({ stdout: null, stderr: null, code: 124, timedOut: true }))
    const r = await run(containerWriteFileTool(port), { path: "/app/x", content: "y" })
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("timeout")
    expect(r.output).toContain("UNKNOWN")
  })

  test("extractShellCommand exposes the EXACT constructed command (HARD_DENY sees what runs)", () => {
    const { port } = fakePort(async () => ({ stdout: "", stderr: "", code: 0 }))
    const tool = containerWriteFileTool(port)
    const input = { path: "/app/f.txt", content: "hi" }
    const b64 = Buffer.from("hi", "utf8").toString("base64")
    expect(tool.extractShellCommand?.(input as never)).toBe(
      buildWriteCommand("/app/f.txt", b64, false),
    )
    // unparseable input ⇒ empty screen string (execute rejects it before any exec anyway)
    expect(tool.extractShellCommand?.({ path: 1 } as never)).toBe("")
  })

  test("backend throw ⇒ ok:false typed error (NO-THROW contract)", async () => {
    const port: ContainerExec = {
      exec: async () => {
        throw new Error("bridge gone")
      },
    }
    const r = await run(containerWriteFileTool(port), { path: "/app/x", content: "y" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("bridge gone")
  })
})
