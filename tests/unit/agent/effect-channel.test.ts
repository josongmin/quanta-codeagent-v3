import { describe, expect, test } from "bun:test"
import {
  type EffectChannel,
  LocalEffectChannel,
  type ToolExecutor,
  type ToolRequest,
  type ToolResultEnvelope,
} from "@/agent/effect-channel"
import type { ToolUseBlock } from "@/llm"
import type { ToolContext, ToolResult } from "@/tool"

/**
 * EffectChannel — relocatable effect boundary (SOTA++ structural keystone, M1).
 *
 * Contract under test:
 *   - PURE port: `EffectChannel.execute(req, onProgress?) → ToolResultEnvelope`.
 *   - No-throw: executor exceptions normalize to `{ok:false}` envelopes.
 *   - DI: `LocalEffectChannel` takes an injected {@link ToolExecutor} so the
 *     channel imports no registry / business logic (testable with a fake).
 *   - Default-OFF: nothing in quanta consumes the channel yet. Adopting it
 *     later (dispatch.execute → LocalEffectChannel) must be byte-identical
 *     because the channel's normalization mirrors the current execute() path.
 *   - exactOptionalPropertyTypes: optional fields OMITTED, never `undefined`.
 */

const makeCall = (overrides: Partial<ToolUseBlock> = {}): ToolUseBlock => ({
  type: "tool_use",
  id: "call-1",
  name: "fake_tool",
  input: {},
  ...overrides,
})

const makeCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  ...overrides,
})

const makeReq = (overrides: Partial<ToolRequest> = {}): ToolRequest => ({
  call: makeCall(),
  ctx: makeCtx(),
  ...overrides,
})

/** Tiny executor builder so tests stay declarative. */
const exec = (
  fn: (
    call: ToolUseBlock,
    ctx: ToolContext,
    onProgress?: (m: string) => void,
  ) => Promise<ToolResult>,
): ToolExecutor => ({ execute: fn })

describe("EffectChannel — relocatable effect boundary", () => {
  describe("LocalEffectChannel — happy path", () => {
    test("delegates to the injected executor and surfaces its ToolResult verbatim", async () => {
      const want: ToolResult = { ok: true, output: "hello" }
      const channel: EffectChannel = new LocalEffectChannel(exec(async () => want))
      const env = await channel.execute(makeReq())
      expect(env.result).toBe(want)
    })

    test("measures durationMs as a non-negative integer", async () => {
      const channel = new LocalEffectChannel(
        exec(async () => {
          await new Promise((r) => setTimeout(r, 5))
          return { ok: true, output: "" }
        }),
      )
      const env = await channel.execute(makeReq())
      expect(env.durationMs).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(env.durationMs)).toBe(true)
    })

    test("each execute() call is independent (sequential reuse)", async () => {
      let i = 0
      const channel = new LocalEffectChannel(exec(async () => ({ ok: true, output: `n=${++i}` })))
      const a = await channel.execute(makeReq())
      const b = await channel.execute(makeReq())
      expect(a.result.output).toBe("n=1")
      expect(b.result.output).toBe("n=2")
    })

    test("supports concurrent execute() calls (parallel safe)", async () => {
      let started = 0
      const channel = new LocalEffectChannel(
        exec(async () => {
          const seq = ++started
          await new Promise((r) => setTimeout(r, 3))
          return { ok: true, output: `seq=${seq}` }
        }),
      )
      const [a, b] = await Promise.all([channel.execute(makeReq()), channel.execute(makeReq())])
      // Both completed independently; outputs reflect distinct sequence ids.
      expect(a.result.ok && b.result.ok).toBe(true)
      expect(a.result.output).not.toBe(b.result.output)
    })
  })

  describe("no-throw contract", () => {
    test("executor throwing Error → ok:false envelope, message in output", async () => {
      const channel = new LocalEffectChannel(
        exec(async () => {
          throw new Error("boom")
        }),
      )
      const env = await channel.execute(makeReq())
      expect(env.result.ok).toBe(false)
      expect(env.result.output).toContain("boom")
    })

    test("executor throwing non-Error (string) is still normalized", async () => {
      // Cast through unknown so the non-Error throw type-checks; the *contract*
      // we exercise here is that the channel handles such throws (no-throw
      // contract §1) — quanta's `toError()` normalizes raw-string throws to
      // Error in production paths.
      const channel = new LocalEffectChannel(
        exec(async () => {
          throw "raw-string-failure" as unknown as Error
        }),
      )
      const env = await channel.execute(makeReq())
      expect(env.result.ok).toBe(false)
      expect(env.result.output).toContain("raw-string-failure")
    })

    test("executor returning {ok:false, output:...} is passed through (no extra normalization)", async () => {
      const want: ToolResult = { ok: false, output: "tool said no" }
      const channel = new LocalEffectChannel(exec(async () => want))
      const env = await channel.execute(makeReq())
      expect(env.result).toBe(want)
      expect(env.result.ok).toBe(false)
    })
  })

  describe("passthrough — call, ctx, onProgress", () => {
    test("executor receives request.call by reference (no clone)", async () => {
      let seen: ToolUseBlock | null = null
      const channel = new LocalEffectChannel(
        exec(async (call) => {
          seen = call
          return { ok: true, output: "" }
        }),
      )
      const req = makeReq({ call: makeCall({ id: "abc", name: "foo", input: { x: 1 } }) })
      await channel.execute(req)
      expect(seen).not.toBeNull()
      // biome-ignore lint/style/noNonNullAssertion: previous expect proves non-null
      expect(seen!).toBe(req.call)
    })

    test("executor receives request.ctx by reference (no clone)", async () => {
      let seen: ToolContext | null = null
      const channel = new LocalEffectChannel(
        exec(async (_c, ctx) => {
          seen = ctx
          return { ok: true, output: "" }
        }),
      )
      const req = makeReq()
      await channel.execute(req)
      expect(seen).not.toBeNull()
      // biome-ignore lint/style/noNonNullAssertion: previous expect proves non-null
      expect(seen!).toBe(req.ctx)
    })

    test("forwards onProgress to executor (calls observed in order)", async () => {
      const channel = new LocalEffectChannel(
        exec(async (_c, _ctx, onProgress) => {
          onProgress?.("step1")
          onProgress?.("step2")
          return { ok: true, output: "" }
        }),
      )
      const reports: string[] = []
      await channel.execute(makeReq(), (m) => reports.push(m))
      expect(reports).toEqual(["step1", "step2"])
    })

    test("onProgress absent ⇒ executor sees undefined (not a stub)", async () => {
      let saw: unknown = "unset"
      const channel = new LocalEffectChannel(
        exec(async (_c, _ctx, onProgress) => {
          saw = onProgress
          return { ok: true, output: "" }
        }),
      )
      await channel.execute(makeReq())
      expect(saw).toBeUndefined()
    })
  })

  describe("execId — correlation", () => {
    test("execId on request surfaces verbatim on envelope", async () => {
      const channel = new LocalEffectChannel(exec(async () => ({ ok: true, output: "" })))
      const env = await channel.execute(makeReq({ execId: "exec-42" }))
      expect(env.execId).toBe("exec-42")
    })

    test("execId OMITTED on envelope when absent on request (exactOptionalPropertyTypes)", async () => {
      const channel = new LocalEffectChannel(exec(async () => ({ ok: true, output: "" })))
      const env = await channel.execute(makeReq())
      // We assert OMITTED, not `undefined`, to match the project's
      // exactOptionalPropertyTypes posture. `in`-check catches a `field:
      // undefined` assignment that would silently slip past `=== undefined`.
      expect("execId" in env).toBe(false)
    })

    test("execId survives the no-throw normalization path", async () => {
      const channel = new LocalEffectChannel(
        exec(async () => {
          throw new Error("boom")
        }),
      )
      const env = await channel.execute(makeReq({ execId: "exec-7" }))
      expect(env.execId).toBe("exec-7")
      expect(env.result.ok).toBe(false)
    })
  })

  describe("abort — pre-flight signal honored", () => {
    test("already-aborted signal ⇒ executor NOT called, ok:false envelope", async () => {
      const ctrl = new AbortController()
      ctrl.abort()
      let called = false
      const channel = new LocalEffectChannel(
        exec(async () => {
          called = true
          return { ok: true, output: "should-not-run" }
        }),
      )
      const env = await channel.execute(makeReq({ ctx: makeCtx({ signal: ctrl.signal }) }))
      expect(called).toBe(false)
      expect(env.result.ok).toBe(false)
      expect(env.result.output.toLowerCase()).toContain("abort")
    })

    test("non-aborted signal ⇒ executor runs normally", async () => {
      const ctrl = new AbortController()
      const channel = new LocalEffectChannel(exec(async () => ({ ok: true, output: "ran" })))
      const env = await channel.execute(makeReq({ ctx: makeCtx({ signal: ctrl.signal }) }))
      expect(env.result.ok).toBe(true)
      expect(env.result.output).toBe("ran")
    })
  })

  describe("interface contract — compile-level", () => {
    test("LocalEffectChannel is assignable to EffectChannel", () => {
      const ch: EffectChannel = new LocalEffectChannel(exec(async () => ({ ok: true, output: "" })))
      expect(typeof ch.execute).toBe("function")
    })

    test("ToolResultEnvelope is structurally minimal (result + durationMs required)", async () => {
      const channel = new LocalEffectChannel(exec(async () => ({ ok: true, output: "x" })))
      const env: ToolResultEnvelope = await channel.execute(makeReq())
      // Required fields present; typecheck enforces shape, runtime just sanity-checks.
      expect(env.result).toBeDefined()
      expect(typeof env.durationMs).toBe("number")
    })
  })
})
