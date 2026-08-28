/**
 * ★ HELLGATE (MR-08 item 4) — the web daemon's control-request log cannot be
 * used as an unbounded write channel by a remote client.
 *
 * The rejection path is `logger.warn(`web control-request rejected:
 * ${effect.value}`)`, where `value` is the pure planner's reason and the reason
 * EMBEDS the client's raw string: `model "<RAW>" not recognized`
 * (`@/agent/control-request/types.ts`). `logger.warn` strips control characters,
 * ANSI escapes and bidi marks — it does NOT cap LENGTH. The port additionally
 * retains up to `MAX_PENDING_CONTROL_REQUESTS` (64) frames, so one client can
 * queue 64 arbitrarily large strings and every one of them lands in the
 * operator's log verbatim.
 *
 * MEASURED PRE-FIX with the wiring below: a single `set_model` frame carrying a
 * 200 000-character model id produced a single warn line of 200 053 characters.
 *
 * THE FIX: `summarizeUntrustedId` (`@/shared`) — sanitized prefix + the RAW
 * length + a stable digest. The operator can still IDENTIFY the id (and tell one
 * client retrying from a client spraying, via the digest) without receiving it.
 *
 * REAL WIRING, not a hand-rolled observe callback: `mintInboundPorts` is the
 * production composition root for this port, and the `observe` sink under test is
 * defined inside it. The drain is the REAL `drainControlRequests` over the REAL
 * pure planner.
 *
 * RED-on-injection (verified against a `cp` backup): restore
 * `logger.warn(`web control-request rejected: ${effect.value}`)` in
 * `session-collaborators.ts` ⇒ BOUNDED-1 and BOUNDED-2 red at ~200 000 chars.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drainControlRequests } from "@/agent/control-request"
import { createModelRoutingSession } from "@/agent/model-routing"
import { inMemoryStickyModelStore } from "@/agent/sticky-model"
import { mintInboundPorts } from "@/apps/web-daemon/runtime-factory/session-collaborators"
import type { WebModelSwitchHandle } from "@/apps/web-daemon/web-model-switch"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import { logger } from "@/shared"

/** The daemon's live mutable permission cell, in the shape the composition root
 *  hands `mintInboundPorts`. */
const liveCell = (): PermissionContext => {
  let mode: PermissionContext["mode"] = "default"
  return {
    get mode() {
      return mode
    },
    set mode(next) {
      mode = next
    },
  } as unknown as PermissionContext
}

/** The surface's model switch, whose `ids()` IS the control-request allowlist.
 *  Present so an off-catalog id takes the REJECTED branch — without a switch the
 *  planner treats the absent allowlist as "this host opted out of gating models"
 *  and every id is accepted, which is a different wire from the one under test. */
const modelSwitch = (): WebModelSwitchHandle => {
  // MR-02 — the handle now carries THE routing owner alongside the loose
  // migration-window members. Built from the same factory production uses so
  // this fixture cannot drift from the real shape.
  const port = {} as unknown as LLMPort
  const session = createModelRoutingSession({
    env: {},
    path: join(mkdtempSync(join(tmpdir(), "ctrl-req-log-")), "sticky-model.json"),
    provider: "openai",
    bootModelId: "boot-model",
    bootPort: port,
    mode: () => "default",
    pinned: false,
    buildPort: () => port,
  })
  return {
    routing: session.authority,
    store: inMemoryStickyModelStore(),
    provider: "openai",
    effectiveModel: () => "boot-model",
    candidates: [],
    ids: () => ["boot-model", "gpt-5.6-terra"],
    refresh: async () => {},
    current: async () => "boot-model",
    applyModel: async () => ({ ok: true }) as const,
  } satisfies WebModelSwitchHandle
}

/** Only the control-request gate is armed — every other inbound surface in
 *  `mintInboundPorts` stays default-OFF, so this test drives exactly one wire. */
const ENV = { QUANTA_CONTROL_REQUEST: "1" } as const

let warnSpy: ReturnType<typeof spyOn> | undefined
let infoSpy: ReturnType<typeof spyOn> | undefined
beforeEach(() => {
  warnSpy = spyOn(logger, "warn").mockImplementation(() => {})
  infoSpy = spyOn(logger, "info").mockImplementation(() => {})
})
afterEach(() => {
  warnSpy?.mockRestore()
  infoSpy?.mockRestore()
  warnSpy = undefined
  infoSpy = undefined
})

const lines = (spy: ReturnType<typeof spyOn> | undefined): string[] =>
  ((spy?.mock.calls ?? []) as ReadonlyArray<readonly unknown[]>).map((c) => String(c[0]))

/** Enqueue `reqs` on the REAL port and run the REAL drain through the REAL
 *  applier — the same three collaborators the loop wires per turn. */
const drive = async (
  reqs: readonly { readonly kind: "set_model"; readonly model: string }[],
): Promise<void> => {
  const ports = mintInboundPorts({ ...ENV }, liveCell(), modelSwitch())
  const control = ports.controlRequest
  if (control === undefined) throw new Error("control-request port not wired")
  for (const r of reqs) control.enqueue(r)
  await drainControlRequests(control.port, control.context, control.applier)
}

describe("MR-08 · web control-request logging is bounded", () => {
  test("BOUNDED-1: a 200k-char model id produces a SHORT warn line", async () => {
    const hostile = "z".repeat(200_000)
    await drive([{ kind: "set_model", model: hostile }])
    const warns = lines(warnSpy).filter((l) => l.includes("web control-request rejected"))
    expect(warns.length).toBe(1)
    const line = warns[0] as string
    expect(line.length).toBeLessThan(400)
    // Still IDENTIFIABLE: the true length survives even though the payload does not.
    expect(line).toContain("200023 chars")
    expect(line).toContain("fnv1a:")
    // Truncated, not merely "short-ish": the elision marker proves the cap fired,
    // and the surviving run of the payload is the documented 120-char budget
    // rather than the 200 000 the client sent.
    expect(line).toContain("…")
    expect(line.length).toBeLessThan(220)
  })

  test("BOUNDED-2: 64 hostile frames cannot flood the log with 64 payloads", async () => {
    // The queue is bounded at MAX_PENDING_CONTROL_REQUESTS, but each retained
    // frame still logged its own full-size line. Total volume is the thing being
    // bounded here, not just per-line length.
    const frames = Array.from({ length: 64 }, (_, i) => ({
      kind: "set_model" as const,
      model: `${"y".repeat(50_000)}${i}`,
    }))
    await drive(frames)
    const warns = lines(warnSpy).filter((l) => l.includes("web control-request rejected"))
    expect(warns.length).toBeGreaterThan(0)
    const total = warns.reduce((n, l) => n + l.length, 0)
    // Pre-fix this was > 3 200 000 characters.
    expect(total).toBeLessThan(64 * 400)
  })

  test("BOUNDED-3: ANSI/OSC in a rejected id never reaches the log line", async () => {
    await drive([{ kind: "set_model", model: "\u001b[2J\u001b]0;pwned\u0007gpt-4o" }])
    const line = lines(warnSpy).find((l) => l.includes("web control-request rejected")) as string
    expect(line).toBeDefined()
    expect(line).not.toContain("\u001b")
    expect(line).not.toContain("\u0007")
    expect(line).not.toContain("pwned")
  })

  test("CONTROL-1: an ordinary short id is still legible in the warn", async () => {
    // Paired control — the cap must not make the log useless for the case an
    // operator actually debugs (a client asking for a model this host does not
    // have). The id itself has to be readable.
    await drive([{ kind: "set_model", model: "gpt-4o-mini" }])
    const line = lines(warnSpy).find((l) => l.includes("web control-request rejected")) as string
    expect(line).toContain("gpt-4o-mini")
    expect(line).not.toContain("…")
  })

  test("CONTROL-2: the un-gated `thinking` axis is capped, the ALLOWLISTED model axis is not", async () => {
    // `thinkingLevels` is never supplied by this composition, and the planner
    // treats an absent allowlist as "the host opted out of gating this axis" — so
    // `set_thinking` carries an UNVALIDATED client string all the way to the
    // applied-effect log line, and must be capped like the rejection is.
    //
    // `set_model` is the paired control: it cleared the catalog allowlist, so the
    // value in that line is one of the host's OWN ids and is echoed whole. An
    // operator debugging a model switch needs the exact slug.
    const ports = mintInboundPorts({ ...ENV }, liveCell(), modelSwitch())
    const control = ports.controlRequest
    if (control === undefined) throw new Error("control-request port not wired")
    control.enqueue({ kind: "set_thinking", level: "w".repeat(100_000) })
    control.enqueue({ kind: "set_model", model: "gpt-5.6-terra" })
    await drainControlRequests(control.port, control.context, control.applier)
    const applied = lines(infoSpy).filter((l) => l.includes("web control-request applied"))
    const thinking = applied.find((l) => l.startsWith("web control-request applied: thinking="))
    expect(thinking).toBeDefined()
    expect((thinking as string).length).toBeLessThan(400)
    expect(thinking as string).toContain("100000 chars")
    expect(applied).toContain("web control-request applied: model=gpt-5.6-terra")
  })
})
