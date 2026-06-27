/**
 * Shared low-level connection + shell primitives for the box-session cluster.
 * Extracted from `box-session.ts` so the EC2-lifecycle and detached-poll
 * concerns both build commands / ssh / aws the SAME way (one keepalive policy,
 * one quoter). PURE/thin — all IO routes through the injected {@link SpawnFn}.
 */

import type { SpawnFn, SpawnResult } from "../backend"

/** First whitespace-delimited token of a (possibly multi-line) aws-cli `text`
 *  output — aws `--output text` for a single scalar still emits a trailing
 *  newline, and some queries print a stray header line. */
export const oneLine = (s: string): string => s.trim().split(/\s+/)[0] ?? ""

/** Single-quote a value for safe interpolation into a remote bash command
 *  string. Without this, a preset/model/instance-id containing a space, `;`,
 *  `$(...)`, backtick, or `|` would break out of the intended command (the
 *  token is piped over STDIN and is safe, but these env/flag values are not). */
export const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/** ssh/scp/rsync host-key + safety options for EPHEMERAL bench boxes (SSOT —
 *  makeSsh, the rsync `-e` transport, and scp ALL use these so they connect the
 *  SAME way).
 *
 *  Host-key checking is DISABLED on purpose (RCA jun-25):
 *  - bench boxes are launched & identified by US via the AWS instance API, not by
 *    a persistent host identity, so a MITM host-key check adds ~zero value;
 *  - EC2 RECYCLES public IPs, so a fresh box routinely lands on an IP already in
 *    the user's `~/.ssh/known_hosts` with a DIFFERENT (stale) key. The prior
 *    `StrictHostKeyChecking=accept-new` then REFUSES that box (instant exit 255,
 *    BEFORE auth) — which surfaced as "box never became ssh-reachable" while the
 *    box was in fact fully up and reachable via `ssh -o StrictHostKeyChecking=no`;
 *  - persisting throwaway box keys POLLUTES the real known_hosts (it had 1400+
 *    stale entries), which is what SEEDS the recycled-IP collisions above.
 *  `UserKnownHostsFile=/dev/null` ⇒ never read/poison the real file; `=no` ⇒
 *  never refuse/prompt on a host key; `BatchMode=yes` ⇒ never block on ANY prompt
 *  (a hung passphrase/confirm prompt is invisible and indistinguishable from a
 *  dead box); `LogLevel=ERROR` silences the now-expected known-hosts warning so
 *  the REAL ssh stderr stays diagnosable in the readiness loop. */
export const BENCH_SSH_SAFE_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "BatchMode=yes",
  "-o",
  "LogLevel=ERROR",
] as const

/** Full-remote readiness/retry waits MUST keep the owner process alive.
 *  `unref()` here let the CLI exit cleanly while still awaiting cloud-init,
 *  orphaning fresh EC2 boxes before bootstrap finished. */
export const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((r) => {
    setTimeout(r, ms)
  })

export const aws =
  (spawn: SpawnFn, region: string) =>
  (args: readonly string[]): Promise<SpawnResult> =>
    spawn("aws", ["--region", region, ...args])

/** ssh helper bound to host+key. Token (when given) goes over STDIN — never an
 *  argv. Short connect-timeout so a closed :22 fails fast.
 *
 *  KEEPALIVE — MIDDLE GROUND (RCA jun-20, two OPPOSITE failure modes):
 *  - ZERO keepalive (the prior over-correction) HANGS: the long run is one
 *    foreground `ssh '… bun run … | tee run.log'`. During patch-gen (8 agents,
 *    minutes of NO stdout) the idle TCP is silently dropped by NAT/firewall;
 *    with no probes ssh never DETECTS the dead socket, so `await ssh` hangs
 *    forever even after the box finishes — the orchestrator is later killed and
 *    the box is ORPHANED (results stranded on it). Observed on 2/2 long runs:
 *    no `run finished (exit …)` line ⇒ the await never returned.
 *  - TIGHT keepalive (`15 / CountMax=4`, 60s grace) TORE DOWN healthy runs: a
 *    CPU-saturated box can't answer probes within 60s → `exit 255`, empty log.
 *  The fix: probes every 30s keep the idle TCP alive THROUGH the silence (NAT
 *  idle ~300s ≫ 30s). The run itself is now DETACHED (`setsid`), so it survives a
 *  dropped ssh; status comes from SHORT reconnecting polls. CountMax is the
 *  jun-25 value `4` (30×4 = 120s): a hung/partitioned poll errors in ~2min so
 *  box-death detection trips fast, instead of the old 30×20 = 600s that left a
 *  dead box hanging the run for ~10min/poll. `TCPKeepAlive=yes` is OS-layer
 *  belt-and-suspenders. */
export const makeSsh =
  (spawn: SpawnFn, keyPath: string, host: string) =>
  (remoteCmd: string, input?: string, onData?: (chunk: string) => void): Promise<SpawnResult> =>
    spawn(
      "ssh",
      [
        "-i",
        keyPath,
        ...BENCH_SSH_SAFE_OPTS,
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=30",
        // jun-25: 20→4. A network-partitioned/dead box leaves an established
        // poll ssh BLOCKED until SSH gives up = ServerAliveInterval*CountMax.
        // At 20 that was 10min PER hung poll, so the detached-poll box-death
        // detector (which needs N consecutive poll FAILURES) took hours to
        // trip → a dead box hung the run for ~30min+ instead of being requeued.
        // 4 ⇒ a hung ssh errors in 2min, so consecutive-failure detection +
        // aws liveness confirm fire in minutes. Healthy boxes answer keepalives
        // instantly, so this never trips on a live box.
        "-o",
        "ServerAliveCountMax=4",
        "-o",
        "TCPKeepAlive=yes",
        host,
        remoteCmd,
      ],
      ...(input !== undefined || onData !== undefined
        ? [
            {
              ...(input !== undefined ? { input } : {}),
              ...(onData !== undefined ? { onData } : {}),
            },
          ]
        : []),
    )

/**
 * Live OTEL: open a persistent reverse SSH tunnel (box localhost:<port> →
 * operator localhost:<port>) so the box's agent loop — when its env carries
 * QUANTA_OTEL_ENDPOINT=http://localhost:<port> — streams OTLP spans straight into
 * the operator's local trace-sink/UI. REPLACES the flaky box→local run.log tail as
 * the live-progress channel (spans carry per-turn LLM prompt/response + tool calls).
 *
 * Returns a no-op closer UNLESS QUANTA_OTEL_ENDPOINT points at localhost, so it is
 * byte-identical / zero-cost when live tracing isn't requested. Bun.spawn (not the
 * awaitable SpawnFn) keeps a killable long-lived child; `-N` runs no remote command;
 * ExitOnForwardFailure fails loudly on a bind clash instead of silently running
 * tunnel-less. Per-box loopback bind ⇒ N concurrent boxes never collide — each
 * box's :port is independent and all forward to the one operator sink (spans
 * disambiguated by QUANTA_OTEL_SERVICE_NAME).
 */
export const openOtelReverseTunnel = (
  keyPath: string,
  host: string,
  endpoint: string,
  log: (msg: string) => void,
): { close: () => void } => {
  // `endpoint` (QUANTA_OTEL_ENDPOINT) is resolved by the caller at the allowlisted
  // composition root and passed in, so this slice reads no env (no-process-env).
  const match = (endpoint ?? "").match(/^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/)
  if (match === null) return { close: () => {} }
  const port = match[1]
  const proc = Bun.spawn(
    [
      "ssh",
      "-i",
      keyPath,
      ...BENCH_SSH_SAFE_OPTS,
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ExitOnForwardFailure=yes",
      "-N",
      "-R",
      `${port}:localhost:${port}`,
      host,
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  )
  log(
    `[full-remote] 📡 OTEL reverse tunnel up (box localhost:${port} → operator:${port}) — live spans → trace UI`,
  )
  let closed = false
  return {
    close: () => {
      if (closed) return
      closed = true
      try {
        proc.kill()
      } catch {
        // box already gone / tunnel already dead — nothing to reap
      }
    },
  }
}
