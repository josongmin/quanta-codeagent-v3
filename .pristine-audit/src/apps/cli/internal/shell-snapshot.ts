import type { AgentConfig } from "@/agent"
import {
  createBunSpawner,
  createShellSnapshotPort,
  type ShellSnapshotPort,
} from "@/runtime/shell-snapshot"
import type { ShellSnapshotMetric } from "@/runtime/shell-snapshot/metric-port"
import { readCliKnob } from "../cli-knobs-accessor"
import { hasArg } from "./argv"

/**
 * ADR-0237 — per-turn shell-snapshot CLI composition (ADR-0024 split out of
 * `internal.ts`). Re-exported from `../internal` so existing importers keep
 * resolving them from `./internal`.
 *
 * Default-OFF byte-identical: unless `QUANTA_SHELL_SNAPSHOT=1` (or the
 * `--shell-snapshot` flag) is set, this returns `undefined`. The assembled
 * `AgentConfig` then omits `shellSnapshot` entirely (RFC §1.2 default-OFF),
 * and every `runShell` spawn is the legacy `["bash","-lc",cmd]` argv. With
 * the knob set, a production {@link ShellSnapshotPort} is built with a
 * `Bun.spawn`-backed adapter ({@link createBunSpawner}) and the 5-knob block
 * is populated from sibling env vars:
 *
 *   QUANTA_SHELL_SNAPSHOT          1 → opt-in (also: `--shell-snapshot` arg)
 *   QUANTA_SHELL_SNAPSHOT_SHELL    auto | zsh | bash   (default "auto" =
 *                                   `$SHELL` basename detection)
 *   QUANTA_SHELL_SNAPSHOT_TURN     "0" → one-shot at session start (default
 *                                   on → capture at every turn-start)
 *   QUANTA_SHELL_SNAPSHOT_CLEANUP  int ms cutoff for the age-based prune
 *                                   (default 864e5*10 = 10 days)
 *   QUANTA_SHELL_SNAPSHOT_MAX_MB   int MB ceiling for the directory; over
 *                                   budget ⇒ oldest-first eviction at
 *                                   session-start prune (default 100MB)
 *   QUANTA_SHELL_SNAPSHOT_TIMEOUT  int ms cap on each `Bun.spawn` capture
 *                                   call (the {@link createBunSpawner}
 *                                   `defaultTimeoutMs`; default 10 000)
 *
 * The current `$SHELL` is forwarded as `shellEnv` so `resolveShell("auto")`
 * can pick the right adapter without violating the @/agent slice invariant
 * (no `process.env` reads inside the loop).
 *
 * Returns the literal `AgentConfig["shellSnapshot"]` shape so the caller
 * can spread it conditionally into `SessionDeps.shellSnapshot`.
 */
/** Optional dependencies for {@link buildShellSnapshotConfig}. */
export interface BuildShellSnapshotConfigOpts {
  /** ADR-0222 — wired shell-snapshot metric port. Caller produces this via
   *  `wireShellSnapshotMetric(metrics)` (or the bundle helper
   *  `wireNewSlices(metrics).shellSnapshot`). Absent ⇒ no metric injection
   *  (byte-identical legacy). */
  readonly metric?: ShellSnapshotMetric
}

export const buildShellSnapshotConfig = (
  opts: BuildShellSnapshotConfigOpts = {},
): AgentConfig["shellSnapshot"] | undefined => {
  const enabled =
    (readCliKnob("QUANTA_SHELL_SNAPSHOT", "bool") ?? false) || hasArg("--shell-snapshot")
  if (!enabled) return undefined
  const intEnv = (key: string): number | undefined => {
    const raw = process.env[key]
    if (raw === undefined) return undefined
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const timeoutMs = intEnv("QUANTA_SHELL_SNAPSHOT_TIMEOUT")
  // Spawner timeout: pass-through ONLY when set (the factory has its own
  // safe default that mirrors the capture adapter default).
  const spawner = createBunSpawner(timeoutMs !== undefined ? { defaultTimeoutMs: timeoutMs } : {})
  // ADR-0222 wire — optional metric port. Absent ⇒ no allocation, byte-
  // identical to legacy (the factory checks `metric === undefined`).
  const port: ShellSnapshotPort = createShellSnapshotPort(
    spawner,
    opts.metric !== undefined ? { metric: opts.metric } : undefined,
  )
  const rawShell = process.env.QUANTA_SHELL_SNAPSHOT_SHELL
  const shell: "auto" | "zsh" | "bash" =
    rawShell === "zsh" || rawShell === "bash" || rawShell === "auto" ? rawShell : "auto"
  const cleanupOlderThanMs = intEnv("QUANTA_SHELL_SNAPSHOT_CLEANUP")
  const maxMb = intEnv("QUANTA_SHELL_SNAPSHOT_MAX_MB")
  const maxSizeBytes = maxMb !== undefined ? maxMb * 1024 * 1024 : undefined
  // QUANTA_SHELL_SNAPSHOT_TURN: "0" ⇒ one-shot capture at session start, any
  // other value (including unset / "1") ⇒ per-turn capture (the helper
  // default). Explicit literal so a typo (e.g. "off", "false") falls through
  // to the safer per-turn default.
  const captureAtTurnStart = process.env.QUANTA_SHELL_SNAPSHOT_TURN !== "0"
  // shellEnv: pass through $SHELL ONCE so resolveShell can do basename
  // detection without the agent slice peeking at process.env (ADR-0144).
  const shellEnv = process.env.SHELL
  return {
    port,
    shell,
    captureAtTurnStart,
    ...(cleanupOlderThanMs !== undefined ? { cleanupOlderThanMs } : {}),
    ...(maxSizeBytes !== undefined ? { maxSizeBytes } : {}),
    ...(shellEnv !== undefined ? { shellEnv } : {}),
  }
}
