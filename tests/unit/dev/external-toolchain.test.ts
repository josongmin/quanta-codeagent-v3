import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EXTERNAL_TOOLS,
  externalToolchainFingerprint,
  probeToolVersion,
} from "../../../tools/dev/external-toolchain"

const roots: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-tool-probe-"))
  roots.push(dir)
  return dir
}

/** Run `body` with `dir` leading PATH, so a fixture tool is resolvable. */
const withPath = <T>(dir: string, body: () => T): T => {
  const previous = process.env.PATH
  process.env.PATH = `${dir}:${previous ?? ""}`
  try {
    return body()
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
}

const writeTool = (dir: string, name: string, body: string): string => {
  const tool = join(dir, name)
  writeFileSync(tool, body)
  chmodSync(tool, 0o755)
  return tool
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("host capability fingerprint", () => {
  test("a binary replaced at the same PATH location changes the fingerprint", () => {
    // The requirement this pins: "같은 PATH 위치의 실행 파일이 교체돼도 이전
    // receipt를 재사용할 수 있다" — an upgrade in place must invalidate.
    const dir = scratch()
    writeTool(dir, "quanta-swap-probe", "#!/bin/sh\necho v1\n")
    const before = withPath(dir, () => probeToolVersion("quanta-swap-probe"))
    expect(before).not.toBe("<missing>")

    writeTool(dir, "quanta-swap-probe", "#!/bin/sh\necho v2-with-more-bytes\n")
    const after = withPath(dir, () => probeToolVersion("quanta-swap-probe"))
    expect(after).not.toBe(before)
  })

  test("a repointed symlink is followed, not just the link path", () => {
    const dir = scratch()
    const real1 = writeTool(dir, "real-one", "#!/bin/sh\necho one\n")
    writeTool(dir, "real-two", "#!/bin/sh\necho two-is-longer\n")
    const link = join(dir, "quanta-link-probe")
    symlinkSync(real1, link)
    const before = withPath(dir, () => probeToolVersion("quanta-link-probe"))

    rmSync(link)
    symlinkSync(join(dir, "real-two"), link)
    const after = withPath(dir, () => probeToolVersion("quanta-link-probe"))
    // Same PATH entry, same link name — only the TARGET moved.
    expect(after).not.toBe(before)
    expect(after).toContain("real-two")
  })

  test("absence is a value, not a hole", () => {
    expect(probeToolVersion("quanta-tool-that-does-not-exist")).toBe("<missing>")
  })

  test("the fast path stays subprocess-free and cheap", () => {
    // Ground truth for the regression this replaced: the `--version` spawn
    // version measured 931ms, paid on the PRE-LEASE receipt probe whose whole
    // job is to return immediately. Red-on-injection: reinstate a per-tool
    // spawn and this budget blows.
    externalToolchainFingerprint() // warm the process cache the same way a run does
    const started = performance.now()
    const fresh = externalToolchainFingerprint(probeToolVersion)
    const elapsedMs = performance.now() - started
    expect(Object.keys(fresh)).toHaveLength(EXTERNAL_TOOLS.length)
    expect(elapsedMs).toBeLessThan(100)
  })

  test("every gate-relevant tool is covered and an injected probe is never cached", () => {
    const fingerprint = externalToolchainFingerprint()
    for (const tool of EXTERNAL_TOOLS) {
      expect(typeof fingerprint[tool]).toBe("string")
      expect(fingerprint[tool]?.length).toBeGreaterThan(0)
    }
    expect(EXTERNAL_TOOLS).toContain("docker")
    expect(EXTERNAL_TOOLS).toContain("pyright")

    const injected = externalToolchainFingerprint(() => "<missing>")
    expect(new Set(Object.values(injected))).toEqual(new Set(["<missing>"]))
    expect(externalToolchainFingerprint()).toEqual(fingerprint)
  })
})
