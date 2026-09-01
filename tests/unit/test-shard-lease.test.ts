import { describe, expect, test } from "bun:test"
import {
  acquireTestShardLease,
  normalizeRepositoryIdentity,
  selectRepositoryLeaseIdentity,
  testShardLeasePort,
} from "../../tools/dev/test-shard-lease"

describe("full-suite repository lease", () => {
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
