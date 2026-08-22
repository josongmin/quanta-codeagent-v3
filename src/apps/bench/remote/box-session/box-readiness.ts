/**
 * LEAF — the box READINESS-POLL loop, extracted verbatim from `ec2-lifecycle.ts`.
 *
 * Structural, not cosmetic: `ec2-lifecycle.ts` sat two lines under the 1000-line
 * god-module ceiling, so the aug-22 A-C admission gate had nowhere to land. This
 * concern — "wait until ssh answers and cloud-init has finished" — is the most
 * self-contained block in that module (it touches only `ssh`, the config's sleep
 * seam and its poll budget; it knows nothing about AWS, families or bootstrap),
 * so it is the one that leaves the smallest seam behind.
 *
 * BYTE-IDENTICAL: every declaration below is moved unchanged. `resolveMaxReadyPolls`
 * is re-exported from `ec2-lifecycle.ts`, so no consumer's import moves.
 */
import type { SpawnResult } from "../backend"
import { defaultSleep } from "./shell"
import type { FullRemoteConfig } from "./types"

const READINESS_PROBE_CMD =
  "sudo cloud-init status --wait >/dev/null 2>&1; test -x ~/.bun/bin/bun && echo READY"

/** Classify a not-ready readiness probe and (when it's worth surfacing) log the
 *  REAL ssh exit + stderr — first poll, every 10th, or ANY terminal one. Returns
 *  whether it's a LOCAL-misconfig terminal error so the caller can fail fast.
 *  Extracted from {@link waitForBoxReady} to keep that loop's complexity low. */
const reportReadinessPoll = (
  i: number,
  max: number,
  probe: SpawnResult,
  log: (m: string) => void,
): { code: number; err: string; terminal: boolean } => {
  const err = (probe.stderr || probe.stdout).trim().replace(/\s+/g, " ").slice(0, 300)
  const terminal = SSH_TERMINAL_ERROR.test(err)
  if (i === 0 || i % 10 === 9 || terminal) {
    log(
      `[full-remote] readiness poll ${i + 1}/${max} not ready ` +
        `(ssh exit ${probe.code}${err ? `: ${err}` : ""})` +
        (terminal ? " — NON-RECOVERABLE (local key/config, not slow-boot)" : ""),
    )
  }
  return { code: probe.code, err, terminal }
}

/** Default cloud-init readiness window: 90 polls × 10s ≈ 15min. jun-25: 30→90.
 *  A READY box returns on the FIRST poll, so a longer window NEVER slows a
 *  healthy launch — it only tolerates a SLOW bootstrap (the exact box-loss RCA:
 *  under a degraded network / stock-AMI fallback, cloud-init's
 *  docker+bun+uv+pyright install ran past 5min, so a ssh-reachable box was
 *  abandoned as a hard loss when the old 30-poll window expired). */
const DEFAULT_READY_POLLS = 90

/** Resolve the readiness-poll budget. Precedence: the test-seam `cfg.maxReadyPolls`
 *  (deterministic tests) → the operator knob `QUANTA_FULL_REMOTE_READY_POLLS`
 *  (widen for a persistently-degraded network WITHOUT a code edit) → the default.
 *  Default-safe: unset / garbage / non-positive ⇒ the default, never 0, never throws. */
export const resolveMaxReadyPolls = (cfg: FullRemoteConfig): number => {
  if (cfg.maxReadyPolls !== undefined) return cfg.maxReadyPolls
  const raw = process.env.QUANTA_FULL_REMOTE_READY_POLLS
  const parsed = raw !== undefined && raw !== "" ? Number(raw) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_READY_POLLS
}

export const waitForBoxReady = async (
  ssh: (cmd: string) => Promise<SpawnResult>,
  cfg: FullRemoteConfig,
): Promise<void> => {
  const sleep = cfg.sleep ?? defaultSleep
  const log = cfg.onLog ?? (() => {})
  const maxReadyPolls = resolveMaxReadyPolls(cfg)
  // jun-25 RCA: the prior loop DISCARDED probe.code/stderr every poll and threw a
  // hardcoded guess ("check SG :22 / cloud-init"). So a box that was provably
  // reachable + ready + world-open-SG looked IDENTICAL to a dead one — a run
  // burned ~15min × 2 retries blind-polling, and the on-call had to hand-forensic
  // (ssh + auth.log + AWS state, ~25min) to learn the readiness ssh simply never
  // reached the box. Surface the REAL exit/stderr: first failure immediately
  // (the diagnostic that matters), a heartbeat every 10th poll, and the actual
  // last error in the throw.
  let last = { code: -1, err: "", terminal: false }
  let consecutiveTerminal = 0
  for (let i = 0; i < maxReadyPolls; i++) {
    const probe = await ssh(READINESS_PROBE_CMD)
    if (probe.code === 0 && probe.stdout.includes("READY")) return
    last = reportReadinessPoll(i, maxReadyPolls, probe, log)
    consecutiveTerminal = last.terminal ? consecutiveTerminal + 1 : 0
    // A LOCAL-misconfig ssh error (wrong/unreadable key, bad option, stale changed
    // host key) NEVER heals by waiting — abort after a few consecutive hits rather
    // than burning the whole ~15min window (and a retry burning another). Auth /
    // "connection refused" / timeout stay non-terminal (transient during boot).
    if (consecutiveTerminal >= 3) {
      throw new Error(
        `[full-remote] box ssh is NON-RECOVERABLE after ${i + 1} polls ` +
          `(ssh exit ${last.code}: ${last.err}) — not a slow boot; ` +
          "check key path / host-key / SG :22, not cloud-init",
      )
    }
    await sleep(10_000)
  }
  throw new Error(
    `[full-remote] box never became ssh-reachable + bun-ready after ${maxReadyPolls} polls ` +
      `(last ssh exit ${last.code}${last.err ? `: ${last.err}` : ""})`,
  )
}

/** ssh stderr patterns that will NEVER self-heal by waiting longer — strictly
 *  LOCAL misconfiguration (wrong/unreadable/unprotected key path, a bad ssh
 *  option, a stale changed host key). These fail INSTANTLY and identically on
 *  every poll, so polling the full window is pure waste.
 *
 *  Deliberately EXCLUDED (these CAN be transient during provisioning, so they
 *  keep polling the full window):
 *  - "Connection refused" / "Operation timed out" — sshd not up yet (slow boot);
 *  - "Permission denied" / "Too many authentication failures" — there is a real
 *    window where sshd is accepting but cloud-init has not yet written the launch
 *    key into the ubuntu user's authorized_keys, so a HEALTHY box transiently
 *    rejects auth. Fast-failing on it would kill boxes mid-bootstrap (exactly the
 *    early-boot transient the 90-poll window exists to tolerate). */
const SSH_TERMINAL_ERROR =
  /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|identity file .* not accessible|Bad (?:configuration|owner)|Could not resolve hostname|UNPROTECTED PRIVATE KEY/i
