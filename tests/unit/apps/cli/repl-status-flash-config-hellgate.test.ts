/**
 * `StatusFlashConfig` hellgate.
 *
 * Pins:
 *   1. Defaults are byte-identical to the pre-cleanup repl.ts magic numbers
 *      (4000 / 3000 / 2000 / 1500 / 120). A regression here means existing
 *      UX flash durations changed silently.
 *   2. Every knob is independently env-overrideable.
 *   3. Garbage env values (negative / zero / non-numeric / NaN / Infinity)
 *      fall back to the default — never crippling the surface.
 *   4. Decimals are floored (toast lingers are millisecond-integer only).
 */

import { describe, expect, test } from "bun:test"
import { buildStatusFlashConfig } from "../../../../src/apps/cli/status-flash-config"

describe("StatusFlashConfig — defaults are byte-identical to pre-cleanup", () => {
  test("empty env yields all five pre-cleanup defaults", () => {
    const cfg = buildStatusFlashConfig({})
    expect(cfg.errorMs).toBe(4000)
    expect(cfg.idleMs).toBe(3000)
    expect(cfg.escWindowMs).toBe(2000)
    expect(cfg.transientMs).toBe(1500)
    expect(cfg.truncateChars).toBe(120)
  })

  test("explicit positive integer overrides default", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_FLASH_ERROR_MS: "7777" })
    expect(cfg.errorMs).toBe(7777)
  })

  test("each field is independently overrideable (errorMs)", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_FLASH_ERROR_MS: "9999" })
    expect(cfg.errorMs).toBe(9999)
    expect(cfg.idleMs).toBe(3000) // default preserved
    expect(cfg.escWindowMs).toBe(2000)
    expect(cfg.transientMs).toBe(1500)
    expect(cfg.truncateChars).toBe(120)
  })

  test("each field is independently overrideable (idleMs)", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_FLASH_IDLE_MS: "8888" })
    expect(cfg.errorMs).toBe(4000)
    expect(cfg.idleMs).toBe(8888)
    expect(cfg.escWindowMs).toBe(2000)
    expect(cfg.transientMs).toBe(1500)
    expect(cfg.truncateChars).toBe(120)
  })

  test("each field is independently overrideable (escWindowMs)", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_ESC_WINDOW_MS: "1111" })
    expect(cfg.escWindowMs).toBe(1111)
    expect(cfg.errorMs).toBe(4000)
  })

  test("each field is independently overrideable (transientMs)", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_FLASH_TRANSIENT_MS: "555" })
    expect(cfg.transientMs).toBe(555)
    expect(cfg.errorMs).toBe(4000)
  })

  test("each field is independently overrideable (truncateChars)", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_FLASH_TRUNCATE_CHARS: "80" })
    expect(cfg.truncateChars).toBe(80)
    expect(cfg.errorMs).toBe(4000)
  })

  test("all five overrides honored simultaneously", () => {
    const cfg = buildStatusFlashConfig({
      QUANTA_FLASH_ERROR_MS: "1000",
      QUANTA_FLASH_IDLE_MS: "2000",
      QUANTA_ESC_WINDOW_MS: "3000",
      QUANTA_FLASH_TRANSIENT_MS: "4000",
      QUANTA_FLASH_TRUNCATE_CHARS: "200",
    })
    expect(cfg.errorMs).toBe(1000)
    expect(cfg.idleMs).toBe(2000)
    expect(cfg.escWindowMs).toBe(3000)
    expect(cfg.transientMs).toBe(4000)
    expect(cfg.truncateChars).toBe(200)
  })
})

describe("StatusFlashConfig — invalid env falls back to default", () => {
  test("non-numeric string falls back", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_FLASH_ERROR_MS: "abc" })
    expect(cfg.errorMs).toBe(4000)
  })

  test("zero rejected — falls back to default", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_FLASH_ERROR_MS: "0" })
    expect(cfg.errorMs).toBe(4000)
  })

  test("negative rejected — falls back to default", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_FLASH_ERROR_MS: "-5" })
    expect(cfg.errorMs).toBe(4000)
  })

  test("empty string falls back", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_FLASH_ERROR_MS: "" })
    expect(cfg.errorMs).toBe(4000)
  })

  test("NaN string falls back", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_FLASH_ERROR_MS: "NaN" })
    expect(cfg.errorMs).toBe(4000)
  })

  test("Infinity rejected — falls back to default", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_FLASH_ERROR_MS: "Infinity" })
    expect(cfg.errorMs).toBe(4000)
  })

  test("decimal value is floored (positive)", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_FLASH_ERROR_MS: "4000.7" })
    expect(cfg.errorMs).toBe(4000)
  })

  test("decimal value is floored (truncateChars)", () => {
    const cfg = buildStatusFlashConfig({ QUANTA_FLASH_TRUNCATE_CHARS: "120.9" })
    expect(cfg.truncateChars).toBe(120)
  })
})

describe("StatusFlashConfig — process.env default", () => {
  test("calling without args reads process.env (smoke)", () => {
    // Just verify the helper returns finite positive integers using the live
    // env. Don't assert specific values (the dev env may set overrides).
    const cfg = buildStatusFlashConfig()
    expect(Number.isFinite(cfg.errorMs)).toBe(true)
    expect(Number.isFinite(cfg.idleMs)).toBe(true)
    expect(Number.isFinite(cfg.escWindowMs)).toBe(true)
    expect(Number.isFinite(cfg.transientMs)).toBe(true)
    expect(Number.isFinite(cfg.truncateChars)).toBe(true)
    expect(cfg.errorMs).toBeGreaterThan(0)
  })
})
