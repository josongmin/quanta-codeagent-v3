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
 *  The fix is BOTH at once: probes every 30s keep the idle TCP alive THROUGH the
 *  silence (NAT idle ~300s ≫ 30s), and a 30×20 = 600s grace tolerates a
 *  busy-but-alive box (only 20 consecutive missed probes ⇒ truly dead).
 *  `TCPKeepAlive=yes` is OS-layer belt-and-suspenders. */
export const makeSsh =
  (spawn: SpawnFn, keyPath: string, host: string) =>
  (remoteCmd: string, input?: string, onData?: (chunk: string) => void): Promise<SpawnResult> =>
    spawn(
      "ssh",
      [
        "-i",
        keyPath,
        "-o",
        "StrictHostKeyChecking=accept-new",
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
