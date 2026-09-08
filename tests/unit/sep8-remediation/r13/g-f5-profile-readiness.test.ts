/**
 * G-F5.1 — profile-derived readiness is the single probe for bootstrap and
 * warm selection. Derived from existing `boxGrade` (shim skip), never a
 * second family registry.
 */
import { describe, expect, test } from "bun:test"
import {
  boxProfileReadinessProbe,
  familyRequiresSwebenchShim,
} from "@/apps/bench/profiles/family-box-readiness"
import { resolveDatasetFamilyProfile } from "@/apps/bench/profiles/registry"
import { isBoxProfileReady } from "@/apps/bench/remote/box-session/profile-readiness"

const SWEBENCH = ["verified", "live", "pro"] as const

describe("familyRequiresSwebenchShim", () => {
  test("ProMax (boxGrade) does not require the shim; swebench families do", () => {
    expect(familyRequiresSwebenchShim(resolveDatasetFamilyProfile("promax"))).toBe(false)
    for (const family of SWEBENCH) {
      expect(familyRequiresSwebenchShim(resolveDatasetFamilyProfile(family))).toBe(true)
    }
  })
})

describe("boxProfileReadinessProbe", () => {
  test("ProMax omits ~/swebench-python", () => {
    const probe = boxProfileReadinessProbe(resolveDatasetFamilyProfile("promax"))
    expect(probe).not.toContain("swebench-python")
    expect(probe).toContain("test -x ~/.bun/bin/bun")
    expect(probe).toContain("test -d ~/quanta/src")
  })

  test("verified/live keep the historical bun + shim + src order", () => {
    const expected =
      "test -x ~/.bun/bin/bun && test -x ~/swebench-python && test -d ~/quanta/src && echo OK"
    expect(boxProfileReadinessProbe(resolveDatasetFamilyProfile("verified"))).toBe(expected)
    expect(boxProfileReadinessProbe(resolveDatasetFamilyProfile("live"))).toBe(expected)
  })
})

describe("isBoxProfileReady", () => {
  test("ProMax is ready without a swebench-python probe", async () => {
    const seen: string[] = []
    const ready = await isBoxProfileReady(async (cmd) => {
      seen.push(cmd)
      expect(cmd).not.toContain("swebench-python")
      return { code: 0, stdout: "OK\n", stderr: "" }
    }, "promax")
    expect(ready).toBe(true)
    expect(seen).toHaveLength(1)
  })

  test("phase-failed probe (non-OK) is not ready", async () => {
    const ready = await isBoxProfileReady(
      async () => ({ code: 1, stdout: "", stderr: "missing" }),
      "verified",
    )
    expect(ready).toBe(false)
  })
})
