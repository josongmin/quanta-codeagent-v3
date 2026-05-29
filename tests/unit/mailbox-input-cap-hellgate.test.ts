/**
 * R2 audit-H closeout (was shipped in 530405a9, this hellgate was the only
 * leg missing). Pins the zod boundary for the `subagent_send_message` and
 * `subagent_read_messages` tools so a hostile LLM cannot push 16MB `to` /
 * 100MB `correlation_id` / 2^31 `limit` past the schema and into the
 * MailboxPort (which would then occupy a slot of the 1024-cell retention
 * cap and effectively swap 100MB of RSS per turn).
 *
 * Boundary spec (production constants in `src/tool/subagent-mailbox/index.ts`):
 *   - `to`             min(1) max(128)
 *   - `correlation_id` max(128) (optional)
 *   - `limit`          int min(1) max(256) (optional)
 *
 * Each boundary asserted at the EXACT pass/reject point — `n = cap` PASSES,
 * `n = cap+1` REJECTS — so an inadvertent off-by-one (or a silent loosening)
 * in a future refactor is caught.
 */

import { describe, expect, test } from "bun:test"
import { subagentReadMessagesSchema, subagentSendMessageSchema } from "@/tool/subagent-mailbox"

const repeat = (n: number): string => "x".repeat(n)

describe("R2 audit-H — subagent_send_message / read_messages input caps", () => {
  // ── send.to ────────────────────────────────────────────────────────────────
  test("send.to: length 128 PASSES (cap boundary)", () => {
    const r = subagentSendMessageSchema.safeParse({
      to: repeat(128),
      kind: "request",
      body: "hi",
    })
    expect(r.success).toBe(true)
  })

  test("send.to: length 129 REJECTS (cap +1)", () => {
    const r = subagentSendMessageSchema.safeParse({
      to: repeat(129),
      kind: "request",
      body: "hi",
    })
    expect(r.success).toBe(false)
  })

  test("send.to: empty string REJECTS (min 1)", () => {
    const r = subagentSendMessageSchema.safeParse({
      to: "",
      kind: "request",
      body: "hi",
    })
    expect(r.success).toBe(false)
  })

  test("send.to: 16MB hostile string REJECTS (the original DoS vector)", () => {
    const r = subagentSendMessageSchema.safeParse({
      to: repeat(16 * 1024 * 1024),
      kind: "request",
      body: "hi",
    })
    expect(r.success).toBe(false)
  })

  // ── send.correlation_id ────────────────────────────────────────────────────
  test("send.correlation_id: length 128 PASSES (cap boundary)", () => {
    const r = subagentSendMessageSchema.safeParse({
      to: "sibling-a",
      kind: "response",
      body: "ok",
      correlation_id: repeat(128),
    })
    expect(r.success).toBe(true)
  })

  test("send.correlation_id: length 129 REJECTS (cap +1)", () => {
    const r = subagentSendMessageSchema.safeParse({
      to: "sibling-a",
      kind: "response",
      body: "ok",
      correlation_id: repeat(129),
    })
    expect(r.success).toBe(false)
  })

  test("send.correlation_id: 100MB hostile string REJECTS (the original DoS vector)", () => {
    const r = subagentSendMessageSchema.safeParse({
      to: "sibling-a",
      kind: "response",
      body: "ok",
      correlation_id: repeat(100 * 1024 * 1024),
    })
    expect(r.success).toBe(false)
  })

  test("send.correlation_id omitted: still PASSES (optional)", () => {
    const r = subagentSendMessageSchema.safeParse({
      to: "sibling-a",
      kind: "request",
      body: "hi",
    })
    expect(r.success).toBe(true)
  })

  // ── read.limit ─────────────────────────────────────────────────────────────
  test("read.limit: 256 PASSES (cap boundary)", () => {
    const r = subagentReadMessagesSchema.safeParse({ limit: 256 })
    expect(r.success).toBe(true)
  })

  test("read.limit: 257 REJECTS (cap +1)", () => {
    const r = subagentReadMessagesSchema.safeParse({ limit: 257 })
    expect(r.success).toBe(false)
  })

  test("read.limit: 0 REJECTS (min 1)", () => {
    const r = subagentReadMessagesSchema.safeParse({ limit: 0 })
    expect(r.success).toBe(false)
  })

  test("read.limit: 2^31 REJECTS (the original drain-amplification vector)", () => {
    const r = subagentReadMessagesSchema.safeParse({ limit: 2 ** 31 })
    expect(r.success).toBe(false)
  })

  test("read.limit: non-integer 1.5 REJECTS (int constraint)", () => {
    const r = subagentReadMessagesSchema.safeParse({ limit: 1.5 })
    expect(r.success).toBe(false)
  })

  test("read.limit omitted: still PASSES (optional)", () => {
    const r = subagentReadMessagesSchema.safeParse({})
    expect(r.success).toBe(true)
  })
})
