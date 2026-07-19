/**
 * ★ CONTRACT — CLI composition consumes the promoted structured-patch gate.
 *   The entrypoint seeds this env knob, and this test drives the real
 *   `buildTooling` registry assembly that interactive CLI sessions use.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { logger } from "@/shared"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { buildTooling } from "../internal"

const DRIVEN = ["QUANTA_ENABLE_STRUCTURED_PATCH", "QUANTA_MEMORY", "QUANTA_SUBAGENT"] as const
const saved: Record<string, string | undefined> = {}

afterEach(() => {
  for (const key of DRIVEN) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  __resetRuntimeConfig()
})

const buildCliRegistry = () => buildTooling([], [], [], [], [], logger).registry
const hasStructuredPatch = (): boolean =>
  buildCliRegistry()
    .all()
    .some((tool) => tool.name === "apply_patch_structured")

describe("apply_patch_structured CLI composition", () => {
  test("seeded ON registers the tool and explicit 0 restores the legacy menu", () => {
    for (const key of DRIVEN) saved[key] = process.env[key]
    process.env.QUANTA_MEMORY = "off"
    process.env.QUANTA_SUBAGENT = "0"

    process.env.QUANTA_ENABLE_STRUCTURED_PATCH = "1"
    __resetRuntimeConfig()
    expect(hasStructuredPatch()).toBe(true)

    process.env.QUANTA_ENABLE_STRUCTURED_PATCH = "0"
    __resetRuntimeConfig()
    expect(hasStructuredPatch()).toBe(false)
  })
})
