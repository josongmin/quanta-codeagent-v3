import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

describe("host runtime surface hellgate", () => {
  test("host/runtime barrel does not export legacy SessionDeps-based helpers", async () => {
    const runtime = await import("@/host/runtime")
    expect("createLegacySingleSessionRuntimeHost" in runtime).toBe(false)
    expect("buildCapabilityManifestFromSessionDeps" in runtime).toBe(false)
    expect("createLegacySessionHost" in runtime).toBe(false)
    expect("LegacySessionHost" in runtime).toBe(false)
  })

  test("host/runtime source no longer imports SessionDeps", () => {
    const builderSrc = read("src/host/runtime/builder.ts")
    const capabilitiesSrc = read("src/host/runtime/capabilities.ts")
    const indexSrc = read("src/host/runtime/index.ts")
    const typesSrc = read("src/host/runtime/types.ts")

    expect(builderSrc).not.toContain("SessionDeps")
    expect(capabilitiesSrc).not.toContain("SessionDeps")
    expect(indexSrc).not.toContain("createLegacySingleSessionRuntimeHost")
    expect(indexSrc).not.toContain("buildCapabilityManifestFromSessionDeps")
    expect(typesSrc).not.toContain("SessionDeps")
  })

  test("runtime public options do not accept caller-authored capability truth", () => {
    const typesSrc = read("src/host/runtime/types.ts")
    const runtimeSrc = read("src/sdk/runtime/runtime.ts")

    expect(typesSrc).toContain("expectedCapabilities?: CapabilityExpectation")
    expect(typesSrc).not.toContain("capabilities?:")
    expect(runtimeSrc).toContain("options.expectedCapabilities")
    expect(runtimeSrc).not.toContain("options.capabilities")
  })
})
