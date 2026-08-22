/**
 * ticket-15 (§11.7) — `statusLineConfig` runtime-config knob hellgate.
 *
 * DOUBLE-gated default-OFF, byte-identical when absent:
 *   §K-1  no knobs ⇒ statusLineConfig undefined (byte-identical default)
 *   §K-2  master gate ON but no config JSON ⇒ undefined (inert)
 *   §K-3  config JSON set but master gate OFF ⇒ undefined (config alone inert)
 *   §K-4  gate ON + valid config ⇒ parsed {command,padding,refreshInterval,
 *         hideVimModeIndicator}
 *   §K-5  array command form parses
 *   §K-6  malformed JSON ⇒ undefined (no throw — degrade)
 *   §K-7  object without usable command ⇒ undefined
 *   §K-8  non-object JSON (array / number) ⇒ undefined
 *   §K-9  gateOn vocab (`on`/`true`/`1`) all activate the master gate
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"

const GATE = "QUANTA_STATUS_LINE"
const CFG = "QUANTA_STATUS_LINE_CONFIG"
const origGate = process.env[GATE]
const origCfg = process.env[CFG]

const setEnv = (gate: string | undefined, cfg: string | undefined): void => {
  if (gate === undefined) delete process.env[GATE]
  else process.env[GATE] = gate
  if (cfg === undefined) delete process.env[CFG]
  else process.env[CFG] = cfg
  __resetRuntimeConfig()
}

beforeEach(() => setEnv(undefined, undefined))
afterEach(() => {
  if (origGate === undefined) delete process.env[GATE]
  else process.env[GATE] = origGate
  if (origCfg === undefined) delete process.env[CFG]
  else process.env[CFG] = origCfg
  __resetRuntimeConfig()
})

describe("statusLineConfig knob", () => {
  test("§K-1 absent ⇒ undefined (byte-identical default-OFF)", () => {
    expect(runtimeConfig().statusLineConfig).toBeUndefined()
  })

  test("§K-2 master gate ON but no config ⇒ undefined", () => {
    setEnv("1", undefined)
    expect(runtimeConfig().statusLineConfig).toBeUndefined()
  })

  test("§K-3 config present but master gate OFF ⇒ undefined", () => {
    setEnv(undefined, JSON.stringify({ command: "echo hi" }))
    expect(runtimeConfig().statusLineConfig).toBeUndefined()
  })

  test("§K-4 gate ON + valid config ⇒ fully parsed", () => {
    setEnv(
      "1",
      JSON.stringify({
        command: "my-status --flag",
        padding: 2,
        refreshInterval: 3000,
        hideVimModeIndicator: true,
      }),
    )
    const cfg = runtimeConfig().statusLineConfig
    expect(cfg).toBeDefined()
    expect(cfg?.command).toBe("my-status --flag")
    expect(cfg?.padding).toBe(2)
    expect(cfg?.refreshInterval).toBe(3000)
    expect(cfg?.hideVimModeIndicator).toBe(true)
  })

  test("§K-5 array command form parses", () => {
    setEnv("1", JSON.stringify({ command: ["my-status", "--flag"] }))
    expect(runtimeConfig().statusLineConfig?.command).toEqual(["my-status", "--flag"])
  })

  test("§K-6 malformed JSON ⇒ undefined (no throw)", () => {
    setEnv("1", "{not json")
    expect(runtimeConfig().statusLineConfig).toBeUndefined()
  })

  test("§K-7 object without usable command ⇒ undefined", () => {
    setEnv("1", JSON.stringify({ padding: 1 }))
    expect(runtimeConfig().statusLineConfig).toBeUndefined()
    setEnv("1", JSON.stringify({ command: "" }))
    expect(runtimeConfig().statusLineConfig).toBeUndefined()
    setEnv("1", JSON.stringify({ command: [] }))
    expect(runtimeConfig().statusLineConfig).toBeUndefined()
    setEnv("1", JSON.stringify({ command: [1, 2] }))
    expect(runtimeConfig().statusLineConfig).toBeUndefined()
  })

  test("§K-8 non-object JSON (array / number) ⇒ undefined", () => {
    setEnv("1", JSON.stringify(["echo"]))
    expect(runtimeConfig().statusLineConfig).toBeUndefined()
    setEnv("1", "42")
    expect(runtimeConfig().statusLineConfig).toBeUndefined()
  })

  test("§K-9 gateOn vocab (on/true/1) all activate the gate", () => {
    for (const v of ["1", "on", "true", "yes", "ON", "True"]) {
      setEnv(v, JSON.stringify({ command: "x" }))
      expect(runtimeConfig().statusLineConfig).toBeDefined()
    }
    // a non-truthy value does NOT activate
    setEnv("0", JSON.stringify({ command: "x" }))
    expect(runtimeConfig().statusLineConfig).toBeUndefined()
  })
})
