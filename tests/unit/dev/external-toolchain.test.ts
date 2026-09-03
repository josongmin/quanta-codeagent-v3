import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EXTERNAL_TOOLS,
  externalToolchainFingerprint,
  missingExternalTools,
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

    // The target's IDENTITY moved with it, and pointing the link back restores
    // the original fingerprint. The target's NAME is deliberately not in the
    // string: it used to come from `realpathSync`, which answers per inode and
    // therefore lies about hardlinks (see below).
    rmSync(link)
    symlinkSync(real1, link)
    expect(withPath(dir, () => probeToolVersion("quanta-link-probe"))).toBe(before)
  })

  test("hardlinked names fingerprint separately, and do not swap under repeat", () => {
    // MEASURED on this box: sampling the 18 tools twice a second during a
    // 4-wide test run, `/usr/bin/python3` resolved to `/usr/bin/git` and back.
    // They are hardlinks to ONE inode — the Command Line Tools shim carries 78
    // names — and Bun's realpath answers per inode, so under concurrency it
    // returned whichever name it had resolved first. The fingerprint was
    // therefore not a function of the host state: it flipped between two
    // campaigns 475ms apart and turned a reusable exact receipt into
    // `toolchainSha256 mismatch`, re-running all 21 gates for nothing.
    const dir = scratch()
    const first = writeTool(dir, "quanta-hard-a", "#!/bin/sh\necho shared\n")
    linkSync(first, join(dir, "quanta-hard-b"))

    const a = withPath(dir, () => probeToolVersion("quanta-hard-a"))
    const b = withPath(dir, () => probeToolVersion("quanta-hard-b"))
    // One inode, two names: the names must still be told apart.
    expect(a).not.toBe(b)
    expect(a).toContain("quanta-hard-a")
    expect(b).toContain("quanta-hard-b")

    // …and neither answer drifts when the other name is probed in between.
    for (let round = 0; round < 5; round++) {
      expect(withPath(dir, () => probeToolVersion("quanta-hard-a"))).toBe(a)
      expect(withPath(dir, () => probeToolVersion("quanta-hard-b"))).toBe(b)
    }
  })

  test("the probe does not resolve through realpath", () => {
    // A RATCHET, not a behavioural test, and deliberately labelled as one: the
    // defect needs one inode under two names AND Bun's realpath cache primed
    // concurrently, which a sequential unit test cannot stage — restoring
    // `realpathSync` here leaves every other case in this file green. The
    // evidence is the MEASUREMENT: sampling the 18 tools twice a second during
    // a 4-wide test run, `/usr/bin/python3` resolved to `/usr/bin/git` and back
    // (hardlinks to one inode, 78 names on the Command Line Tools shim); after
    // this change, zero drift over the same two minutes.
    //
    // So what is guarded is the API choice, which is the thing that regresses.
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "..", "tools", "dev", "external-toolchain.ts"),
      "utf8",
    )
    // Comments are stripped first: this file's own prose names the API it
    // forbids, and a ratchet that its own justification trips is a ratchet
    // nobody keeps.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    expect(
      code.includes("realpathSync"),
      "the capability fingerprint decides whether an exact receipt skips all 21 gates, " +
        "and Bun's realpath answers per INODE — under concurrency it returns whichever " +
        "hardlinked name it resolved first, which makes the fingerprint a non-function " +
        "of the host state. Use statSync + dev:ino on the PATH entry instead.",
    ).toBe(false)
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
    const names = new Set<string>(EXTERNAL_TOOLS)
    expect(names.has("docker")).toBe(true)
    // The binary the tests actually resolve — see the coverage drift guard.
    expect(names.has("pyright-langserver")).toBe(true)

    const injected = externalToolchainFingerprint(() => "<missing>")
    expect(new Set(Object.values(injected))).toEqual(new Set(["<missing>"]))
    expect(externalToolchainFingerprint()).toEqual(fingerprint)
  })
})

describe("which capabilities this host is missing", () => {
  test("absent and unreadable both count; present does not", () => {
    // The gate summary and the receipt both report this list, and both were
    // green on a box that silently lacks dlv, gopls and lldb-dap — so the
    // detector itself has to be pinned, or "nothing missing" is indistinguish-
    // able from "the check stopped working".
    const probe = (tool: string): string => {
      if (tool === "docker") return "<missing>"
      if (tool === "dlv") return "/usr/local/bin/dlv <unreadable>"
      return `/usr/bin/${tool} -> /usr/bin/${tool} 100 1234`
    }
    const missing = missingExternalTools(probe)
    expect(missing).toEqual(["dlv", "docker"])
  })

  test("a host with everything reports an empty list, not a false alarm", () => {
    expect(missingExternalTools(() => "/usr/bin/x -> /usr/bin/x 1 1")).toEqual([])
  })

  test("every tool missing yields every tool, in a stable order", () => {
    const all = missingExternalTools(() => "<missing>")
    expect(all.length).toBe(EXTERNAL_TOOLS.length)
    expect(all).toEqual([...all].sort())
  })
})
