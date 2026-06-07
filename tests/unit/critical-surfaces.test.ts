/**
 * Critical-surface regression pins for the 7 structural fixes from the
 * 3-round audit. Each block tests the CONTRACT (root-cause invariant), not
 * a specific code path — so a future refactor can rearrange the
 * implementation as long as the contract holds.
 *
 *   S1  — `LLMError` carries a typed `kind`; `isFallbackTrigger` reads it.
 *   S5  — `runtimeConfig().logLevel` validates `QUANTA_LOG_LEVEL` (no `as`).
 *   S14 — `resolveJailed` refuses an empty jail root + rejects escape paths.
 *   S15 — JSON-RPC envelope rejects messages without `jsonrpc:"2.0"`.
 *   S16 — `hardDenyReason` fires on ANY action with a non-empty
 *         `shellCommand`, not just `tool === "bash"`.
 *   S17 — `TaskRegistry.stop` requires the matching `ownerToken`.
 *   S19 — `loadSessionById` refuses a session whose messages don't
 *         shape-check (zod-deep, not envelope-only).
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  isWireEnvelope,
  PORTABLE_SESSION_VERSION,
  PortableSessionImportError,
  parsePortableSession,
} from "@/ipc"
import { isFallbackTrigger } from "@/llm"
import { hardDenyReason } from "@/permission"
import { __resetRuntimeConfig, LLMError, runtimeConfig } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"
import { TaskRegistry } from "@/subagent"

// ── S1: typed LLMError ──────────────────────────────────────────────────────

describe("S1 LLMError typed cause", () => {
  test("overloaded kind triggers fallback regardless of message text", () => {
    const e = new LLMError("any phrasing here", { kind: "overloaded" })
    expect(isFallbackTrigger(e)).toBe(true)
  })

  test("auth kind does NOT trigger fallback even when message contains '529'", () => {
    const e = new LLMError("auth failed: 529 chars of bad input", { kind: "auth" })
    expect(isFallbackTrigger(e)).toBe(false)
  })

  test("non-LLMError NEVER triggers fallback", () => {
    expect(isFallbackTrigger(new Error("overloaded 529"))).toBe(false)
  })

  test("network kind triggers fallback (peer reachability — try other provider)", () => {
    expect(isFallbackTrigger(new LLMError("transport", { kind: "network" }))).toBe(true)
  })

  test("fromSdkError classifies status 529 as overloaded", () => {
    const sdkErr = { status: 529, message: "overloaded" }
    const e = LLMError.fromSdkError("anthropic", sdkErr)
    expect(e.kind).toBe("overloaded")
    expect(e.statusCode).toBe(529)
  })

  test("fromSdkError classifies status 401 as auth", () => {
    const e = LLMError.fromSdkError("openai", { status: 401, message: "invalid key" })
    expect(e.kind).toBe("auth")
  })

  test("fromSdkError classifies node transport code ECONNRESET as network", () => {
    const e = LLMError.fromSdkError("anthropic", { code: "ECONNRESET", message: "reset" })
    expect(e.kind).toBe("network")
  })
})

// ── S5: runtime-config validates env ────────────────────────────────────────

describe("S5 runtimeConfig validates QUANTA_LOG_LEVEL (no `as LogLevel`)", () => {
  test("garbage QUANTA_LOG_LEVEL falls back to 'info' instead of dropping all logs", () => {
    const original = process.env["QUANTA_LOG_LEVEL"]
    process.env["QUANTA_LOG_LEVEL"] = "garbage"
    __resetRuntimeConfig()
    try {
      const cfg = runtimeConfig()
      expect(cfg.logLevel).toBe("info")
    } finally {
      if (original === undefined) delete process.env["QUANTA_LOG_LEVEL"]
      else process.env["QUANTA_LOG_LEVEL"] = original
      __resetRuntimeConfig()
    }
  })

  test("valid QUANTA_LOG_LEVEL passes through", () => {
    const original = process.env["QUANTA_LOG_LEVEL"]
    process.env["QUANTA_LOG_LEVEL"] = "warn"
    __resetRuntimeConfig()
    try {
      expect(runtimeConfig().logLevel).toBe("warn")
    } finally {
      if (original === undefined) delete process.env["QUANTA_LOG_LEVEL"]
      else process.env["QUANTA_LOG_LEVEL"] = original
      __resetRuntimeConfig()
    }
  })

  test("invalid QUANTA_COMPACT_TOKENS is rejected (not silently coerced)", () => {
    const original = process.env["QUANTA_COMPACT_TOKENS"]
    process.env["QUANTA_COMPACT_TOKENS"] = "not a number"
    __resetRuntimeConfig()
    try {
      expect(runtimeConfig().compactTokens).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env["QUANTA_COMPACT_TOKENS"]
      else process.env["QUANTA_COMPACT_TOKENS"] = original
      __resetRuntimeConfig()
    }
  })
})

// ── S14: JailedPath ─────────────────────────────────────────────────────────

describe("S14 resolveJailed refuses empty jail root + rejects escape", () => {
  test("empty jail root throws FsJailError (no silent bypass)", () => {
    expect(() => resolveJailed("/etc/passwd", "")).toThrow(FsJailError)
  })

  test("`..` climb out of the jail throws", () => {
    const jail = mkdtempSync(join(tmpdir(), "jail-"))
    expect(() => resolveJailed("../../../etc/passwd", jail)).toThrow(FsJailError)
  })

  test("absolute path landing outside jail throws", () => {
    const jail = mkdtempSync(join(tmpdir(), "jail-"))
    expect(() => resolveJailed("/etc/passwd", jail)).toThrow(FsJailError)
  })

  test("in-jail path returns a branded JailedPath string", () => {
    const jail = mkdtempSync(join(tmpdir(), "jail-"))
    const p = resolveJailed("inside.txt", jail)
    expect(p.startsWith(jail)).toBe(true)
  })
})

// ── S16: HARD_DENY broader than `tool === "bash"` ───────────────────────────

describe("S16 hardDenyReason fires on any shellCommand (not just tool==='bash')", () => {
  test("a sibling 'shell' tool with rm -rf / matches HARD_DENY", () => {
    const reason = hardDenyReason({
      tool: "shell",
      input: { cmd: "rm -rf /" },
      isReadOnly: false,
      shellCommand: "rm -rf /",
    })
    expect(reason).not.toBeNull()
    expect(reason).toContain("Blocked dangerous command")
  })

  test("a fictional 'exec' tool with mkfs matches HARD_DENY", () => {
    expect(
      hardDenyReason({
        tool: "exec",
        input: {},
        isReadOnly: false,
        shellCommand: "mkfs.ext4 /dev/sda1",
      }),
    ).not.toBeNull()
  })

  test("legacy bash with no shellCommand field still matches (back-compat)", () => {
    expect(
      hardDenyReason({
        tool: "bash",
        input: { command: "rm -rf /" },
        isReadOnly: false,
      }),
    ).not.toBeNull()
  })

  test("a non-shell tool (read) with empty shellCommand does not match", () => {
    expect(
      hardDenyReason({
        tool: "read",
        input: { path: "/etc/passwd" },
        isReadOnly: true,
      }),
    ).toBeNull()
  })
})

// ── S17: Task ownership ─────────────────────────────────────────────────────

describe("S17 TaskRegistry.stop requires owner token", () => {
  test("register returns {abort, ownerToken}; stop with matching token succeeds", () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    const { ownerToken } = reg.register({ id, description: "x" })
    expect(reg.stop(id, ownerToken)).toBe("stopped")
    expect(reg.get(id)?.status).toBe("stopped")
  })

  test("stop with WRONG token returns 'denied' and does NOT cancel", () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    reg.register({ id, description: "x" })
    expect(reg.stop(id, "definitely-not-the-token")).toBe("denied")
    expect(reg.get(id)?.status).toBe("running")
  })

  test("stop on unknown id returns 'not-found'", () => {
    const reg = new TaskRegistry()
    expect(reg.stop("nonexistent", "any-token")).toBe("not-found")
  })

  test("forceStop cancels without a token (host authority)", () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    reg.register({ id, description: "x" })
    expect(reg.forceStop(id)).toBe(true)
    expect(reg.get(id)?.status).toBe("stopped")
  })
})

// ── S19: SavedSession deep validation ────────────────────────────────────────

describe("S19 loadSessionById refuses messages that don't shape-check", () => {
  // Direct test of the schema by injecting a malformed file and asserting
  // the loader refuses it. We import lazily so the in-process module under
  // test sees the env-based session dir we set.
  test("a session file with a malformed message is REFUSED (not partially loaded)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"))
    process.env["QUANTA_SESSIONS_DIR"] = dir
    __resetRuntimeConfig()
    try {
      const { loadSessionById } = await import("@/session")
      const id = "test-bad-session"
      // The "messages" array contains an entry without `role`/`content` shape.
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
          version: 2,
          meta: {
            id,
            title: "x",
            cwd: "/tmp",
            createdAt: 1,
            lastTouched: 1,
            archived: false,
          },
          reason: "ok",
          turns: 1,
          messages: [{ junk: true }],
        }),
      )
      const loaded = await loadSessionById(id)
      expect(loaded).toBeUndefined()
    } finally {
      delete process.env["QUANTA_SESSIONS_DIR"]
      __resetRuntimeConfig()
    }
  })

  test("a well-formed session round-trips through load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"))
    process.env["QUANTA_SESSIONS_DIR"] = dir
    __resetRuntimeConfig()
    try {
      const { loadSessionById } = await import("@/session")
      const id = "test-good-session"
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
          version: 2,
          meta: {
            id,
            title: "x",
            cwd: "/tmp",
            createdAt: 1,
            lastTouched: 1,
            archived: false,
          },
          reason: "ok",
          turns: 1,
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        }),
      )
      const loaded = await loadSessionById(id)
      expect(loaded).toBeDefined()
      expect(loaded?.messages.length).toBe(1)
    } finally {
      delete process.env["QUANTA_SESSIONS_DIR"]
      __resetRuntimeConfig()
    }
  })
})

// ── S20: IPC envelope runtime validation ────────────────────────────────────

describe("S20 isWireEnvelope rejects payload variants missing their required fields", () => {
  test("permission_request without request.toolName is dropped at the boundary", () => {
    expect(
      isWireEnvelope({
        protocol: "quanta.ipc.v1",
        source: "cli",
        sessionId: "sess-1",
        payload: { type: "permission_request", request: { preview: "ls" } },
        timestamp: "2026-05-25T00:00:00.000Z",
      }),
    ).toBe(false)
  })

  test("presence without a closed status enum is dropped at the boundary", () => {
    expect(
      isWireEnvelope({
        protocol: "quanta.ipc.v1",
        source: "web",
        sessionId: "sess-1",
        payload: { type: "presence", surface: "web", status: "busy" },
        timestamp: "2026-05-25T00:00:00.000Z",
      }),
    ).toBe(false)
  })
})

// ── S21: portable IPC session import validation ─────────────────────────────

describe("S21 parsePortableSession refuses malformed message payloads", () => {
  test("message entries must match the persisted session message shape", () => {
    expect(() =>
      parsePortableSession({
        schema: "quanta.session.portable",
        version: PORTABLE_SESSION_VERSION,
        meta: {
          id: "src-1",
          title: "t",
          cwd: "/tmp/x",
          created_at: 1,
          last_touched: 2,
          archived: false,
        },
        reason: "done",
        turns: 1,
        messages: [{ role: "user", content: [{ type: "text" }] }],
      }),
    ).toThrow(PortableSessionImportError)
  })
})

// ── S15: JSON-RPC envelope strict ───────────────────────────────────────────

describe("S15 JSON-RPC parsers reject non-conforming envelopes", () => {
  test("MCP LineReader drops a line missing `jsonrpc:'2.0'`", async () => {
    // Import the internal LineReader directly — it's private to the slice
    // (no top-level re-export) but the unit test legitimately exercises it.
    const mod = await import("../../src/mcp/jsonrpc")
    const reader = new mod.LineReader()
    const encoder = new TextEncoder()
    // Missing `jsonrpc` field — must be dropped (warn logged), zero messages.
    const out = reader.push(encoder.encode(`${JSON.stringify({ id: 1, result: "ok" })}\n`))
    expect(out.length).toBe(0)
  })

  test("MCP LineReader accepts a well-formed envelope", async () => {
    const mod = await import("../../src/mcp/jsonrpc")
    const reader = new mod.LineReader()
    const encoder = new TextEncoder()
    const out = reader.push(
      encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" })}\n`),
    )
    expect(out.length).toBe(1)
  })

  test("LSP MessageReader drops a body missing `jsonrpc:'2.0'`", async () => {
    const mod = await import("../../src/lsp/adapters/jsonrpc")
    const reader = new mod.MessageReader()
    const payload = JSON.stringify({ id: 1, result: "ok" })
    const encoder = new TextEncoder()
    const body = encoder.encode(payload)
    const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
    const framed = new Uint8Array(header.byteLength + body.byteLength)
    framed.set(header, 0)
    framed.set(body, header.byteLength)
    const out = reader.push(framed)
    expect(out.length).toBe(0)
  })
})
