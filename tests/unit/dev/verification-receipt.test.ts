import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testEnvironmentSha256 } from "../../../tools/dev/test-shard-receipt"
import {
  cleanStatusSha256,
  mintExactVerificationReceipt,
  sharedVerificationCacheRoot,
  type VerificationContext,
  validateExactVerificationReceipt,
  verificationEnvironmentSha256,
  verificationReceiptPath,
  verificationToolchainSha256,
} from "../../../tools/dev/verification-receipt"

const context = (overrides: Partial<VerificationContext> = {}): VerificationContext => ({
  head: "a".repeat(40),
  statusSha256: cleanStatusSha256,
  manifestSha256: "c".repeat(64),
  dependencySha256: "d".repeat(64),
  toolchainSha256: "e".repeat(64),
  environmentSha256: "f".repeat(64),
  ...overrides,
})

describe("content-bound exact verification receipt", () => {
  test("an exact unexpired match is reusable", () => {
    const receipt = mintExactVerificationReceipt(context(), 1_000, 5_000)
    expect(validateExactVerificationReceipt(receipt, context(), 5_999)).toEqual({ ok: true })
  })

  for (const field of [
    "head",
    "statusSha256",
    "manifestSha256",
    "dependencySha256",
    "toolchainSha256",
    "environmentSha256",
  ] as const) {
    test(`${field} drift invalidates instead of reusing`, () => {
      const receipt = mintExactVerificationReceipt(context(), 1_000, 5_000)
      const result = validateExactVerificationReceipt(
        receipt,
        context({ [field]: field === "head" ? "9".repeat(40) : "9".repeat(64) }),
        2_000,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain(field)
    })
  }

  test("expiry and malformed input fail closed", () => {
    const receipt = mintExactVerificationReceipt(context(), 1_000, 5_000)
    expect(validateExactVerificationReceipt(receipt, context(), 6_001)).toEqual({
      ok: false,
      reason: "receipt expired",
    })
    expect(validateExactVerificationReceipt({ schema: "wrong" }, context(), 2_000).ok).toBe(false)
  })

  test("a host capability change invalidates the receipt that skips every gate", () => {
    // An exact receipt skips `contract` and `real-toolchain-e2e` wholesale, so
    // losing (or gaining) the tools those gates drive must invalidate it. The
    // fingerprint was wired into the shard cache first and MISSED here.
    const withDocker = verificationToolchainSha256({ docker: "/usr/bin/docker 27.0.0" })
    expect(verificationToolchainSha256({ docker: "/usr/bin/docker 27.0.0" })).toBe(withDocker)
    expect(verificationToolchainSha256({ docker: "<missing>" })).not.toBe(withDocker)
    expect(verificationToolchainSha256({ docker: "/usr/bin/docker 28.0.0" })).not.toBe(withDocker)
    expect(verificationToolchainSha256({ docker: "/usr/bin/docker <unresponsive>" })).not.toBe(
      withDocker,
    )
  })

  test("nested bun-run PATH duplication is fingerprint-equivalent", () => {
    const search = ["/repo/node_modules/.bin", "/usr/local/bin", "/usr/bin"]
    const direct = verificationEnvironmentSha256({ PATH: search.join(":") })
    const nested = verificationEnvironmentSha256({ PATH: [...search, ...search].join(":") })
    expect(nested).toBe(direct)
  })

  test("locale and zone key BOTH receipts — they used to disagree", () => {
    // The drift: the shard cache keyed TZ and LANG, the exact receipt did not,
    // so `TZ=Asia/Seoul bun run prepush` reused a green minted under UTC
    // without running one date- or locale-sensitive test. Both now read the
    // same definition.
    const utc = verificationEnvironmentSha256({ PATH: "/a", TZ: "UTC" })
    expect(verificationEnvironmentSha256({ PATH: "/a", TZ: "Asia/Seoul" })).not.toBe(utc)
    const enUs = verificationEnvironmentSha256({ PATH: "/a", LANG: "en_US.UTF-8" })
    expect(verificationEnvironmentSha256({ PATH: "/a", LANG: "ko_KR.UTF-8" })).not.toBe(enUs)
    // …and the shard receipt agrees, key for key.
    const shardUtc = testEnvironmentSha256({ PATH: "/a", TZ: "UTC" }, 120_000)
    expect(testEnvironmentSha256({ PATH: "/a", TZ: "Asia/Seoul" }, 120_000)).not.toBe(shardUtc)
    // An unrelated terminal variable still keys nothing, in either.
    expect(verificationEnvironmentSha256({ PATH: "/a", TZ: "UTC", ITERM_SESSION_ID: "w0" })).toBe(
      utc,
    )
    expect(testEnvironmentSha256({ PATH: "/a", TZ: "UTC", ITERM_SESSION_ID: "w0" }, 120_000)).toBe(
      shardUtc,
    )
  })

  test("PATH order and real entries still invalidate the environment fingerprint", () => {
    const baseline = verificationEnvironmentSha256({ PATH: "/a:/b" })
    expect(verificationEnvironmentSha256({ PATH: "/b:/a" })).not.toBe(baseline)
    expect(verificationEnvironmentSha256({ PATH: "/a:/b:/c" })).not.toBe(baseline)
  })
})

describe("shared verification cache root", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  const git = (cwd: string, args: readonly string[]): void => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }

  test("every worktree of one repository resolves the SAME cache root", () => {
    const root = mkdtempSync(join(tmpdir(), "quanta-shared-cache-"))
    roots.push(root)
    const main = join(root, "main")
    Bun.spawnSync(["git", "init", "-q", main])
    git(main, ["config", "user.email", "cache-test@example.invalid"])
    git(main, ["config", "user.name", "Cache Test"])
    writeFileSync(join(main, "tracked.txt"), "baseline\n")
    git(main, ["add", "."])
    git(main, ["commit", "-qm", "fixture"])
    git(main, ["worktree", "add", "-q", join(root, "wt"), "-b", "wt-branch"])

    const mainRoot = sharedVerificationCacheRoot(main)
    const worktreeRoot = sharedVerificationCacheRoot(join(root, "wt"))
    // A receipt minted in the main checkout is visible from the worktree: 21
    // per-worktree .cache directories each re-verified the same commit.
    expect(worktreeRoot).toBe(mainRoot)
    expect(mainRoot).toContain(join(main, ".git"))
    expect(verificationReceiptPath(join(root, "wt"))).toBe(verificationReceiptPath(main))
  })

  test("outside Git the cache root falls back to the checkout-local .cache", () => {
    const bare = mkdtempSync(join(tmpdir(), "quanta-no-git-"))
    roots.push(bare)
    expect(sharedVerificationCacheRoot(bare)).toBe(join(bare, ".cache", "verification"))
  })
})
