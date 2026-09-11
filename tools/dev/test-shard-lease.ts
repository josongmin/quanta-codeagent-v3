import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"
import { clearLeaseQuarantine, quarantineVerdict, readLeaseQuarantine } from "./lease-quarantine"
import { createProcessObserver } from "./process-observer"

const LEASE_HOST = "127.0.0.1"
const LEASE_PORT_BASE = 42_000
const LEASE_PORT_SPAN = 6_000
const LEASE_PROBE_TIMEOUT_MS = 500
const LEASE_PROTOCOL = "quanta-verification-lease-v1"
export const VERIFICATION_LEASE_TOKEN_ENV = "QUANTA_VERIFICATION_LEASE_TOKEN"
export const VERIFICATION_LEASE_OWNER_PID_ENV = "QUANTA_VERIFICATION_LEASE_OWNER_PID"
/**
 * The repository identity the owner's lease is keyed on.
 *
 * A child cannot derive the owner's port without it: the identity comes from a
 * git remote the child may not resolve the same way, and guessing wrong turns a
 * handshake into a silent "no".
 */
export const VERIFICATION_LEASE_OWNER_IDENTITY_ENV = "QUANTA_VERIFICATION_LEASE_IDENTITY"

/**
 * The comparison base the campaign FROZE, handed to every child.
 *
 * Not in this module because it is about leases — it is here because this is
 * the file that already owns the campaign-to-child environment contract, and
 * splitting that contract across two modules is how one half drifts.
 */
export const VERIFICATION_BASE_OID_ENV = "QUANTA_VERIFICATION_BASE_OID"

export interface TestShardLease {
  readonly port: number
  /**
   * The nonce this lease ISSUED, held by its listener.
   *
   * A child proves inheritance by having the owner confirm it, so the value
   * must come from here and never from a caller's own `randomBytes`.
   */
  readonly token: string
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
  /**
   * Where to look for a quarantine left by a campaign that could not account
   * for its workers. Omitted ⇒ no quarantine gate, which is the right default
   * for the keyed resource leases; the REPOSITORY lane passes it.
   */
  readonly quarantinePath?: string
  /** Injected so the gate is testable without a real process tree. */
  readonly isGroupAlive?: (pgid: number) => boolean
  readonly onQuarantineWait?: (reason: string) => void
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

/**
 * Ancestors from ONE bounded snapshot, not a `ps` per hop.
 *
 * The predecessor ran `Bun.spawnSync(["ps", …])` with no timeout for every
 * step beyond the current process — the same unbounded synchronous observation
 * this ticket removed from the watchdog and the drain, on a path that decides
 * whether a runner may skip lease acquisition. A wedged `ps` here hangs the
 * decision; a slow one makes it load-sensitive.
 */
const snapshotParentPid = (): ParentPid => {
  let parents: ReadonlyMap<number, number> | undefined
  return (pid) => {
    if (pid === process.pid) {
      return Number.isSafeInteger(process.ppid) && process.ppid > 0 ? process.ppid : undefined
    }
    if (parents === undefined) {
      const snapshot = createProcessObserver().snapshot()
      parents = new Map(
        snapshot.kind === "ok" ? snapshot.rows.map((row) => [row.pid, row.ppid] as const) : [],
      )
    }
    const ppid = parents.get(pid)
    return ppid !== undefined && ppid > 0 ? ppid : undefined
  }
}

export interface InheritedLeaseInput {
  readonly env: NodeJS.ProcessEnv
  readonly currentPid?: number
  readonly parentPid?: ParentPid
  /**
   * Ask the OWNER whether it issued this token. Fails closed on any error.
   *
   * Injected so the handshake is testable without binding a real port, and
   * REQUIRED in production: without it the token is only a shape.
   */
  readonly confirmToken?: (token: string) => Promise<boolean>
}

/**
 * A nested runner may skip reacquisition only when the outer campaign is still
 * in its live ancestor chain AND still vouches for the token it was handed.
 *
 * The ancestor walk alone was not a proof of anything. The token was checked
 * against `/^[a-f0-9]{64}$/` and nothing held the value, so any child under a
 * live campaign could mint its own and skip acquisition, and a token kept from
 * an earlier campaign replayed against the next one. The handshake makes the
 * live owner the authority: a fabricated token was never issued, a replayed one
 * belongs to a listener that is gone, and a rebound lane has a different token.
 */
export const inheritedTestShardLeaseState = async (
  input: InheritedLeaseInput,
): Promise<InheritedLeaseState> => {
  const { env } = input
  const token = env[VERIFICATION_LEASE_TOKEN_ENV]
  const ownerText = env[VERIFICATION_LEASE_OWNER_PID_ENV]
  if (token === undefined && ownerText === undefined) return "absent"
  if (!/^[a-f0-9]{64}$/.test(token ?? "")) return "invalid"
  const owner = Number.parseInt(ownerText ?? "", 10)
  if (!Number.isSafeInteger(owner) || owner <= 1) return "invalid"
  const parentPid = input.parentPid ?? snapshotParentPid()
  let cursor = input.currentPid ?? process.pid
  const visited = new Set<number>()
  let ancestral = false
  while (cursor > 1 && !visited.has(cursor)) {
    if (cursor === owner) {
      ancestral = true
      break
    }
    visited.add(cursor)
    cursor = parentPid(cursor) ?? 0
  }
  if (!ancestral) return "invalid"
  // A live ancestor is necessary and NOT sufficient: pids are recycled, and a
  // child of the right process can still be holding a token nobody issued.
  if (input.confirmToken === undefined) return "invalid"
  return (await input.confirmToken(token as string)) ? "valid" : "invalid"
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
 * A nested runner proves inheritance by asking the OWNER, over the owner's own
 * listener, whether it issued the token the child was handed.
 *
 * `inheritedTestShardLeaseState` used to accept any 64 hex characters beside a
 * live ancestor pid. The campaign generated a fresh `randomBytes(32)` per child
 * and nothing anywhere held the value, so the token proved only that somebody
 * could produce hex — a child could mint its own and skip acquisition entirely,
 * and a token kept from a previous campaign replayed against the next one.
 *
 * Binding it to the LIVE listener closes all three: a fabricated token was
 * never issued, a replayed one belongs to a listener that is gone, and a
 * rebound lane has a different token because the new owner minted it.
 */
const tokenRequest = (digest: string, token: string): string =>
  `${LEASE_PROTOCOL}?token:${digest}:${token}\n`
const TOKEN_OK = `${LEASE_PROTOCOL}!token-ok\n`
const TOKEN_NO = `${LEASE_PROTOCOL}!token-no\n`

/**
 * The listener answers an identity handshake so a contender can distinguish
 * "this repository's verification lane is busy" from "an unrelated service
 * happens to sit on the hashed port" — the latter previously stalled a
 * campaign for the full 90-minute wait with no diagnosis.
 */
const tryListen = (
  port: number,
  digest: string,
  token: string,
):
  | Bun.TCPSocketListener<{ readonly digest: string; readonly token: string; buffer: string }>
  | undefined => {
  try {
    return Bun.listen({
      hostname: LEASE_HOST,
      port,
      data: { digest, token, buffer: "" },
      socket: {
        open(socket) {
          socket.data = { digest: socket.data.digest, token: socket.data.token, buffer: "" }
        },
        data(socket, data) {
          socket.data.buffer += new TextDecoder().decode(data)
          if (!socket.data.buffer.includes("\n")) return
          if (socket.data.buffer === leaseRequest(socket.data.digest)) {
            socket.end(leaseResponse(socket.data.digest))
            return
          }
          // Constant answer either way: the challenge says yes or no and never
          // echoes the held token, so a caller cannot walk it out of the owner.
          if (socket.data.buffer.startsWith(`${LEASE_PROTOCOL}?token:`)) {
            socket.end(
              socket.data.buffer === tokenRequest(socket.data.digest, socket.data.token)
                ? TOKEN_OK
                : TOKEN_NO,
            )
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

/** Ask the owner whether it issued this token. Never throws; a failure is `false`. */
export const confirmLeaseToken = (
  port: number,
  identity: string,
  token: string,
): Promise<boolean> =>
  new Promise((resolve) => {
    const digest = leaseDigest(identity)
    let settled = false
    let response = ""
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const socket = createConnection({ host: LEASE_HOST, port })
    const timer = setTimeout(() => finish(false), LEASE_PROBE_TIMEOUT_MS)
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(tokenRequest(digest, token)))
    socket.on("data", (chunk: string) => {
      response += chunk
      if (response.includes("\n")) finish(response === TOKEN_OK)
    })
    socket.on("error", () => finish(false))
    socket.on("end", () => finish(response === TOKEN_OK))
  })

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
  token: string,
): TestShardLease => {
  let released = false
  return {
    port,
    token,
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
 * `undefined` when the lane is takeable; otherwise the reason it is not.
 *
 * A stale record is REMOVED here rather than merely ignored: leaving it behind
 * means every future contender re-derives the same "actually it is fine"
 * answer, and the first one to crash mid-check leaves it looking authoritative
 * again.
 */
const quarantineBlock = (
  identity: string,
  options: Omit<TestShardLeaseOptions, "identity">,
): string | undefined => {
  const path = options.quarantinePath
  if (path === undefined) return undefined
  const verdict = quarantineVerdict({
    record: readLeaseQuarantine(path),
    repositoryId: identity,
    nowMs: Date.now(),
    isAlive: options.isGroupAlive ?? defaultGroupAlive,
  })
  if (verdict.kind === "blocked") return verdict.reason
  if (verdict.kind === "stale") clearLeaseQuarantine(path)
  return undefined
}

/** `kill(-pgid, 0)`: existence only, no signal delivered. */
const defaultGroupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and is not ours — still alive, still a hazard.
    return (error as { code?: string }).code === "EPERM"
  }
}

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
    // A free PORT is not a free LANE. The previous owner may have exited
    // without accounting for its workers, and the kernel hands the port back
    // the moment it does — so the quarantine is checked BEFORE the bind is
    // accepted, not after.
    const blocked = quarantineBlock(identity, options)
    if (blocked === undefined) {
      const token = randomBytes(32).toString("hex")
      const listener = tryListen(port, digest, token)
      if (listener !== undefined) return leaseFromListener(port, listener, token)
    } else if (Date.now() >= nextHeartbeatAt + startedAt) {
      options.onQuarantineWait?.(blocked)
    }
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
  // Keyed resource leases issue a token too, so the shape is uniform; nothing
  // inherits one today, which is exactly why it must not be a special case
  // waiting to be added without a listener that can confirm it.
  const token = randomBytes(32).toString("hex")
  const listener = tryListen(port, leaseDigest(identity), token)
  return listener === undefined ? undefined : leaseFromListener(port, listener, token)
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
