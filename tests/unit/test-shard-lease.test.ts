import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acquireKeyedTestShardLeases,
  acquireTestShardLease,
  canonicalLeaseRequests,
  confirmLeaseToken,
  inheritedTestShardLeaseState,
  normalizeRepositoryIdentity,
  readCommittedRepositoryLeaseId,
  SHARED_LEASE_SLOTS,
  selectRepositoryLeaseIdentity,
  testShardLeasePort,
} from "../../tools/dev/test-shard-lease"

/**
 * A scratch quarantine root for every acquisition here. Without it the lane read
 * — and, since the reader checks the root, could chmod — the developer's real
 * `/tmp/quanta-lease-quarantine-<uid>`, and a bad root on the host turned this
 * suite into timeouts.
 */
const QUARANTINE_ENV = {
  QUANTA_LEASE_QUARANTINE_DIR: mkdtempSync(join(tmpdir(), "shard-lease-quarantine-")),
}

describe("full-suite repository lease", () => {
  test("committed identity survives remote aliases, copies, and worktree paths", () => {
    // A FIXED literal, not this checkout's own id. Asserting the repo's current
    // `.quanta-verification-id` made the rail unable to verify itself: an
    // isolated copy needs its own lease id so it cannot fight the real
    // checkout's campaign for the same kernel port, and giving it one turned
    // this test red and killed a full cold run mid-flight. The port hash is
    // what needs pinning for cross-version compatibility, and that is a
    // property of the FUNCTION, not of whatever the working copy declares.
    const repositoryId = "quanta-codeagent-v3"
    const left = selectRepositoryLeaseIdentity({
      repositoryId,
      remote: { code: 0, text: "https://example.invalid/left.git" },
      commonDir: { code: 0, text: "/tmp/left/.git" },
      cwd: "/tmp/left",
    })
    const right = selectRepositoryLeaseIdentity({
      repositoryId,
      remote: { code: 1, text: "missing" },
      commonDir: { code: 0, text: "/tmp/right/.git" },
      cwd: "/tmp/right",
    })
    expect(left).toBe("repository-id:quanta-codeagent-v3")
    expect(right).toBe(left)
    // Cross-version compatibility: existing verification campaigns already
    // hold this kernel-owned port. Changing the identity/hash silently would
    // allow two worktrees to run destructive/shared-resource tests together.
    expect(testShardLeasePort(left)).toBe(42_523)
  })

  test("this checkout declares a usable lease id, whatever it is", () => {
    // The half that SHOULD depend on the working copy: a committed id must
    // exist and be well-formed, so worktrees and clones share a lane. Its
    // VALUE is deliberately not asserted — an isolated verification copy is
    // supposed to carry a different one.
    const declared = readCommittedRepositoryLeaseId(join(import.meta.dir, "..", ".."))
    expect(declared).toBeDefined()
    expect(declared ?? "").toMatch(/^[a-z0-9][a-z0-9._-]{2,127}$/)
    // Whatever it is, it must resolve to a port in the lease range.
    const port = testShardLeasePort(`repository-id:${declared ?? ""}`)
    expect(port).toBeGreaterThanOrEqual(42_000)
    expect(port).toBeLessThan(48_000)
  })

  test("SSH aliases and HTTPS remotes resolve to one repository identity and port", () => {
    const ssh = normalizeRepositoryIdentity("git@github-personal:josongmin/quanta-codeagent-v3.git")
    const https = normalizeRepositoryIdentity(
      "https://github.com/josongmin/quanta-codeagent-v3.git",
    )
    expect(ssh).toBe("josongmin/quanta-codeagent-v3")
    expect(https).toBe(ssh)
    expect(testShardLeasePort(ssh)).toBe(testShardLeasePort(https))
  })

  test("origin-less sibling worktrees select their shared Git common directory", () => {
    const common = { code: 0, text: "/repo/.git\n" }
    const remote = { code: 1, text: "missing" }
    const left = selectRepositoryLeaseIdentity({ remote, commonDir: common, cwd: "/repo/wt-a" })
    const right = selectRepositoryLeaseIdentity({ remote, commonDir: common, cwd: "/repo/wt-b" })
    expect(left).toBe("git-common:/repo/.git")
    expect(right).toBe(left)
    expect(testShardLeasePort(normalizeRepositoryIdentity(right))).toBe(
      testShardLeasePort(normalizeRepositoryIdentity(left)),
    )
  })

  test("a contender waits and acquires only after the current owner releases", async () => {
    const identity = `lease-self-test-${process.pid}-${Date.now()}`
    const first = await acquireTestShardLease({
      env: QUARANTINE_ENV,
      identity,
      waitMs: 5_000,
      pollMs: 5,
    })
    let heartbeats = 0
    const secondPending = acquireTestShardLease({
      env: QUARANTINE_ENV,
      identity,
      waitMs: 5_000,
      pollMs: 5,
      heartbeatMs: 10,
      onWait: (_port, elapsedMs) => {
        expect(elapsedMs).toBeGreaterThanOrEqual(0)
        heartbeats += 1
      },
    })
    // Repeated heartbeats while waiting — bounded wait, not a fixed sleep, so
    // per-iteration probe latency cannot flake the assertion.
    for (let attempt = 0; attempt < 400 && heartbeats < 2; attempt += 1) await Bun.sleep(5)
    expect(heartbeats).toBeGreaterThanOrEqual(2)
    first.release()
    const second = await secondPending
    expect(second.port).toBe(first.port)
    second.release()

    // Red-on-injection/control: release must return ownership to the kernel.
    const third = await acquireTestShardLease({
      env: QUARANTINE_ENV,
      identity,
      waitMs: 100,
      pollMs: 5,
    })
    expect(third.port).toBe(first.port)
    third.release()
  })

  /**
   * TVH P1-5. The token was checked against `/^[a-f0-9]{64}$/` and NOTHING
   * held the value — the campaign minted a fresh `randomBytes(32)` per child
   * and threw it into the env. So the check proved that somebody could produce
   * hex: a child under a live campaign could invent its own token and skip
   * acquisition entirely, and a token kept from an earlier campaign replayed
   * against the next one.
   *
   * The owner's listener now issues the token and answers for it.
   */
  const chain = (pid: number): number | undefined => (pid === 100 ? 42 : undefined)
  const TOKEN = "a".repeat(64)
  const env = (token: string | undefined, owner: string | undefined) => ({
    ...(token === undefined ? {} : { QUANTA_VERIFICATION_LEASE_TOKEN: token }),
    ...(owner === undefined ? {} : { QUANTA_VERIFICATION_LEASE_OWNER_PID: owner }),
  })

  test("a live ancestor is necessary and NOT sufficient", async () => {
    // The whole ancestor chain is satisfied in every arm here; only the
    // owner's answer differs, so the handshake provably decides.
    expect(
      await inheritedTestShardLeaseState({
        env: env(TOKEN, "42"),
        currentPid: 100,
        parentPid: chain,
        confirmToken: async () => true,
      }),
    ).toBe("valid")

    expect(
      await inheritedTestShardLeaseState({
        env: env(TOKEN, "42"),
        currentPid: 100,
        parentPid: chain,
        confirmToken: async () => false,
      }),
    ).toBe("invalid")
  })

  test("a token the owner never issued is refused", async () => {
    // A fabricated token is well-formed hex under a genuine ancestor — the
    // exact shape the predecessor accepted.
    const asked: string[] = []
    const verdict = await inheritedTestShardLeaseState({
      env: env("f".repeat(64), "42"),
      currentPid: 100,
      parentPid: chain,
      confirmToken: async (token) => {
        asked.push(token)
        return token === TOKEN
      },
    })
    expect(verdict).toBe("invalid")
    expect(asked).toEqual(["f".repeat(64)])
  })

  test("no verifier at all is INVALID, not a free pass", async () => {
    // Fail closed: a caller that forgets the handshake must not get the
    // pre-fix behaviour back by omission.
    expect(
      await inheritedTestShardLeaseState({
        env: env(TOKEN, "42"),
        currentPid: 100,
        parentPid: chain,
      }),
    ).toBe("invalid")
  })

  test("the ancestor chain is still required, and is checked FIRST", async () => {
    // Owner pid not in the chain: a copied env fails closed without the
    // handshake even being attempted, so a stray value cannot probe the lane.
    let asked = 0
    expect(
      await inheritedTestShardLeaseState({
        env: env(TOKEN, "77"),
        currentPid: 100,
        parentPid: chain,
        confirmToken: async () => {
          asked += 1
          return true
        },
      }),
    ).toBe("invalid")
    expect(asked).toBe(0)
  })

  test("malformed and absent stay distinguishable", async () => {
    expect(
      await inheritedTestShardLeaseState({
        env: env(undefined, "42"),
        currentPid: 100,
        parentPid: chain,
        confirmToken: async () => true,
      }),
    ).toBe("invalid")
    expect(
      await inheritedTestShardLeaseState({
        env: {},
        currentPid: 100,
        parentPid: () => undefined,
        confirmToken: async () => true,
      }),
    ).toBe("absent")
  })

  test("END TO END — the real listener answers for its own token only", async () => {
    const identity = `lease-token-self-test-${process.pid}-${Date.now()}`
    const normalized = normalizeRepositoryIdentity(identity)
    const port = testShardLeasePort(normalized)
    const lease = await acquireTestShardLease({
      env: QUARANTINE_ENV,
      identity,
      waitMs: 5_000,
      pollMs: 10,
    })
    try {
      expect(lease.token).toMatch(/^[0-9a-f]{64}$/)
      expect(await confirmLeaseToken(port, normalized, lease.token)).toBe(true)
      // A different well-formed token, same live owner: refused.
      expect(await confirmLeaseToken(port, normalized, "b".repeat(64))).toBe(false)
    } finally {
      lease.release()
    }
    // REPLAY: the same token against a lane whose owner is gone.
    expect(await confirmLeaseToken(port, normalized, lease.token)).toBe(false)
  }, 20_000)

  test("a REBOUND lane issues a different token, so the old one stops working", async () => {
    const identity = `lease-rebind-self-test-${process.pid}-${Date.now()}`
    const normalized = normalizeRepositoryIdentity(identity)
    const port = testShardLeasePort(normalized)
    const first = await acquireTestShardLease({
      env: QUARANTINE_ENV,
      identity,
      waitMs: 5_000,
      pollMs: 10,
    })
    const firstToken = first.token
    first.release()
    const second = await acquireTestShardLease({
      env: QUARANTINE_ENV,
      identity,
      waitMs: 5_000,
      pollMs: 10,
    })
    try {
      expect(second.token).not.toBe(firstToken)
      expect(await confirmLeaseToken(port, normalized, firstToken)).toBe(false)
      // ANTI-VACUITY: the CURRENT token still works, so "always false" is not
      // what these arms are measuring.
      expect(await confirmLeaseToken(port, normalized, second.token)).toBe(true)
    } finally {
      second.release()
    }
  }, 20_000)

  test("an unrelated listener on the hashed port fails fast as a collision", async () => {
    const identity = `lease-collision-self-test-${process.pid}-${Date.now()}`
    const port = testShardLeasePort(normalizeRepositoryIdentity(identity))
    const unrelated = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: {
        data(socket) {
          socket.end("not-a-quanta-lease\n")
        },
      },
    })
    try {
      const started = performance.now()
      await expect(
        acquireTestShardLease({
          env: QUARANTINE_ENV,
          identity,
          waitMs: 5_000,
          pollMs: 5,
        }),
      ).rejects.toThrow("repository lease port collision")
      // The old bind-only lease waited the FULL budget behind a foreign
      // listener; the handshake must diagnose it in one probe round.
      expect(performance.now() - started).toBeLessThan(1_000)
    } finally {
      unrelated.stop(true)
    }
  })

  test("a legacy bind-only repository lease is treated as busy until release", async () => {
    const identity = `lease-legacy-self-test-${process.pid}-${Date.now()}`
    const port = testShardLeasePort(normalizeRepositoryIdentity(identity))
    // Older runner code in a concurrent session: binds the port, answers nothing.
    const legacy = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    })
    let waiting = false
    try {
      const pending = acquireTestShardLease({
        env: QUARANTINE_ENV,
        identity,
        waitMs: 5_000,
        pollMs: 5,
        onWait: () => {
          waiting = true
        },
      })
      for (let attempt = 0; attempt < 300 && !waiting; attempt += 1) await Bun.sleep(5)
      expect(waiting).toBe(true)
      legacy.stop(true)
      const acquired = await pending
      expect(acquired.port).toBe(port)
      acquired.release()
    } finally {
      legacy.stop(true)
    }
  })

  test("an aborted wait raises instead of parking behind a busy lane", async () => {
    const identity = `lease-abort-self-test-${process.pid}-${Date.now()}`
    const owner = await acquireTestShardLease({
      env: QUARANTINE_ENV,
      identity,
      waitMs: 500,
      pollMs: 5,
    })
    const aborter = new AbortController()
    try {
      const pending = acquireTestShardLease({
        env: QUARANTINE_ENV,
        identity,
        waitMs: 5_000,
        pollMs: 5,
        signal: aborter.signal,
      })
      await Bun.sleep(20)
      aborter.abort()
      await expect(pending).rejects.toThrow("lease wait aborted")
    } finally {
      owner.release()
    }
  })

  test("multi-key leases canonicalize order and release partial ownership", async () => {
    const scopeIdentity = `keyed-lease-self-test-${process.pid}-${Date.now()}`
    const first = await acquireKeyedTestShardLeases({
      scopeIdentity,
      keys: ["port:4317", "git-common", "port:4317"],
      waitMs: 5_000,
      pollMs: 5,
    })
    // Labels carry the MODE: a bare string key means `exclusive`, which is
    // what every caller meant before modes existed.
    expect(first.keys).toEqual(["git-common:exclusive", "port:4317:exclusive"])

    let waitingOn: string | undefined
    const secondPending = acquireKeyedTestShardLeases({
      scopeIdentity,
      keys: ["port:4317", "git-common"],
      waitMs: 5_000,
      pollMs: 5,
      onWait: (key) => {
        waitingOn = key
      },
    })
    for (let attempt = 0; attempt < 300 && waitingOn === undefined; attempt += 1) {
      await Bun.sleep(5)
    }
    expect(waitingOn).toBe("git-common")
    first.release()
    const second = await secondPending
    expect(second.keys).toEqual(first.keys)
    second.release()

    const reacquired = await acquireKeyedTestShardLeases({
      scopeIdentity,
      keys: ["git-common", "port:4317"],
      waitMs: 5_000,
      pollMs: 5,
    })
    reacquired.release()
    // An explicit budget, because the default 5s per-test timeout is the same
    // number as this test's own lease `waitMs`: an exclusive key is a gate plus
    // every reader slot, and a contender pays up to one 500ms identity probe
    // per poll, so on a loaded host the two deadlines raced each other.
  }, 30_000)
})

describe("keyed resource leases", () => {
  const scope = (name: string): string => `keyed-mode-${name}-${process.pid}-${Date.now()}`

  test("two SHARED holders of one key overlap; an exclusive holder excludes both", async () => {
    const scopeIdentity = scope("shared")
    const first = await acquireKeyedTestShardLeases({
      scopeIdentity,
      keys: [{ key: "cache", mode: "shared" }],
      waitMs: 5_000,
      pollMs: 5,
    })
    const second = await acquireKeyedTestShardLeases({
      scopeIdentity,
      keys: [{ key: "cache", mode: "shared" }],
      waitMs: 5_000,
      pollMs: 5,
    })
    try {
      // The whole point of a mode: shared/shared is the ONLY pair that runs
      // together, and it really does run together rather than queueing.
      expect(first.keys).toEqual(["cache:shared"])
      expect(second.keys).toEqual(["cache:shared"])
      expect(first.ports[0]).not.toBe(second.ports[0])
      // shared/exclusive must NOT.
      await expect(
        acquireKeyedTestShardLeases({
          scopeIdentity,
          keys: [{ key: "cache", mode: "exclusive" }],
          waitMs: 250,
          pollMs: 5,
        }),
      ).rejects.toThrow()
    } finally {
      first.release()
      second.release()
    }
    // Once both readers leave, the writer gets in — so the exclusion above was
    // contention, not a deadlock.
    const writer = await acquireKeyedTestShardLeases({
      scopeIdentity,
      keys: [{ key: "cache", mode: "exclusive" }],
      waitMs: 5_000,
      pollMs: 5,
    })
    try {
      expect(writer.keys).toEqual(["cache:exclusive"])
      // A writer holds the gate and every reader slot; that is what makes it
      // exclusive against readers a port bind alone could not express.
      expect(writer.ports).toHaveLength(SHARED_LEASE_SLOTS + 1)
      await expect(
        acquireKeyedTestShardLeases({
          scopeIdentity,
          keys: [{ key: "cache", mode: "shared" }],
          waitMs: 250,
          pollMs: 5,
        }),
      ).rejects.toThrow()
    } finally {
      writer.release()
    }
  })

  test("a resource key is hashed RAW — repository normalization would collapse it", () => {
    // `normalizeRepositoryIdentity` extracts the trailing `owner/repo` of a git
    // remote. Applied to a composite resource key that contains a path it keeps
    // the last two segments and DISCARDS the scope and the key name, so two
    // different keys in two different checkouts hash to one port.
    const left = "scope-a\u0000checkout:/Users/one/quanta/repo"
    const right = "scope-b\u0000git-common:/Users/two/quanta/repo"
    expect(normalizeRepositoryIdentity(left)).toBe(normalizeRepositoryIdentity(right))
    expect(testShardLeasePort(left)).not.toBe(testShardLeasePort(right))
  })

  test("opposite key orders reach the same canonical order, so neither waits on the other", () => {
    const forward = canonicalLeaseRequests(["checkout", { key: "cache", mode: "shared" }])
    const reverse = canonicalLeaseRequests([{ key: "cache", mode: "shared" }, "checkout"])
    expect(forward).toEqual(reverse)
    expect(forward.map(({ key }) => key)).toEqual(["cache", "checkout"])
    // A key requested both ways resolves to the STRICTER mode: taking the
    // shared row would hand the caller a lock that does not exclude its peer.
    expect(
      canonicalLeaseRequests([
        { key: "cache", mode: "shared" },
        { key: "cache", mode: "exclusive" },
      ]),
    ).toEqual([{ key: "cache", mode: "exclusive" }])
    expect(
      canonicalLeaseRequests([
        { key: "cache", mode: "exclusive" },
        { key: "cache", mode: "shared" },
      ]),
    ).toEqual([{ key: "cache", mode: "exclusive" }])
  })

  test("a failed second key releases the first, so a retry is not self-blocked", async () => {
    const scopeIdentity = scope("rollback")
    const blocker = await acquireKeyedTestShardLeases({
      scopeIdentity,
      keys: ["checkout"],
      waitMs: 5_000,
      pollMs: 5,
    })
    try {
      await expect(
        acquireKeyedTestShardLeases({
          scopeIdentity,
          keys: ["cache", "checkout"],
          waitMs: 200,
          pollMs: 5,
        }),
      ).rejects.toThrow()
      // `cache` was acquired first and must NOT be stranded: without reverse
      // rollback the failed attempt would hold it forever and every retry —
      // including this one — would block on the campaign's own orphan.
      const cacheOnly = await acquireKeyedTestShardLeases({
        scopeIdentity,
        keys: ["cache"],
        waitMs: 500,
        pollMs: 5,
      })
      expect(cacheOnly.keys).toEqual(["cache:exclusive"])
      cacheOnly.release()
    } finally {
      blocker.release()
    }
  })
})
