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

export type LeaseMode = "shared" | "exclusive"

export interface KeyedLeaseRequest {
  readonly key: string
  readonly mode: LeaseMode
}

export interface KeyedTestShardLease {
  /** Canonical `key:mode` strings, in the order they were acquired. */
  readonly keys: readonly string[]
  readonly ports: readonly number[]
  release(): void
}

export interface KeyedTestShardLeaseOptions
  extends Omit<TestShardLeaseOptions, "identity" | "onWait"> {
  readonly scopeIdentity: string
  /** A bare string means `exclusive`, which is what every caller meant before
   *  modes existed. */
  readonly keys: readonly (string | KeyedLeaseRequest)[]
  readonly onWait?: (key: string, port: number, elapsedMs: number) => void
}

/**
 * How many concurrent SHARED holders one key admits.
 *
 * A kernel port bind is a mutex, not a reader-writer lock, so shared mode is
 * built from a fixed pool of reader slots plus a gate. Bounded on purpose: the
 * fifth shared holder of a key waits, which is a concurrency cap rather than a
 * correctness property, and it keeps the port space per key at a constant 5.
 *
 * FOUR, not eight, and the difference was measured. An exclusive holder takes
 * the gate AND every slot, so the pool size is also the number of sequential
 * binds an exclusive acquisition pays — and a contender that has to re-probe
 * pays up to `LEASE_PROBE_TIMEOUT_MS` per poll on top. At eight, the existing
 * two-key rollback test (5s budget, calibrated when a key was one port) went
 * intermittently over its deadline on a loaded host: 1 failure in 6 runs,
 * 0 in 6 at four slots. The runner overlaps at most two workers, so four
 * concurrent readers of one key is headroom, not a constraint.
 */
export const SHARED_LEASE_SLOTS = 4

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
): Promise<TestShardLease> =>
  acquireRawTestShardLease(normalizeRepositoryIdentity(options.identity), options)

/**
 * Acquire on an identity string EXACTLY as given.
 *
 * `acquireTestShardLease` runs its identity through
 * `normalizeRepositoryIdentity`, which extracts the trailing `owner/repo` of a
 * git remote. Applied to a composite resource key that contains a path —
 * `<scope>\0checkout:/Users/x/repo` — that regex keeps the last two path
 * segments and DISCARDS the scope and the key name, so two different keys in
 * two different checkouts can hash to the same port and one silently waits on
 * the other. Repository identities are normalised; resource keys are hashed
 * raw.
 */
const acquireRawTestShardLease = async (
  identity: string,
  options: Omit<TestShardLeaseOptions, "identity">,
): Promise<TestShardLease> => {
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

/**
 * Acquire multiple resource keys in one canonical order. This is an exclusive
 * cross-process primitive; shared/exclusive compatibility is decided by the
 * scheduler before it requests host locks. Partial acquisition is rolled back
 * in reverse order so a failed second key cannot strand the first.
 */
/**
 * One canonical request list: deduplicated by key, EXCLUSIVE wins a tie, then
 * sorted by key.
 *
 * Sorting is what makes opposite acquisition orders deadlock-free — two
 * campaigns asking for `{cache, checkout}` and `{checkout, cache}` both take
 * `cache` first. Exclusive-wins is not a preference either: a caller that
 * claims one key both ways needs the stricter of the two, and taking the
 * shared row would hand it a lock that does not exclude its own peer.
 */
export const canonicalLeaseRequests = (
  keys: readonly (string | KeyedLeaseRequest)[],
): readonly KeyedLeaseRequest[] => {
  const byKey = new Map<string, LeaseMode>()
  for (const entry of keys) {
    const request: KeyedLeaseRequest =
      typeof entry === "string" ? { key: entry, mode: "exclusive" } : entry
    if (byKey.get(request.key) === "exclusive") continue
    byKey.set(request.key, request.mode)
  }
  return [...byKey.entries()]
    .map(([key, mode]) => ({ key, mode }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

const slotIdentity = (scope: string, key: string, slot: string): string =>
  `${scope}\0${key}\0${slot}`

/** Bind without waiting. `undefined` means somebody else holds it right now. */
const tryHoldLease = (identity: string): TestShardLease | undefined => {
  const port = testShardLeasePort(identity)
  const listener = tryListen(port, leaseDigest(identity))
  return listener === undefined ? undefined : leaseFromListener(port, listener)
}

interface KeyAcquisition {
  readonly leases: readonly TestShardLease[]
  readonly label: string
}

/**
 * Acquire one key in one mode.
 *
 * EXCLUSIVE takes the gate and then every reader slot: no reader can arrive
 * while the gate is held, and the slots it waits on are the readers already
 * running, so it makes progress instead of racing them forever.
 *
 * SHARED takes the gate only long enough to claim a free slot and hands it
 * straight back, so two shared holders of the same key overlap while an
 * exclusive holder still excludes both.
 */
type WaitForIdentity = (identity: string) => Promise<TestShardLease>

const waiterFor = (
  request: KeyedLeaseRequest,
  options: KeyedTestShardLeaseOptions,
  deadline: number,
): WaitForIdentity => {
  const rest = {
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  return (identity) =>
    acquireRawTestShardLease(identity, {
      waitMs: Math.max(1, deadline - Date.now()),
      ...rest,
      onWait: (port, waitedMs) => options.onWait?.(request.key, port, waitedMs),
    })
}

/** The gate AND every reader slot: no reader can arrive while the gate is
 *  held, and the slots it waits on are the readers already running. */
const acquireExclusiveKey = async (
  request: KeyedLeaseRequest,
  scopeIdentity: string,
  wait: WaitForIdentity,
): Promise<KeyAcquisition> => {
  const held: TestShardLease[] = [await wait(slotIdentity(scopeIdentity, request.key, "gate"))]
  try {
    for (let slot = 0; slot < SHARED_LEASE_SLOTS; slot += 1) {
      held.push(await wait(slotIdentity(scopeIdentity, request.key, `slot${slot}`)))
    }
  } catch (error) {
    for (const lease of [...held].reverse()) lease.release()
    throw error
  }
  return { leases: held, label: `${request.key}:exclusive` }
}

/** The gate only long enough to claim a free slot, so two shared holders of
 *  the same key overlap while an exclusive holder still excludes both. */
const acquireSharedKey = async (
  request: KeyedLeaseRequest,
  options: KeyedTestShardLeaseOptions,
  deadline: number,
  startedAt: number,
  wait: WaitForIdentity,
): Promise<KeyAcquisition> => {
  const gateIdentity = slotIdentity(options.scopeIdentity, request.key, "gate")
  const pollMs = options.pollMs ?? 1_000
  while (true) {
    const gate = await wait(gateIdentity)
    try {
      for (let slot = 0; slot < SHARED_LEASE_SLOTS; slot += 1) {
        const held = tryHoldLease(slotIdentity(options.scopeIdentity, request.key, `slot${slot}`))
        if (held !== undefined) return { leases: [held], label: `${request.key}:shared` }
      }
    } finally {
      // Always hand the gate back: holding it while waiting for a slot would
      // block the very readers whose exit frees one.
      gate.release()
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `[test:shards] shared lease for ${request.key} timed out: all ${SHARED_LEASE_SLOTS} slots busy`,
      )
    }
    options.onWait?.(request.key, testShardLeasePort(gateIdentity), Date.now() - startedAt)
    await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

const acquireOneKey = async (
  request: KeyedLeaseRequest,
  options: KeyedTestShardLeaseOptions,
  deadline: number,
  startedAt: number,
): Promise<KeyAcquisition> => {
  const wait = waiterFor(request, options, deadline)
  return request.mode === "exclusive"
    ? acquireExclusiveKey(request, options.scopeIdentity, wait)
    : acquireSharedKey(request, options, deadline, startedAt, wait)
}

export const acquireKeyedTestShardLeases = async (
  options: KeyedTestShardLeaseOptions,
): Promise<KeyedTestShardLease> => {
  const requests = canonicalLeaseRequests(options.keys)
  const acquired: KeyAcquisition[] = []
  const startedAt = Date.now()
  const deadline = startedAt + (options.waitMs ?? 90 * 60_000)
  try {
    for (const request of requests) {
      acquired.push(await acquireOneKey(request, options, deadline, startedAt))
    }
  } catch (error) {
    // Reverse order, so a failed second key can never strand the first.
    for (const entry of [...acquired].reverse()) {
      for (const lease of [...entry.leases].reverse()) lease.release()
    }
    throw error
  }
  let released = false
  return {
    keys: acquired.map(({ label }) => label),
    ports: acquired.flatMap(({ leases }) => leases.map(({ port }) => port)),
    release() {
      if (released) return
      released = true
      for (const entry of [...acquired].reverse()) {
        for (const lease of [...entry.leases].reverse()) lease.release()
      }
    },
  }
}
