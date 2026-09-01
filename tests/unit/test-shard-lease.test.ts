import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  acquireTestShardLease,
  normalizeRepositoryIdentity,
  readCommittedRepositoryLeaseId,
  selectRepositoryLeaseIdentity,
  testShardLeasePort,
} from "../../tools/dev/test-shard-lease"

describe("full-suite repository lease", () => {
  test("committed identity survives remote aliases, copies, and worktree paths", () => {
    const repositoryId = readCommittedRepositoryLeaseId(join(import.meta.dir, "..", ".."))
    expect(repositoryId).toBe("quanta-codeagent-v3")
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
    const first = await acquireTestShardLease({ identity, waitMs: 500, pollMs: 5 })
    let heartbeats = 0
    const secondPending = acquireTestShardLease({
      identity,
      waitMs: 500,
      pollMs: 5,
      heartbeatMs: 10,
      onWait: (_port, elapsedMs) => {
        expect(elapsedMs).toBeGreaterThanOrEqual(0)
        heartbeats += 1
      },
    })
    await Bun.sleep(30)
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
})
