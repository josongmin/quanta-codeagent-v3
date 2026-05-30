/**
 * ★ CONTRACT — T01 (May-31 bugbash, audit L5 H-2 / M-6): the composition root
 *   owns ONE real cancellation signal and threads it into the AgentConfig base
 *   every mode-preset inherits. Previously every preset got a dead
 *   `new AbortController().signal` so Ctrl+C was silently ignored in 5 of 6
 *   modes.
 *
 * HELLGATE — proves the injected signal IS the base signal (not a throwaway),
 * and that aborting the composition-root controller flips `base.signal.aborted`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { buildBaseFromArgs } from "@/../src/apps/agent/index"

describe("composition-root cancellation signal threading", () => {
  const prevOpenAi = process.env.OPENAI_API_KEY
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key"
    delete process.env.QUANTA_PROVIDER
  })
  afterEach(() => {
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevOpenAi
  })

  test("the injected signal IS the base signal (identity, not a throwaway clone)", () => {
    const ctrl = new AbortController()
    const base = buildBaseFromArgs({ mode: "headless", dials: {} }, ctrl.signal)
    // Identity: the preset base must carry the SAME signal the composition root
    // owns — not a fresh `new AbortController().signal`.
    expect(base.signal).toBe(ctrl.signal)
  })

  test("aborting the composition-root controller flips base.signal.aborted", () => {
    const ctrl = new AbortController()
    const base = buildBaseFromArgs({ mode: "batch", dials: {} }, ctrl.signal)
    expect(base.signal.aborted).toBe(false)
    ctrl.abort()
    // A live cancel point — the loop reading base.signal now sees the abort.
    expect(base.signal.aborted).toBe(true)
  })

  test("the base signal is a real, listenable signal (event fires on abort)", async () => {
    const ctrl = new AbortController()
    const base = buildBaseFromArgs({ mode: "daemon", dials: {} }, ctrl.signal)
    const fired = new Promise<void>((resolve) => {
      base.signal.addEventListener("abort", () => resolve(), { once: true })
    })
    ctrl.abort()
    await expect(fired).resolves.toBeUndefined()
  })
})
