/**
 * Launch-window gating for the persistent full-remote box pool: when extra
 * boxes are NOT explicitly opted in, the pool must (depending on reuse mode)
 * either reuse an idle box, wait for live boxes to go idle, or wait for them to
 * terminate before launching. Split out of pool.ts to isolate the polling
 * state machine from the orchestrator.
 */
import { errMessage } from "@/shared"
import { countLiveBoxes, findIdleBox } from "../box-session"
import { type PoolConfig, sleepReal } from "./types"

export interface PoolLaunchWindowRuntime {
  readonly waitForIdle: boolean
  readonly log: (message: string) => void
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly pollMs: number
  readonly deadline: number
}

export const createPoolLaunchWindowRuntime = (cfg: PoolConfig): PoolLaunchWindowRuntime => ({
  waitForIdle: cfg.waitForIdle === true,
  log: cfg.onLog ?? (() => {}),
  now: cfg.now ?? (() => Date.now()),
  sleep: cfg.sleep ?? sleepReal,
  pollMs: Math.max(1_000, cfg.waitForIdlePollMs ?? 15_000),
  deadline:
    (cfg.waitForIdleTimeoutMs ?? 45 * 60 * 1000) > 0
      ? (cfg.now ?? (() => Date.now()))() + (cfg.waitForIdleTimeoutMs ?? 45 * 60 * 1000)
      : Number.POSITIVE_INFINITY,
})

const poolLaunchWindowTimedOut = (runtime: PoolLaunchWindowRuntime): boolean =>
  runtime.now() >= runtime.deadline

const waitForReusableBoxProbe = async (
  runtime: PoolLaunchWindowRuntime,
  err: unknown,
): Promise<void> => {
  if (!runtime.waitForIdle) throw err
  if (poolLaunchWindowTimedOut(runtime)) {
    throw new Error(
      `[pool] timed out waiting for a reusable box while status probes kept failing: ${errMessage(err)}`,
    )
  }
  runtime.log(
    `[pool] waiting for a reusable box: status probe failed (${errMessage(err)}) — retrying…`,
  )
  await runtime.sleep(runtime.pollMs)
}

const handlePoolLaunchRunningBoxes = async (
  running: number,
  runtime: PoolLaunchWindowRuntime,
  announcedWait: { value: boolean },
): Promise<boolean> => {
  if (running <= 0) return true
  if (!runtime.waitForIdle) {
    throw new Error(
      `[pool] refusing to launch another box while ${running} quanta-bench box(es) are already live (running/pending). ` +
        "Wait for the existing box to go idle, or opt in explicitly.",
    )
  }
  if (poolLaunchWindowTimedOut(runtime)) {
    throw new Error(
      `[pool] timed out waiting for ${running} live quanta-bench box(es) to go idle. ` +
        "Use explicit extra-box opt-in to launch past them.",
    )
  }
  if (!announcedWait.value) {
    runtime.log(
      `[pool] waiting for ${running} live quanta-bench box(es) to go idle before launching another box…`,
    )
    announcedWait.value = true
  }
  await runtime.sleep(runtime.pollMs)
  return false
}

export const awaitPoolLaunchWindow = async (cfg: PoolConfig): Promise<string | undefined> => {
  if (cfg.allowExtraBoxes === true) return undefined
  const runtime = createPoolLaunchWindowRuntime(cfg)
  const announcedWait = { value: false }

  for (;;) {
    const idle = await findIdleBox(cfg.provision).catch(() => undefined)
    if (idle !== undefined) return idle

    let running: number
    try {
      running = await countLiveBoxes(cfg.provision)
    } catch (err) {
      await waitForReusableBoxProbe(runtime, err)
      continue
    }

    if (await handlePoolLaunchRunningBoxes(running, runtime, announcedWait)) return undefined
  }
}

const handleFreshLaunchRunningBoxes = async (
  running: number,
  runtime: PoolLaunchWindowRuntime,
  announcedWait: { value: boolean },
): Promise<boolean> => {
  if (running <= 0) return true
  if (!runtime.waitForIdle) {
    throw new Error(
      `[pool] refusing to launch a fresh box while ${running} quanta-bench box(es) are already live (running/pending). ` +
        "Reuse the existing box, wait for it to terminate, or opt in explicitly.",
    )
  }
  if (poolLaunchWindowTimedOut(runtime)) {
    throw new Error(
      `[pool] timed out waiting for ${running} live quanta-bench box(es) to terminate before launching a fresh box. ` +
        "Reuse the existing box, or use explicit extra-box opt-in.",
    )
  }
  if (!announcedWait.value) {
    runtime.log(
      `[pool] waiting for ${running} live quanta-bench box(es) to terminate before launching a fresh box…`,
    )
    announcedWait.value = true
  }
  await runtime.sleep(runtime.pollMs)
  return false
}

export const awaitFreshLaunchWindow = async (cfg: PoolConfig): Promise<void> => {
  if (cfg.allowExtraBoxes === true) return
  const runtime = createPoolLaunchWindowRuntime(cfg)
  const announcedWait = { value: false }

  for (;;) {
    let running: number
    try {
      running = await countLiveBoxes(cfg.provision)
    } catch (err) {
      await waitForReusableBoxProbe(runtime, err)
      continue
    }

    if (await handleFreshLaunchRunningBoxes(running, runtime, announcedWait)) return
  }
}

export const awaitPoolPreflightLaunchWindow = async (cfg: PoolConfig): Promise<void> => {
  if ((cfg.reuseWarm ?? true) === true) {
    await awaitPoolLaunchWindow(cfg)
    return
  }
  await awaitFreshLaunchWindow(cfg)
}
