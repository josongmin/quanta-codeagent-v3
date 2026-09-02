import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  acquireTestShardLease,
  inheritedTestShardLeaseState,
  normalizeRepositoryIdentity,
  readCommittedRepositoryLeaseId,
  selectRepositoryLeaseIdentity,
  testShardLeasePort,
} from "../../tools/dev/test-shard-lease"

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
    const first = await acquireTestShardLease({ identity, waitMs: 5_000, pollMs: 5 })
    let heartbeats = 0
    const secondPending = acquireTestShardLease({
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
    const third = await acquireTestShardLease({ identity, waitMs: 100, pollMs: 5 })
    expect(third.port).toBe(first.port)
    third.release()
  })

  test("only a live ancestor-owned campaign lease may suppress reacquisition", () => {
    const valid = inheritedTestShardLeaseState(
      {
        QUANTA_VERIFICATION_LEASE_TOKEN: "a".repeat(64),
        QUANTA_VERIFICATION_LEASE_OWNER_PID: "42",
      },
      100,
      (pid) => (pid === 100 ? 42 : undefined),
    )
    expect(valid).toBe("valid")

    // Owner pid NOT in the ancestor chain: a copied/stray env fails closed.
    expect(
      inheritedTestShardLeaseState(
        {
          QUANTA_VERIFICATION_LEASE_TOKEN: "a".repeat(64),
          QUANTA_VERIFICATION_LEASE_OWNER_PID: "77",
        },
        100,
        (pid) => (pid === 100 ? 42 : undefined),
      ),
    ).toBe("invalid")
    // Malformed token with an owner pid present is invalid, never absent.
    expect(
      inheritedTestShardLeaseState({ QUANTA_VERIFICATION_LEASE_OWNER_PID: "42" }, 100, (pid) =>
        pid === 100 ? 42 : undefined,
      ),
    ).toBe("invalid")
    expect(inheritedTestShardLeaseState({}, 100, () => undefined)).toBe("absent")
  })

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
      await expect(acquireTestShardLease({ identity, waitMs: 5_000, pollMs: 5 })).rejects.toThrow(
        "repository lease port collision",
      )
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
    const owner = await acquireTestShardLease({ identity, waitMs: 500, pollMs: 5 })
    const aborter = new AbortController()
    try {
      const pending = acquireTestShardLease({
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
})
