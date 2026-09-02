import { readFileSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"

const LEASE_HOST = "127.0.0.1"
const LEASE_PORT_BASE = 42_000
const LEASE_PORT_SPAN = 6_000
const LEASE_PROBE_TIMEOUT_MS = 500
const LEASE_PROTOCOL = "quanta-verification-lease-v1"
export const VERIFICATION_LEASE_TOKEN_ENV = "QUANTA_VERIFICATION_LEASE_TOKEN"
export const VERIFICATION_LEASE_OWNER_PID_ENV = "QUANTA_VERIFICATION_LEASE_OWNER_PID"

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
  /** Aborting cancels the WAIT (never an already-acquired lease). */
  readonly signal?: AbortSignal
}

export interface RepositoryIdentityInputs {
  readonly repositoryId?: string | undefined
  readonly remote: { readonly code: number; readonly text: string }
  readonly commonDir: { readonly code: number; readonly text: string }
  readonly cwd: string
}

const REPOSITORY_ID_FILE = ".quanta-verification-id"
const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/

/** A committed identity follows worktrees, local copies, and remote aliases. */
export const readCommittedRepositoryLeaseId = (repoRoot: string): string | undefined => {
  try {
    const value = readFileSync(join(repoRoot, REPOSITORY_ID_FILE), "utf8").trim()
    return REPOSITORY_ID_PATTERN.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

export type InheritedLeaseState = "absent" | "valid" | "invalid"

type ParentPid = (pid: number) => number | undefined

const systemParentPid: ParentPid = (pid) => {
  // The lease owner is normally the direct parent of a shard runner. Avoid a
  // subprocess and its load-sensitive failure mode on that production path;
  // `ps` is only needed while walking beyond the current process.
  if (pid === process.pid) {
    return Number.isSafeInteger(process.ppid) && process.ppid > 0 ? process.ppid : undefined
  }
  const result = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  })
  if (result.exitCode !== 0) return undefined
  const parsed = Number.parseInt(result.stdout.toString().trim(), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * A nested runner may skip reacquisition only when the outer campaign process
 * is still in its live ancestor chain. A stray/copied env value fails closed.
 */
export const inheritedTestShardLeaseState = (
  env: NodeJS.ProcessEnv,
  currentPid = process.pid,
  parentPid: ParentPid = systemParentPid,
): InheritedLeaseState => {
  const token = env[VERIFICATION_LEASE_TOKEN_ENV]
  const ownerText = env[VERIFICATION_LEASE_OWNER_PID_ENV]
  if (token === undefined && ownerText === undefined) return "absent"
  if (!/^[a-f0-9]{64}$/.test(token ?? "")) return "invalid"
  const owner = Number.parseInt(ownerText ?? "", 10)
  if (!Number.isSafeInteger(owner) || owner <= 1) return "invalid"
  let cursor = currentPid
  const visited = new Set<number>()
  while (cursor > 1 && !visited.has(cursor)) {
    if (cursor === owner) return "valid"
    visited.add(cursor)
    cursor = parentPid(cursor) ?? 0
  }
  return "invalid"
}

/** Normalize SSH aliases and HTTPS remotes to the same owner/repository key. */
export const normalizeRepositoryIdentity = (remote: string): string => {
  const value = remote.trim().replace(/\.git$/, "")
  const match = /[:/]([^/:]+\/[^/]+)$/.exec(value)
  return match?.[1] ?? value
}

export const selectRepositoryLeaseIdentity = (inputs: RepositoryIdentityInputs): string => {
  if (inputs.repositoryId !== undefined) return `repository-id:${inputs.repositoryId}`
  if (inputs.remote.code === 0) return inputs.remote.text.trim()
  if (inputs.commonDir.code === 0) return `git-common:${inputs.commonDir.text.trim()}`
  return inputs.cwd
}

export const testShardLeasePort = (identity: string): number => {
  const digest = new Bun.CryptoHasher("sha256").update(identity).digest("hex")
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % LEASE_PORT_SPAN
  return LEASE_PORT_BASE + bucket
}

const leaseDigest = (identity: string): string =>
  new Bun.CryptoHasher("sha256").update(identity).digest("hex")

const leaseRequest = (digest: string): string => `${LEASE_PROTOCOL}?${digest}\n`
const leaseResponse = (digest: string): string => `${LEASE_PROTOCOL}!${digest}\n`

/**
 * The listener answers an identity handshake so a contender can distinguish
 * "this repository's verification lane is busy" from "an unrelated service
 * happens to sit on the hashed port" — the latter previously stalled a
 * campaign for the full 90-minute wait with no diagnosis.
 */
const tryListen = (
  port: number,
  digest: string,
): Bun.TCPSocketListener<{ readonly digest: string; buffer: string }> | undefined => {
  try {
    return Bun.listen({
      hostname: LEASE_HOST,
      port,
      data: { digest, buffer: "" },
      socket: {
        open(socket) {
          socket.data = { digest: socket.data.digest, buffer: "" }
        },
        data(socket, data) {
          socket.data.buffer += new TextDecoder().decode(data)
          if (!socket.data.buffer.includes("\n")) return
          if (socket.data.buffer === leaseRequest(socket.data.digest)) {
            socket.end(leaseResponse(socket.data.digest))
            return
          }
          socket.end(`${LEASE_PROTOCOL}!collision\n`)
        },
      },
    })
  } catch {
    return undefined
  }
}

type LeaseProbe = "valid" | "absent" | "occupied" | "collision"

const probeLease = (port: number, digest: string): Promise<LeaseProbe> =>
  new Promise((resolve) => {
    let connected = false
    let settled = false
    let response = ""
    const finish = (result: LeaseProbe): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      resolve(result)
    }
    const socket = createConnection({ host: LEASE_HOST, port })
    // A legacy bind-only owner (older runner code in a concurrent session)
    // accepts but never answers: connected-then-silent reads as "occupied",
    // never as a collision, so mixed-version contention still serializes.
    const timeout = setTimeout(
      () => finish(connected ? "occupied" : "absent"),
      LEASE_PROBE_TIMEOUT_MS,
    )
    socket.setEncoding("utf8")
    socket.on("connect", () => {
      connected = true
      socket.write(leaseRequest(digest))
    })
    socket.on("data", (chunk: string) => {
      response += chunk
      if (!response.includes("\n")) return
      finish(response === leaseResponse(digest) ? "valid" : "collision")
    })
    socket.on("error", () => finish(connected ? "occupied" : "absent"))
    socket.on("end", () =>
      finish(
        response === leaseResponse(digest) ? "valid" : response === "" ? "occupied" : "collision",
      ),
    )
  })

const probeLeaseOrThrowOnCollision = async (port: number, digest: string): Promise<LeaseProbe> => {
  const probe = await probeLease(port, digest)
  if (probe === "collision") {
    throw new Error(
      `[test:shards] repository lease port collision on ${LEASE_HOST}:${port}; ` +
        "the listener is not this repository's verification owner",
    )
  }
  return probe
}

const leaseFromListener = (
  port: number,
  listener: ReturnType<typeof tryListen> & object,
): TestShardLease => {
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
  const identity = normalizeRepositoryIdentity(options.identity)
  const port = testShardLeasePort(identity)
  const digest = leaseDigest(identity)
  const waitMs = options.waitMs ?? 90 * 60_000
  const pollMs = options.pollMs ?? 1_000
  const heartbeatMs = options.heartbeatMs ?? 30_000
  const startedAt = Date.now()
  const deadline = Date.now() + waitMs
  let nextHeartbeatAt = 0

  while (true) {
    if (options.signal?.aborted) {
      throw new Error(`[test:shards] repository lease wait aborted on ${LEASE_HOST}:${port}`)
    }
    const listener = tryListen(port, digest)
    if (listener !== undefined) return leaseFromListener(port, listener)
    // Announce the wait BEFORE the (up to 500ms) identity probe, so a waiting
    // contender is visible immediately.
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs >= nextHeartbeatAt) {
      options.onWait?.(port, elapsedMs)
      nextHeartbeatAt = elapsedMs + heartbeatMs
    }
    if (Date.now() >= deadline) {
      throw new Error(`[test:shards] repository lease timed out on ${LEASE_HOST}:${port}`)
    }
    const probe = await probeLeaseOrThrowOnCollision(port, digest)
    // "absent" (bind raced or the owner just exited) retries quickly but never
    // hot-spins; a busy owner waits the full poll interval.
    const sleepMs = probe === "absent" ? Math.min(pollMs, 25) : pollMs
    await Bun.sleep(Math.min(sleepMs, Math.max(1, deadline - Date.now())))
  }
}
