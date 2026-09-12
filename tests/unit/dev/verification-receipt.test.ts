import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  externalToolchainFingerprint,
  hostCapabilityFingerprint,
} from "../../../tools/dev/external-toolchain"
import { GATES } from "../../../tools/dev/gate-manifest"
import { resolveChunkCacheScope } from "../../../tools/dev/test-shard-cache-scope"
import { testEnvironmentSha256, toolScopeSha256 } from "../../../tools/dev/test-shard-receipt"
import {
  ABSENT_BASE_OID,
  cleanStatusSha256,
  DEFAULT_RECEIPT_TTL_MS,
  homeDerivedToolResolution,
  MAX_RECEIPT_TTL_MS,
  mintExactVerificationReceipt,
  readExactVerificationReceipt,
  sharedVerificationCacheRoot,
  type VerificationContext,
  validateExactVerificationReceipt,
  verificationBaseOid,
  verificationEnvironmentSha256,
  verificationHomeCapabilitySha256,
  verificationReceiptPath,
  verificationToolchainSha256,
} from "../../../tools/dev/verification-receipt"
import {
  assertClosedDispatchSchema,
  verificationManifestSha256,
} from "../../../tools/dev/verification-receipt-probe"

/** A root with no dotenv files, so the dotenv half of the fingerprint is a
 *  constant and these comparisons stay about the ENV half. */
const NO_DOTENV = join(import.meta.dir, "__fixture-root-without-dotenv__")

const context = (overrides: Partial<VerificationContext> = {}): VerificationContext => ({
  head: "a".repeat(40),
  statusSha256: cleanStatusSha256,
  manifestSha256: "c".repeat(64),
  dependencySha256: "d".repeat(64),
  toolchainSha256: "e".repeat(64),
  environmentSha256: "f".repeat(64),
  baseOid: "b".repeat(40),
  homeCapabilitySha256: "1".repeat(64),
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
    "baseOid",
    "homeCapabilitySha256",
  ] as const) {
    test(`${field} drift invalidates instead of reusing`, () => {
      const receipt = mintExactVerificationReceipt(context(), 1_000, 5_000)
      const result = validateExactVerificationReceipt(
        receipt,
        context({
          [field]: field === "head" || field === "baseOid" ? "9".repeat(40) : "9".repeat(64),
        }),
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

  describe("issued→expiry is a SCHEMA contract, not the receipt's own claim", () => {
    test("[7] an expiry extended to 30 days misses with the duration reason", () => {
      // The hole: validation was `expiresAtMs > now`, which reads the file's
      // own claim about its lifetime and believes it. Editing one integer in a
      // JSON file bought a month of skipping every gate, and the miss reason
      // would have been… nothing, because it was a hit.
      const honest = mintExactVerificationReceipt(context(), 1_000, DEFAULT_RECEIPT_TTL_MS)
      expect(validateExactVerificationReceipt(honest, context(), 2_000)).toEqual({ ok: true })

      const thirtyDaysMs = 30 * 24 * 60 * 60_000
      const extended = { ...honest, expiresAtMs: honest.issuedAtMs + thirtyDaysMs }
      const result = validateExactVerificationReceipt(extended, context(), 2_000)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe(
          `receipt ttl ${thirtyDaysMs}ms exceeds the schema maximum ${MAX_RECEIPT_TTL_MS}ms`,
        )
        // Distinct from every other miss reason — not a generic "invalid".
        expect(result.reason).not.toBe("receipt expired")
      }
    })

    test("exactly the maximum is allowed; one millisecond over is not", () => {
      const atMax = mintExactVerificationReceipt(context(), 1_000, MAX_RECEIPT_TTL_MS)
      expect(validateExactVerificationReceipt(atMax, context(), 2_000)).toEqual({ ok: true })
      expect(
        validateExactVerificationReceipt(
          { ...atMax, expiresAtMs: atMax.expiresAtMs + 1 },
          context(),
          2_000,
        ).ok,
      ).toBe(false)
      expect(MAX_RECEIPT_TTL_MS).toBe(6 * 60 * 60_000)
    })

    test("minting cannot produce what the validator would reject", () => {
      // One rule at both ends, so mint and validate cannot drift apart.
      expect(() => mintExactVerificationReceipt(context(), 1_000, MAX_RECEIPT_TTL_MS + 1)).toThrow(
        /exceeds|schema maximum/,
      )
      expect(() => mintExactVerificationReceipt(context(), 1_000, 0)).toThrow()
    })

    test("an expiry at or before issue is RED rather than a zero-length hit", () => {
      const receipt = mintExactVerificationReceipt(context(), 1_000, 5_000)
      expect(
        validateExactVerificationReceipt({ ...receipt, expiresAtMs: 1_000 }, context(), 900),
      ).toEqual({
        ok: false,
        reason: "receipt ttl is not positive — expires at or before it was issued",
      })
    })

    test("[8] an issuedAtMs in the future misses", () => {
      const receipt = mintExactVerificationReceipt(context(), 10_000_000, 5_000)
      expect(validateExactVerificationReceipt(receipt, context(), 1_000)).toEqual({
        ok: false,
        reason: "receipt issued in the future",
      })
      // …and the 60s tolerance is a tolerance, not a loophole: inside it the
      // receipt is still usable, outside it is not.
      const nearly = mintExactVerificationReceipt(context(), 1_030_000, 5_000)
      expect(validateExactVerificationReceipt(nearly, context(), 1_000_000)).toEqual({ ok: true })
      const beyond = mintExactVerificationReceipt(context(), 1_061_000, 5_000)
      expect(validateExactVerificationReceipt(beyond, context(), 1_000_000)).toEqual({
        ok: false,
        reason: "receipt issued in the future",
      })
    })
  })

  describe("the mutable comparison base and HOME are part of the identity", () => {
    test("[9] a moved origin/main misses with the base-OID reason", () => {
      // HEAD and status are unchanged; `git fetch` moved what the run compares
      // AGAINST. Gate selection, diff scoping and scan-reach baselines all read
      // origin/main, so this is a different verification — and the receipt had
      // no field for it.
      const receipt = mintExactVerificationReceipt(context({ baseOid: "1".repeat(40) }), 1_000)
      const result = validateExactVerificationReceipt(
        receipt,
        context({ baseOid: "2".repeat(40) }),
        2_000,
      )
      expect(result).toEqual({
        ok: false,
        reason: `baseOid mismatch: comparison base origin/main was ${"1".repeat(40)}, now ${"2".repeat(40)}`,
      })
      // Losing the ref entirely is a miss too — absence is a value.
      expect(
        validateExactVerificationReceipt(receipt, context({ baseOid: ABSENT_BASE_OID }), 2_000).ok,
      ).toBe(false)
    })

    test("verificationBaseOid answers a real repository and says <absent> otherwise", () => {
      const repoRoot = join(import.meta.dir, "../../..")
      const oid = verificationBaseOid(repoRoot)
      const expected = Bun.spawnSync(
        ["git", "rev-parse", "--verify", "--quiet", "origin/main^{commit}"],
        {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      expect(oid).toBe(
        expected.exitCode === 0 && expected.stdout.toString().trim() !== ""
          ? expected.stdout.toString().trim()
          : ABSENT_BASE_OID,
      )
      expect(verificationBaseOid(repoRoot, "refs/heads/no-such-ref-tvh06")).toBe(ABSENT_BASE_OID)
    })

    test("[10] a HOME-derived tool path or version change misses with that reason", () => {
      const tools = { dlv: "/home/u/go/bin/dlv 1:2 4096 1700000000", git: "/usr/bin/git 1:3 900 1" }
      const baseline = verificationHomeCapabilitySha256("/home/u", tools)
      // Same tool, rebuilt: dev:ino / size / mtime move.
      expect(
        verificationHomeCapabilitySha256("/home/u", {
          ...tools,
          dlv: "/home/u/go/bin/dlv 1:2 5000 1800000000",
        }),
      ).not.toBe(baseline)
      // Same tool, different HOME-relative location.
      expect(
        verificationHomeCapabilitySha256("/home/u", {
          ...tools,
          dlv: "/home/u/.local/bin/dlv 1:2 4096 1700000000",
        }),
      ).not.toBe(baseline)
      // Lost entirely.
      expect(verificationHomeCapabilitySha256("/home/u", { ...tools, dlv: "<missing>" })).not.toBe(
        baseline,
      )
      // VR-13. This arm used to pass the SAME absolute tool map under a second
      // HOME, and its comment claimed that proved HOME was bound. It did not:
      // `/home/u/go/bin/dlv` stops matching the `/home/other` prefix, so the
      // TOOLS term emptied and the digest moved for the other reason. Deleting
      // `home` from the hashed payload left this file 28/28 green.
      //
      // The real case is two homes laid out identically — two accounts on one
      // box, or a runner beside a developer, both sharing one receipt cache
      // because it lives in the git common dir. `homeDerivedToolResolution`
      // reports paths RELATIVE to home, so the tools term is byte-identical
      // and only the home value itself can separate them.
      const mirrored = { dlv: "/home/other/go/bin/dlv 1:2 4096 1700000000" }
      expect(homeDerivedToolResolution("/home/other", mirrored)).toEqual(
        homeDerivedToolResolution("/home/u", tools),
      )
      expect(verificationHomeCapabilitySha256("/home/other", mirrored)).not.toBe(baseline)

      // The weaker arm still belongs here: a home move that ALSO strands the
      // tools must miss, and for a reason this digest can state.
      expect(verificationHomeCapabilitySha256("/home/other", tools)).not.toBe(baseline)
      expect(verificationHomeCapabilitySha256(undefined, tools)).not.toBe(baseline)
      expect(verificationHomeCapabilitySha256("", tools)).not.toBe(
        verificationHomeCapabilitySha256(undefined, tools),
      )

      // An UNSET home must key no tools at all. Without the empty-home guard
      // the prefix degenerates to "/", every absolute path matches, and the
      // whole system toolchain folds into this digest — which is the one thing
      // the docstring promises it does not do: an unrelated /usr/bin upgrade
      // would then be reported as a HOME capability miss.
      expect(homeDerivedToolResolution("", tools)).toEqual([])
      expect(verificationHomeCapabilitySha256(undefined, tools)).toBe(
        verificationHomeCapabilitySha256(undefined, { git: "/usr/bin/git 9:9 1 2" }),
      )
      // A tool OUTSIDE home keys nothing here — that is toolchainSha256's job,
      // and duplicating it would make every unrelated upgrade a HOME miss.
      expect(
        verificationHomeCapabilitySha256("/home/u", { ...tools, git: "/usr/bin/git 9:9 1 2" }),
      ).toBe(baseline)
      // It is NOT a hash of the home directory: only resolved tool paths.
      expect(homeDerivedToolResolution("/home/u", tools)).toEqual([
        ["dlv", "/go/bin/dlv 1:2 4096 1700000000"],
      ])

      const receipt = mintExactVerificationReceipt(
        context({ homeCapabilitySha256: baseline }),
        1_000,
      )
      expect(
        validateExactVerificationReceipt(
          receipt,
          context({
            homeCapabilitySha256: verificationHomeCapabilitySha256("/home/u", {
              ...tools,
              dlv: "<missing>",
            }),
          }),
          2_000,
        ),
      ).toEqual({
        ok: false,
        reason: "homeCapabilitySha256 mismatch: HOME or HOME-derived tool resolution changed",
      })
    })
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
    const shardUtc = testEnvironmentSha256({ PATH: "/a", TZ: "UTC" }, 120_000, NO_DOTENV)
    expect(testEnvironmentSha256({ PATH: "/a", TZ: "Asia/Seoul" }, 120_000, NO_DOTENV)).not.toBe(
      shardUtc,
    )
    // An unrelated terminal variable still keys nothing, in either.
    expect(verificationEnvironmentSha256({ PATH: "/a", TZ: "UTC", ITERM_SESSION_ID: "w0" })).toBe(
      utc,
    )
    expect(
      testEnvironmentSha256({ PATH: "/a", TZ: "UTC", ITERM_SESSION_ID: "w0" }, 120_000, NO_DOTENV),
    ).toBe(shardUtc)
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

  test("a miss says which of absent, unreadable and wrong-shape it is", () => {
    // All three collapsed into "receipt is not an object", so the ordinary
    // first-run state — and the state right after a receipt is deliberately
    // destroyed for a mismatch — read as corruption. Measured live: a warm run
    // after the receipt was destroyed reported "receipt is not an object",
    // which is a message that sends someone hunting for a broken file that was
    // simply not there.
    const dir = mkdtempSync(join(tmpdir(), "quanta-receipt-miss-"))
    const path = join(dir, "prepush-exact-v1.json")
    const context = {
      head: "a".repeat(40),
      statusSha256: "b".repeat(64),
      manifestSha256: "c".repeat(64),
      dependencySha256: "d".repeat(64),
      toolchainSha256: "e".repeat(64),
      environmentSha256: "f".repeat(64),
      baseOid: "b".repeat(40),
      homeCapabilitySha256: "1".repeat(64),
    }
    try {
      expect(readExactVerificationReceipt(path)).toBeUndefined()
      const absent = validateExactVerificationReceipt(readExactVerificationReceipt(path), context)
      expect(absent).toEqual({ ok: false, reason: "no receipt stored" })

      writeFileSync(path, "{ truncated")
      expect(readExactVerificationReceipt(path)).toBeNull()
      expect(validateExactVerificationReceipt(readExactVerificationReceipt(path), context)).toEqual(
        {
          ok: false,
          reason: "receipt file is unreadable",
        },
      )

      writeFileSync(path, '"a bare string"')
      expect(validateExactVerificationReceipt(readExactVerificationReceipt(path), context)).toEqual(
        {
          ok: false,
          reason: "receipt is not an object",
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * A receipt minted over uncommitted changes may never be reused.
 *
 * Mutation survivor: deleting `if (receipt.statusSha256 !== cleanStatusSha256)`
 * left the suite 43/43 green. The context comparison only checks
 * receipt-against-current, so UNCHANGED dirt matches itself perfectly — and the
 * whole point of this rule is that a receipt describing a dirty tree is
 * worthless even when the tree has not moved since, because the verdict was
 * taken over state no commit contains.
 */
describe("a dirty checkout can never mint a reusable receipt", () => {
  const dirty = new Bun.CryptoHasher("sha256").update("?? scratch.txt\n").digest("hex")

  test("a receipt whose status is not the clean sentinel is refused", () => {
    const receipt = mintExactVerificationReceipt(context({ statusSha256: dirty }), 1_000, 5_000)
    expect(
      validateExactVerificationReceipt(receipt, context({ statusSha256: dirty }), 2_000),
    ).toEqual({ ok: false, reason: "receipt describes a dirty checkout" })
  })

  test("…even when the working tree has not changed since", () => {
    // The exact hole: same dirt on both sides. Every field matches, so a
    // receipt-vs-current comparison alone would say "reusable".
    const receipt = mintExactVerificationReceipt(context({ statusSha256: dirty }), 1_000, 5_000)
    const current = context({ statusSha256: dirty })
    expect(receipt.statusSha256).toBe(current.statusSha256)
    expect(validateExactVerificationReceipt(receipt, current, 2_000).ok).toBe(false)
  })

  test("PAIRED CONTROL — the same receipt over a clean tree is reusable", () => {
    // Without this arm, "always refuse" satisfies both assertions above.
    const receipt = mintExactVerificationReceipt(context(), 1_000, 5_000)
    expect(validateExactVerificationReceipt(receipt, context(), 2_000)).toEqual({ ok: true })
  })
})

/**
 * TVH item 11 — the manifest digest hashed the fields somebody destructured.
 *
 * Six fields were named in a destructuring pattern. `needsQuietBox` was not one
 * of them, and it changes DISPATCH: a gate carrying it makes the runner wait
 * for the box to go quiet before starting. So adding or removing it produced a
 * manifest the receipt called identical, and a green minted under one dispatch
 * policy replayed under another.
 *
 * Destructuring is exactly how that happens — a new field is simply not
 * mentioned, and nothing notices.
 */
describe("the dispatch schema is a closed universe", () => {
  const gate = (overrides: Record<string, unknown> = {}) =>
    ({ id: "a", stage: "precommit", run: "true", why: "because", ...overrides }) as never

  test("EVERY dispatch field moves the digest when it is toggled", () => {
    const base = verificationManifestSha256([gate()])
    const toggles: Readonly<Record<string, unknown>> = {
      id: "b",
      stage: "prepush",
      run: "false",
      consumes: "producer",
      hostDependent: "docker",
      notInWorkflow: "local only",
      needsQuietBox: "a toolchain that loses to contention",
    }
    for (const [field, value] of Object.entries(toggles)) {
      expect({
        field,
        moved: verificationManifestSha256([gate({ [field]: value })]) !== base,
      }).toEqual({ field, moved: true })
    }
  })

  test("a NON-dispatch field does not — rewording a reason is not a new manifest", () => {
    // The other half of "closed": the exclusions are deliberate, not an
    // accident of what someone remembered to hash. Without this arm, hashing
    // the whole object would satisfy the test above and invalidate a green
    // campaign every time a comment changed.
    const base = verificationManifestSha256([gate()])
    expect(verificationManifestSha256([gate({ why: "a different explanation" })])).toBe(base)
  })

  test("a field in NO dispatch class is a schema error, not a silent omission", () => {
    // The shape a hand-edited manifest or a widened type produces first: data
    // carries a key the classification does not know about.
    expect(() => verificationManifestSha256([gate({ retries: 3 })])).toThrow(
      /gate field\(s\) retries are in no dispatch class/,
    )
    expect(() => assertClosedDispatchSchema([gate({ timeoutMs: 1, outputBudget: 2 })])).toThrow(
      /outputBudget, timeoutMs/,
    )
    // ANTI-VACUITY: the real manifest passes, so this is a guard and not a ban.
    expect(() => assertClosedDispatchSchema([...GATES])).not.toThrow()
    expect(verificationManifestSha256([...GATES])).toMatch(/^[0-9a-f]{64}$/)
  })

  test("the REAL manifest's digest depends on its quiet-box gate", () => {
    // Wiring, not a fixture: the shipped manifest has a gate that declares
    // needsQuietBox, and dropping it must move the identity.
    const real = [...GATES]
    expect(real.some((row) => row.needsQuietBox !== undefined)).toBe(true)
    const stripped = real.map(({ needsQuietBox: _drop, ...rest }) => rest as never)
    expect(verificationManifestSha256(stripped)).not.toBe(verificationManifestSha256(real))
  })
})

/**
 * TVH item 13 — a daemon's state was not part of any receipt's identity.
 *
 * `docker` on PATH is a CLIENT. Whether the daemon is up is what decides
 * whether `tests/contract/sandbox-docker.test.ts` executes or skips, and both
 * receipts hashed `externalToolchainFingerprint()` — PATH binaries only. So
 * "daemon stopped" and "daemon running" shared a receipt, and a green earned
 * while the docker contracts skipped could be replayed as if they had run.
 *
 * `hostCapabilityFingerprint` — binaries, absolute non-PATH candidates and
 * daemon state — already existed, complete, with zero consumers. The fourth
 * built-and-unwired module this ticket has found.
 */
describe("daemon state is part of receipt identity", () => {
  const TOOLS = { docker: "/usr/bin/docker 27.0.0", git: "/usr/bin/git 2.44" }

  test("the same binaries with a stopped vs running daemon hash differently", () => {
    const stopped = { ...TOOLS, "docker-daemon": "<down>" }
    const running = { ...TOOLS, "docker-daemon": "/var/run/docker.sock 1:2 1700000000" }
    expect(verificationToolchainSha256(stopped)).not.toBe(verificationToolchainSha256(running))
    expect(toolScopeSha256(stopped)).not.toBe(toolScopeSha256(running))
  })

  test("a daemon RESTART is visible too — the socket moves", () => {
    const before = { ...TOOLS, "docker-daemon": "/var/run/docker.sock 1:2 1700000000" }
    const after = { ...TOOLS, "docker-daemon": "/var/run/docker.sock 1:3 1800000000" }
    expect(verificationToolchainSha256(before)).not.toBe(verificationToolchainSha256(after))
  })

  test("the real defaults include daemon entries at all", () => {
    // ANTI-VACUITY, and the whole wiring claim: the arms above pass synthetic
    // maps, which proves the hash reads the field and NOT that production
    // supplies it.
    const live = hostCapabilityFingerprint()
    const daemons = Object.keys(live).filter(
      (key) => key.endsWith("-daemon") || key.endsWith("-vm"),
    )
    expect(daemons.length).toBeGreaterThanOrEqual(3)
    expect(daemons).toContain("docker-daemon")
    // ...and the PATH-only fingerprint does NOT, which is what made it wrong
    // as an identity while remaining correct as itself.
    expect(Object.keys(externalToolchainFingerprint())).not.toContain("docker-daemon")
  })

  test("the PRODUCTION cache identity includes daemon state, measured", () => {
    // The source-shaped version of this test asserted
    // `body.includes("= hostCapabilityFingerprint()")`, which matched the
    // DEFAULT PARAMETER and said nothing about the caller. A wiring audit found
    // the caller passing `input.toolchainFingerprint ?? externalToolchainFingerprint()`
    // — an explicit argument — so the default never fired and every real chunk's
    // identity still excluded docker/lima/ollama. The test's own comment called
    // itself "the whole wiring claim".
    //
    // This computes the value the runner actually uses and compares it to the
    // PATH-only value. They must differ, or daemon state is not in the identity.
    const scope = resolveChunkCacheScope({
      repoRoot: resolve(import.meta.dir, "..", "..", ".."),
      ids: ["tests/unit/a.test.ts"],
      resourceCertifications: [],
    })
    expect(scope.toolScopeSha256).not.toBe(toolScopeSha256(externalToolchainFingerprint()))
    expect(scope.toolScopeSha256).toBe(toolScopeSha256(hostCapabilityFingerprint()))

    // ANTI-VACUITY: the two fingerprints must actually differ on this host, or
    // "not equal" is unachievable and the arm above proves nothing.
    const host = Object.keys(hostCapabilityFingerprint())
    const path = new Set(Object.keys(externalToolchainFingerprint()))
    expect(host.filter((key) => !path.has(key))).toContain("docker-daemon")
  })

  test("the exact receipt's owner takes the capability set by default", () => {
    // This one IS decided by the default: `verificationContextForSnapshot`
    // calls `verificationToolchainSha256()` with no argument.
    const probe = readFileSync(
      resolve(import.meta.dir, "..", "..", "..", "tools/dev/verification-receipt-probe.ts"),
      "utf8",
    )
    expect(probe).toContain("toolchainSha256: verificationToolchainSha256()")
    expect(verificationToolchainSha256()).toBe(
      verificationToolchainSha256(hostCapabilityFingerprint()),
    )
    expect(verificationToolchainSha256()).not.toBe(
      verificationToolchainSha256(externalToolchainFingerprint()),
    )
  })

  test("a DECLARED tool scope still narrows — this does not re-inflate it", () => {
    // The `claimed` path exists because a `cargo install` used to change the
    // identity of every pure chunk. Folding daemon state into the fail-safe
    // must not undo that.
    const wide = { ...TOOLS, "docker-daemon": "<down>", cargo: "/usr/bin/cargo 1.79" }
    const narrowed = toolScopeSha256(wide, ["git"])
    expect(narrowed).not.toBe(toolScopeSha256(wide))
    expect(toolScopeSha256({ ...wide, cargo: "/usr/bin/cargo 1.80" }, ["git"])).toBe(narrowed)
    expect(toolScopeSha256({ ...wide, "docker-daemon": "up" }, ["git"])).toBe(narrowed)
  })
})
