import { describe, expect, test } from "bun:test"
import { buildForwardedBenchEnv } from "../box-session"

// audit r3 (wiring-proof): the Live full-remote fix depends on QUANTA_SWEBENCH_DATASET_FAMILY
// reaching the box via buildForwardedBenchEnv. Membership in FORWARD_EXTRA_ENV alone is silent
// — a future edit dropping it would pass every other test. These pin the forward.
describe("buildForwardedBenchEnv — multi-dataset signal forwarding (RFC jun-29)", () => {
  test("forwards QUANTA_SWEBENCH_DATASET_FAMILY (else Live grades as Verified on the box)", () => {
    const out = buildForwardedBenchEnv({ QUANTA_SWEBENCH_DATASET_FAMILY: "live" })
    expect(out).toContain("QUANTA_SWEBENCH_DATASET_FAMILY='live'")
  })

  test("forwards QUANTA_SWEBENCH_DATASET_NAME + QUANTA_SWEBENCH_NAMESPACE", () => {
    const out = buildForwardedBenchEnv({
      QUANTA_SWEBENCH_DATASET_NAME: "SWE-bench-Live/SWE-bench-Live",
      QUANTA_SWEBENCH_NAMESPACE: "starryzhang",
    })
    expect(out).toContain("QUANTA_SWEBENCH_DATASET_NAME='SWE-bench-Live/SWE-bench-Live'")
    expect(out).toContain("QUANTA_SWEBENCH_NAMESPACE='starryzhang'")
  })

  test("a Verified run (no SWEBENCH signals) forwards NONE of them (byte-identical)", () => {
    const out = buildForwardedBenchEnv({ HOME: "/x", PATH: "/usr/bin" })
    expect(out).not.toContain("QUANTA_SWEBENCH_DATASET_FAMILY")
    expect(out).not.toContain("QUANTA_SWEBENCH_DATASET_NAME")
    expect(out).not.toContain("QUANTA_SWEBENCH_NAMESPACE")
  })

  test("empty-string family is NOT forwarded (treated as unset)", () => {
    expect(buildForwardedBenchEnv({ QUANTA_SWEBENCH_DATASET_FAMILY: "" })).not.toContain(
      "QUANTA_SWEBENCH_DATASET_FAMILY",
    )
  })
})
