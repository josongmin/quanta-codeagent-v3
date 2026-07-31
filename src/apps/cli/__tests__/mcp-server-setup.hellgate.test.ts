/**
 * ★ HELLGATE — TICKET-19 reverse-MCP composition root (`runMcpServerCmd`).
 *
 * `quanta mcp-server` turns quanta INTO an MCP server an external client can
 * drive over stdio. That is an RCE surface, so this gate is adversarial about:
 *
 *   A. DEFAULT-OFF byte-identity — `QUANTA_MCP_SERVER` unset ⇒ exit 64, NOTHING
 *      assembled, stdout EMPTY (no agent config, no LLM, no FS touch).
 *   B. RCE-deny default — with the gate ON, an end-to-end stdin script
 *      (initialize → tools/list → tools/call read) round-trips over an in-memory
 *      pump and `bash`/`write` are ABSENT from tools/list AND a `tools/call bash`
 *      is `-32602` (the dispatcher is never reached).
 *   C. red-on-injection — a would-mutate `write` call is denied by the whitelist;
 *      and even force-opted-in via QUANTA_MCP_SERVER_EXPOSE it STILL hits the
 *      permission gate (surfaces as isError, NOT a raw file write).
 *   D. stdout stays PURE JSON-RPC — the start banner goes to STDERR only.
 *   E. --help short-circuits BEFORE any config assembly (exit 0).
 *
 * The composition root is driven through an injected IO seam so no real
 * process.stdin / FS / API key is needed.
 */

import { describe, expect, test } from "bun:test"
import { runMcpServerCmd } from "../mcp-server-setup"

/** In-memory IO seam mirroring the command's `McpServerCmdIo`. */
interface FakeIo {
  out: string[]
  err: string[]
  stdinScript: string[]
  io: {
    out: (s: string) => void
    err: (s: string) => void
    stdin: AsyncIterable<Uint8Array>
  }
}

const fakeIo = (stdinScript: string[] = []): FakeIo => {
  const out: string[] = []
  const err: string[] = []
  const enc = new TextEncoder()
  return {
    out,
    err,
    stdinScript,
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      stdin: {
        async *[Symbol.asyncIterator]() {
          for (const line of stdinScript) yield enc.encode(line.endsWith("\n") ? line : `${line}\n`)
        },
      },
    },
  }
}

/** All JSON-RPC frames the command wrote to stdout, parsed. */
const stdoutFrames = (io: FakeIo): Array<Record<string, unknown>> =>
  io.out
    .join("")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

const frame = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })

const withEnv = async <T>(
  patch: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> => {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k]
    if (patch[k] === undefined) delete process.env[k]
    else process.env[k] = patch[k]
  }
  try {
    return await fn()
  } finally {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

describe("A. default-OFF byte-identity", () => {
  test("QUANTA_MCP_SERVER unset ⇒ exit 64, stdout EMPTY, stderr explains", async () => {
    await withEnv({ QUANTA_MCP_SERVER: undefined }, async () => {
      const io = fakeIo()
      const code = await runMcpServerCmd([], io.io)
      expect(code).toBe(64)
      expect(io.out.join("")).toBe("")
      expect(io.err.join("")).toContain("QUANTA_MCP_SERVER=1")
    })
  })

  test("loose 'on' is REFUSED (strict === '1' security gate)", async () => {
    await withEnv({ QUANTA_MCP_SERVER: "on" }, async () => {
      const io = fakeIo()
      const code = await runMcpServerCmd([], io.io)
      expect(code).toBe(64)
      expect(io.out.join("")).toBe("")
    })
  })
})

describe("E. --help short-circuits before assembly", () => {
  test("--help ⇒ exit 0, usage on stdout, no JSON-RPC frames", async () => {
    // Help must NOT require the gate or an API key — it returns before assembly.
    await withEnv({ QUANTA_MCP_SERVER: undefined }, async () => {
      const io = fakeIo()
      const code = await runMcpServerCmd(["--help"], io.io)
      expect(code).toBe(0)
      expect(io.out.join("")).toContain("mcp-server")
    })
  })
})

describe("B+C+D. gate ON — RCE-deny default + permission gate + pure stdout", () => {
  // These require an LLM API key to assemble the parent config. Skip cleanly
  // when no key is present so the suite stays green in keyless CI; the assertions
  // run wherever a key IS configured (the orchestrator's live lane).
  const haveKey =
    process.env.OPENAI_API_KEY !== undefined || process.env.ANTHROPIC_API_KEY !== undefined

  test.if(haveKey)(
    "round-trip: bash/write ABSENT from tools/list; tools/call bash ⇒ -32602; banner on STDERR",
    async () => {
      await withEnv({ QUANTA_MCP_SERVER: "1", QUANTA_MCP_SERVER_EXPOSE: undefined }, async () => {
        const io = fakeIo([
          frame(1, "initialize", { protocolVersion: "2025-06-18" }),
          frame(2, "tools/list"),
          frame(3, "tools/call", { name: "bash", arguments: { command: "echo pwned" } }),
        ])
        const code = await runMcpServerCmd([], io.io)
        expect(code).toBe(0)

        const frames = stdoutFrames(io)
        // initialize replied.
        const init = frames.find((f) => f.id === 1)
        expect(init?.result).toBeDefined()

        // tools/list NEVER exposes a mutating tool by default.
        const list = frames.find((f) => f.id === 2)
        const names = (list?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
        expect(names).not.toContain("bash")
        expect(names).not.toContain("write")
        expect(names.length).toBeGreaterThan(0) // read-only tools DO show.

        // tools/call bash ⇒ -32602, dispatcher never reached.
        const call = frames.find((f) => f.id === 3)
        expect((call?.error as { code: number }).code).toBe(-32602)

        // stdout is PURE JSON-RPC; the banner is on stderr only.
        expect(io.err.join("")).toContain("quanta MCP server")
        for (const line of io.out
          .join("")
          .split("\n")
          .filter((l) => l.trim().length > 0)) {
          expect(() => JSON.parse(line)).not.toThrow()
        }
      })
    },
  )

  test.if(haveKey)(
    "force-opted-in mutating tool STILL hits the permission gate (isError, not a raw write)",
    async () => {
      await withEnv({ QUANTA_MCP_SERVER: "1", QUANTA_MCP_SERVER_EXPOSE: "write" }, async () => {
        const target = `${process.cwd()}/.tmp-mcp-rce-probe-${Date.now()}.txt`
        const io = fakeIo([
          frame(1, "initialize"),
          frame(2, "tools/call", {
            name: "write",
            arguments: { path: target, content: "PWNED" },
          }),
        ])
        const { existsSync, rmSync } = await import("node:fs")
        try {
          const code = await runMcpServerCmd([], io.io)
          expect(code).toBe(0)

          // HONEST ASSERTION (load-bearing): `runMcpServerCmd` now DRAINS every
          // in-flight dispatch before returning, so this `existsSync` sees the
          // settled state — it no longer races ahead of an async write. The file
          // must NOT exist: the fail-closed `default`-mode permission gate
          // collapsed the opted-in write's `ask` to a DENY. (Regression guard:
          // if the dispatch reused the headless `acceptEdits` permission, the
          // write WOULD land before drain returns and this would go red.)
          expect(existsSync(target)).toBe(false)

          // …and the denial surfaces as an `isError` tool_result, NOT a -32602
          // (the tool IS whitelisted via QUANTA_MCP_SERVER_EXPOSE — it reaches
          // the dispatcher, which blocks it), and NOT a raw FS breakout.
          const reply = stdoutFrames(io).find((f) => f.id === 2)
          expect(reply?.error).toBeUndefined()
          expect((reply?.result as { isError?: boolean }).isError).toBe(true)
        } finally {
          // Defense-in-depth: if a regression DID write the probe, never leave it
          // in the repo tree.
          if (existsSync(target)) rmSync(target)
        }
      })
    },
  )
})
