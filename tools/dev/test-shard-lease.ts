const LEASE_HOST = "127.0.0.1"
const LEASE_PORT_BASE = 42_000
const LEASE_PORT_SPAN = 6_000

export interface TestShardLease {
  readonly port: number
  release(): void
}

export interface TestShardLeaseOptions {
  readonly identity: string
  readonly waitMs?: number
  readonly pollMs?: number
  readonly heartbeatMs?: number
  readonly onWait?: (port: number, elapsedMs: number) => void
}

export interface RepositoryIdentityInputs {
  readonly remote: { readonly code: number; readonly text: string }
  readonly commonDir: { readonly code: number; readonly text: string }
  readonly cwd: string
}

/** Normalize SSH aliases and HTTPS remotes to the same owner/repository key. */
export const normalizeRepositoryIdentity = (remote: string): string => {
  const value = remote.trim().replace(/\.git$/, "")
  const match = /[:/]([^/:]+\/[^/]+)$/.exec(value)
  return match?.[1] ?? value
}

export const selectRepositoryLeaseIdentity = (inputs: RepositoryIdentityInputs): string => {
  if (inputs.remote.code === 0) return inputs.remote.text.trim()
  if (inputs.commonDir.code === 0) return `git-common:${inputs.commonDir.text.trim()}`
  return inputs.cwd
}

export const testShardLeasePort = (identity: string): number => {
  const digest = new Bun.CryptoHasher("sha256").update(identity).digest("hex")
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % LEASE_PORT_SPAN
  return LEASE_PORT_BASE + bucket
}

const tryListen = (port: number): Bun.TCPSocketListener<undefined> | undefined => {
  try {
    return Bun.listen({
      hostname: LEASE_HOST,
      port,
      socket: { data() {} },
    })
  } catch {
    return undefined
  }
}

/**
 * Serialize full-suite shard runners across worktrees and local clones.
 *
 * The kernel owns the lease: bind is atomic and process death releases it, so
 * there is no stale lock file or PID-reuse cleanup race. A contender sleeps
 * instead of starting another CPU/memory-heavy shard campaign.
 */
export const acquireTestShardLease = async (
  options: TestShardLeaseOptions,
): Promise<TestShardLease> => {
  const port = testShardLeasePort(normalizeRepositoryIdentity(options.identity))
  const waitMs = options.waitMs ?? 90 * 60_000
  const pollMs = options.pollMs ?? 1_000
  const heartbeatMs = options.heartbeatMs ?? 30_000
  const startedAt = Date.now()
  const deadline = Date.now() + waitMs
  let nextHeartbeatAt = 0

  while (true) {
    const listener = tryListen(port)
    if (listener !== undefined) {
      let released = false
      return {
        port,
        release() {
          if (released) return
          released = true
          listener.stop(true)
        },
      }
    }
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs >= nextHeartbeatAt) {
      options.onWait?.(port, elapsedMs)
      nextHeartbeatAt = elapsedMs + heartbeatMs
    }
    if (Date.now() >= deadline) {
      throw new Error(`[test:shards] repository lease timed out on ${LEASE_HOST}:${port}`)
    }
    await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}
