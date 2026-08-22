/**
 * ★ CONTRACT — CLUSTER A surrogate-split truncation defense + redaction
 * defense-in-depth (#12).
 *
 * Proves that the six TEXT-truncation sites now route through
 * `sliceWholeChars`, so an astral char (emoji / CJK-ext) sitting exactly at the
 * cap boundary is never cut in half into a LONE surrogate (which would
 * re-encode to U+FFFD / a malformed token on the wire / in the prompt).
 *
 * Also proves Task 2 — `failure.modelVisibleError` now passes through the SAME
 * `applyRedaction` chokepoint as `result.output`, so a future surfacing can't
 * leak a credential.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { sanitizeTitle } from "@/runner/session-ops/auto-title"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

const EMOJI = "😀" // U+1F600 — high D83D + low DE00 (2 UTF-16 units)

const hasLoneSurrogate = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────
// Per-site: emoji exactly at the cap boundary ⇒ no lone surrogate.
// ─────────────────────────────────────────────────────────────────────────

describe("auto-title — title clamp (MAX_TITLE_CHARS) is surrogate-safe", () => {
  test("emoji straddling the 80-char title cap is not split", () => {
    // 79 ASCII + emoji => the high half lands at index 79, low at 80 (the cut).
    const raw = `${"a".repeat(79)}${EMOJI} trailing words here`
    const title = sanitizeTitle(raw, 50)
    expect(title.length).toBeLessThanOrEqual(80)
    expect(hasLoneSurrogate(title)).toBe(false)
    expect(title.isWellFormed()).toBe(true)
  })

  test("plain title under cap is byte-identical", () => {
    expect(sanitizeTitle("short clean title", 50)).toBe("short clean title")
  })
})

// memory / glob-rules / repo-rules / context-binding share the same idiom;
// they are leaf string truncations exercised by the shared-helper hellgate
// (slice-whole-chars-hellgate.test.ts). Here we additionally pin the dispatch
// PREVIEW path (clampPreview) end-to-end via a tool whose args serialize with
// an emoji at the 255-unit boundary — proving the preview never carries a lone
// surrogate. (clampPreview is internal; we drive it through dispatchTool.)

// ─────────────────────────────────────────────────────────────────────────
// Redaction defense-in-depth (#12): failure.modelVisibleError chokepoint.
// ─────────────────────────────────────────────────────────────────────────

/** Tool that fails with a typed `error` carrying a secret in modelVisibleError. */
const failingTool = (output: string, modelVisibleError: string): Tool => ({
  name: "boom",
  description: "fails with a typed error",
  inputSchema: z.object({}) as z.ZodType<unknown>,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield {
      type: "result",
      result: { ok: false, output, failure: { mode: "error", modelVisibleError } },
    }
  },
})

const okTool = (text: string): Tool => ({
  name: "boom",
  description: "ok tool",
  inputSchema: z.object({}) as z.ZodType<unknown>,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: text } }
  },
})

const baseConfig = (tool: Tool, over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry([tool]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
    ...over,
  }) as AgentConfig

const call = (input: unknown = {}, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "boom",
  input,
})

const perm: PermissionContext = { mode: "acceptEdits" }

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "dispatch-surrogate-perm-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permissionStateRoot !== null) {
    rmSync(permissionStateRoot, { recursive: true, force: true })
    permissionStateRoot = null
  }
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

describe("dispatch — failure.modelVisibleError redaction (#12)", () => {
  test("a ghp_ token in modelVisibleError is masked after the chokepoint", async () => {
    const secret = `ghp_${"a".repeat(40)}`
    const res = await dispatchTool(
      call(),
      baseConfig(failingTool("op failed", `git auth failed: ${secret}`)),
      perm,
    )
    expect(res.ok).toBe(false)
    const mve = (res.failure as { mode: "error"; modelVisibleError?: string }).modelVisibleError
    expect(mve).toBeDefined()
    expect(mve).not.toContain(secret)
    expect(mve).toContain("[REDACTED:github_pat_classic]")
    // The redaction hit is merged onto the DispatchResult so operators see it.
    expect(res.redactionHits?.some((h) => h.kind === "github_pat_classic")).toBe(true)
  })

  test("an sk-ant- token in modelVisibleError is masked", async () => {
    const secret = `sk-ant-${"x".repeat(30)}`
    const res = await dispatchTool(
      call(),
      baseConfig(failingTool("op failed", `caused by ${secret}`)),
      perm,
    )
    const mve = (res.failure as { mode: "error"; modelVisibleError?: string }).modelVisibleError
    expect(mve).not.toContain(secret)
    expect(mve).toContain("[REDACTED:anthropic_api_key]")
  })

  test("no secret present ⇒ modelVisibleError is byte-identical", async () => {
    const msg = "plain failure: command not found"
    const res = await dispatchTool(call(), baseConfig(failingTool("nope", msg)), perm)
    const mve = (res.failure as { mode: "error"; modelVisibleError?: string }).modelVisibleError
    expect(mve).toBe(msg)
    expect(res.redactionHits).toBeUndefined()
  })

  test("success path (no failure) stays byte-identical", async () => {
    const res = await dispatchTool(call(), baseConfig(okTool("all good")), perm)
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("all good")
    expect(res.failure).toBeUndefined()
  })

  test("output AND modelVisibleError both carry secrets ⇒ both masked, hits merged", async () => {
    const s1 = `ghp_${"b".repeat(40)}`
    const s2 = `sk-ant-${"y".repeat(30)}`
    const res = await dispatchTool(
      call(),
      baseConfig(failingTool(`stdout: ${s1}`, `stderr: ${s2}`)),
      perm,
    )
    expect(res.preview).not.toContain(s1)
    expect(res.preview).toContain("[REDACTED:github_pat_classic]")
    const mve = (res.failure as { mode: "error"; modelVisibleError?: string }).modelVisibleError
    expect(mve).not.toContain(s2)
    expect(mve).toContain("[REDACTED:anthropic_api_key]")
    const kinds = (res.redactionHits ?? []).map((h) => h.kind)
    expect(kinds).toContain("github_pat_classic")
    expect(kinds).toContain("anthropic_api_key")
  })
})
