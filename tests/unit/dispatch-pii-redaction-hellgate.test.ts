/**
 * ★ CONTRACT — ADR-0399 PII-redaction wire to dispatch.applyRedaction.
 *
 * Hellgate proves four invariants of the wire:
 *
 *   - **No PII config ⇒ byte-identical.** Tool result text passes through
 *     existing secret redaction (default-ON) verbatim. No PII placeholders
 *     introduced. Existing test corpus depends on this exact behaviour.
 *   - **PII config ON, no secret content ⇒ PII masking applies.** Email /
 *     phone / SSN etc. in tool output are replaced by `[EMAIL]` /
 *     `[PHONE]` / `[SSN]` placeholders.
 *   - **Both secret + PII ON ⇒ both applied, order deterministic.** A tool
 *     output containing BOTH a credential AND an email gets both masked.
 *     Order: secret-first, then PII over the post-secret text (so secret
 *     masking can never reveal PII that was hiding inside the secret span,
 *     and PII never accidentally redacts a token already substituted by
 *     secret-redaction).
 *   - **Secret-only path (PII off / config absent) ⇒ secret hits surface
 *     unchanged on the DispatchResult; PII masking does NOT fire.**
 *
 * Slice fence: tests import the public dispatch entry point + the PII
 * scanner from `@/security/pii-redaction`. They do NOT poke
 * `applyRedaction` directly (it is internal to `dispatch.ts`).
 *
 * This is a sibling hellgate to `tests/unit/redaction.test.ts` (RFC-0002
 * secret-redaction golden) — that file is the authority on secret
 * regression. THIS file proves the PII branch and its independence from
 * the secret branch.
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
import { __resetRuntimeConfig } from "@/shared"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

/** Minimal scripted tool — yields a single `result` with caller-provided text. */
const echoTool = (text: string): Tool => ({
  name: "echo",
  description: "echo test tool",
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
  name: "echo",
  input,
})

const perm: PermissionContext = { mode: "acceptEdits" }

// ─── Permission-state isolation (mirrors dispatch.test.ts) ─────────────────
const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "dispatch-pii-perm-"))
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

// ─────────────────────────────────────────────────────────────────────────
// A. No PII config ⇒ byte-identical (existing secret-redaction unchanged).
// ─────────────────────────────────────────────────────────────────────────

describe("A. default-OFF — PII config absent", () => {
  test("A1 — benign text passes through verbatim (no PII redaction, no secret hits)", async () => {
    const res = await dispatchTool(call(), baseConfig(echoTool("just plain prose")), perm)
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("just plain prose")
    expect(res.redactionHits).toBeUndefined()
  })

  test("A2 — text containing an email passes through UNREDACTED when PII config absent", async () => {
    // Critical: existing secret-redaction has no email rule; absent PII config
    // means the email survives. Byte-identical legacy behaviour.
    const res = await dispatchTool(
      call(),
      baseConfig(echoTool("contact alice@example.com today")),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("contact alice@example.com today")
    expect(res.preview).not.toContain("[EMAIL]")
  })

  test("A3 — text containing a phone-us shape passes through UNREDACTED when PII off", async () => {
    const res = await dispatchTool(
      call(),
      baseConfig(echoTool("dial 415-555-1234 for support")),
      perm,
    )
    expect(res.preview).toBe("dial 415-555-1234 for support")
    expect(res.preview).not.toContain("[PHONE]")
  })

  test("A4 — redaction config present but PII branch absent ⇒ still no PII masking", async () => {
    // Caller may set `redaction.whitelist` for the secret branch yet leave
    // PII unspecified. The PII wire must read `redaction.pii?.enabled`
    // (strict `=== true`); any other shape means OFF.
    const res = await dispatchTool(
      call(),
      baseConfig(echoTool("alice@example.com"), { redaction: { whitelist: [] } }),
      perm,
    )
    expect(res.preview).toBe("alice@example.com")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// B. PII config ON ⇒ masking applies.
// ─────────────────────────────────────────────────────────────────────────

describe("B. PII config enabled", () => {
  test("B1 — email in tool output is replaced by [EMAIL] when pii.enabled === true", async () => {
    const res = await dispatchTool(
      call(),
      baseConfig(echoTool("contact alice@example.com today"), {
        redaction: { pii: { enabled: true } },
      }),
      perm,
    )
    expect(res.preview).toBe("contact [EMAIL] today")
  })

  test("B2 — phone-us 415.555.1234 is replaced by [PHONE]", async () => {
    const res = await dispatchTool(
      call(),
      baseConfig(echoTool("call 415.555.1234 please"), {
        redaction: { pii: { enabled: true } },
      }),
      perm,
    )
    expect(res.preview).toBe("call [PHONE] please")
  })

  test("B3 — multiple PII kinds in one payload all get masked", async () => {
    const res = await dispatchTool(
      call(),
      baseConfig(echoTool("email alice@example.com from 415-555-1234"), {
        redaction: { pii: { enabled: true } },
      }),
      perm,
    )
    expect(res.preview).toBe("email [EMAIL] from [PHONE]")
  })

  test("B4 — pii.enabled === false ⇒ off (boolean strict; no PII masking)", async () => {
    // `enabled: false` is the explicit off form. Equivalent to absent.
    const res = await dispatchTool(
      call(),
      baseConfig(echoTool("alice@example.com"), {
        redaction: { pii: { enabled: false } },
      }),
      perm,
    )
    expect(res.preview).toBe("alice@example.com")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// C. Secret + PII independence.
// ─────────────────────────────────────────────────────────────────────────

describe("C. independence — secret + PII orthogonal", () => {
  /** A representative secret pattern from RFC-0002 §11: AWS access key id. */
  const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"

  test("C1 — secret + PII ON ⇒ both masked, secret-first then PII", async () => {
    const payload = `key=${AWS_KEY} for alice@example.com`
    const res = await dispatchTool(
      call(),
      baseConfig(echoTool(payload), { redaction: { pii: { enabled: true } } }),
      perm,
    )
    // Secret masking ran first (so the AWS key is gone from the output) AND
    // PII masking ran second (so the email is gone too). The order does NOT
    // change what gets masked — both layers fire on their own kind.
    expect(res.preview).not.toContain(AWS_KEY)
    expect(res.preview).toContain("[EMAIL]")
    // Surface the secret hit on the DispatchResult — secret-branch contract.
    expect(res.redactionHits).toBeDefined()
    expect((res.redactionHits ?? []).length).toBeGreaterThan(0)
  })

  test("C2 — secret only (PII off) ⇒ secret masked, email survives", async () => {
    const payload = `key=${AWS_KEY} for alice@example.com`
    const res = await dispatchTool(call(), baseConfig(echoTool(payload)), perm)
    expect(res.preview).not.toContain(AWS_KEY)
    expect(res.preview).toContain("alice@example.com")
    expect(res.preview).not.toContain("[EMAIL]")
    expect(res.redactionHits).toBeDefined()
    expect((res.redactionHits ?? []).length).toBeGreaterThan(0)
  })

  test("C3 — PII only (secret-disabled with explicit ack) ⇒ PII masked, secret survives", async () => {
    // Caller explicitly disabled the secret branch with an `acknowledgedRisk`
    // string. Independence proof — PII still fires when secret is off.
    const payload = `key=${AWS_KEY} for alice@example.com`
    const res = await dispatchTool(
      call(),
      baseConfig(echoTool(payload), {
        redaction: {
          disabled: true,
          acknowledgedRisk: "test fixture — secret redaction intentionally off",
          pii: { enabled: true },
        },
      }),
      perm,
    )
    // The AWS key survives because the secret branch was disabled with an ack.
    expect(res.preview).toContain(AWS_KEY)
    // The email is still masked — PII branch is orthogonal.
    expect(res.preview).toContain("[EMAIL]")
    expect(res.preview).not.toContain("alice@example.com")
    // No secret-hit envelope when the secret branch was off.
    expect(res.redactionHits).toBeUndefined()
  })

  test("C4 — both off (secret-disabled with ack, PII absent) ⇒ raw output", async () => {
    // Confirms the disabled-with-ack escape hatch composes with PII-absent.
    const payload = `key=${AWS_KEY} for alice@example.com`
    const res = await dispatchTool(
      call(),
      baseConfig(echoTool(payload), {
        redaction: {
          disabled: true,
          acknowledgedRisk: "fixture",
        },
      }),
      perm,
    )
    expect(res.preview).toBe(payload)
    expect(res.redactionHits).toBeUndefined()
  })
})
