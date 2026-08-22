/**
 * `apps/cli/repl/playbook-trigger-wire.ts` — ADR-0293 CLI auto-bind opt-in.
 *
 * WHY: `src/skill/playbook/wire.ts:startPlaybookFromTrigger` is a one-line
 * bridge between an `AgentConfig.playbookTrigger` slot and the inline-trigger
 * orchestrator, but TODAY the slot is never populated by any default host
 * call — `buildBaseFromArgs` doesn't reach into the playbook slice. This
 * helper is the CLI-side opt-in that constructs a minimal trigger block
 * (FS watcher rooted at `.quanta/playbooks/` + EMPTY registry placeholder
 * + caller-supplied sink) and returns a handle the session-lifecycle wire
 * stops on `finish`.
 *
 * Default-OFF byte-identical (RFC §1.2): when neither
 * `QUANTA_PLAYBOOK_TRIGGER=on` nor the explicit boolean opt-in is set, the
 * helper returns a NOOP handle and allocates NOTHING (no loader, watcher,
 * controller, or fs access). The env precedence (env wins over flag=false)
 * is documented in ADR-0293.
 *
 * No-throw: every public surface returns a handle. Construction failures
 * (registry load failure, watcher.start ok:false) surface via `logger.warn`
 * + a typed operator notice / NOOP handle. Sink throws DO NOT bubble — the wrapped sink catches
 * + reports via `logger.warn`.
 *
 * An empty successful scan emits one warning on the operator-notice bus at
 * engage time. Invalid files and root failures surface typed loader details.
 *
 * Slice posture: leaf-level. Imports `@/skill/playbook` (loader, wire, and
 * controller types). NO `@/agent` runtime imports beyond the structural
 * `PlaybookPlanQueueSink` type from the playbook barrel.
 */

import { resolve as resolvePath } from "node:path"
import { emitOperatorNotice, errMessage, gateOn } from "@/shared"
import {
  createDiskPlaybookRegistry,
  createInlineTriggerWatcher,
  type InlineTriggerWatcherPort,
  type PlaybookPlanQueueSink,
  startPlaybookFromTrigger,
} from "@/skill/playbook"
/** Handle returned by {@link maybeStartPlaybookTriggerWire}. `stop()` is
 *  idempotent; `isActive()` reports whether the env/flag opt-in fired. */
export interface PlaybookTriggerWireHandle {
  readonly stop: () => void
  readonly isActive: () => boolean
}

/** Options for {@link maybeStartPlaybookTriggerWire}. Every field except
 *  `env`/`threadId`/`planQueueSink` is optional; absent values fall back to
 *  defaults documented per-field. */
export interface PlaybookTriggerWireOptions {
  readonly env: NodeJS.ProcessEnv
  readonly cliFlag?: boolean
  readonly threadId: string
  readonly planQueueSink: PlaybookPlanQueueSink
  /** Filesystem root for the watcher. Default: `<cwd>/.quanta/playbooks`. */
  readonly registryRoot?: string
  readonly logger?: { warn: (m: string) => void }
  readonly now?: () => number
  /** Closed-port test seam. Default allocates the production fs watcher. */
  readonly watcherFactory?: () => InlineTriggerWatcherPort
}

/** Inert handle reused for every default-OFF / no-op path. Shared singleton
 *  so default-OFF allocates NOTHING beyond this one frozen object. */
const NOOP_HANDLE: PlaybookTriggerWireHandle = Object.freeze({
  stop: () => {
    /* noop — idempotent */
  },
  isActive: () => false,
})

const NOOP_LOGGER = Object.freeze({ warn: (_message: string): void => undefined })

/** True when the CLI opt-in is active. Env value MUST be the literal `"on"`
 *  (case-sensitive); `"1"` / `"true"` / `"off"` / `"ON"` all evaluate false.
 *  Env wins over a flag=false because operators tend to set env vars to
 *  override a hard-coded default. */
const isOptedIn = (env: NodeJS.ProcessEnv, cliFlag: boolean | undefined): boolean => {
  if (gateOn(env, "QUANTA_PLAYBOOK_TRIGGER")) return true
  return cliFlag === true
}

/** Wrap the caller-supplied sink so throws surface via the logger and
 *  never poison the orchestrator. The orchestrator already absorbs returned
 *  `{ok:false}` outcomes, so we ONLY need to convert thrown errors. */
const safeSink = (
  sink: PlaybookPlanQueueSink,
  logger: { warn: (m: string) => void },
): PlaybookPlanQueueSink => ({
  enqueue: (input) => {
    try {
      return sink.enqueue(input)
    } catch (e) {
      const reason = errMessage(e)
      logger.warn(`[playbook-trigger] sink threw: ${reason}`)
      return { ok: false, reason }
    }
  },
})

/** CLI auto-bind opt-in for the inline-trigger watcher. See file-level
 *  JSDoc for env/flag precedence + default-OFF guarantees. */
export const maybeStartPlaybookTriggerWire = (
  opts: PlaybookTriggerWireOptions,
): PlaybookTriggerWireHandle => {
  if (!isOptedIn(opts.env, opts.cliFlag)) return NOOP_HANDLE
  const logger = opts.logger ?? NOOP_LOGGER

  const root = resolvePath(opts.registryRoot ?? `${process.cwd()}/.quanta/playbooks`)
  const registry = createDiskPlaybookRegistry(root)
  const loaded = registry.lastReload()
  if (!loaded.ok) {
    for (const problem of loaded.issues) {
      logger.warn(
        `[playbook-trigger] registry load failed (${problem.code}) at ${problem.path}: ${problem.message}`,
      )
    }
    const first = loaded.issues[0]
    emitOperatorNotice({
      severity: "warn",
      source: "playbook-trigger",
      message: `trigger enabled but registry load failed: ${first?.path ?? root}: ${first?.message ?? "unknown error"}`,
      hint: "watcher not started",
    })
    return NOOP_HANDLE
  }

  if (registry.list().length === 0) {
    emitOperatorNotice({
      severity: "warn",
      source: "playbook-trigger",
      message: "trigger enabled but no playbooks registered — fires will never dispatch",
      hint: `${root} contains no valid top-level *.md playbooks`,
    })
  }

  let controller: ReturnType<typeof startPlaybookFromTrigger>
  try {
    controller = startPlaybookFromTrigger({
      enabled: true,
      watcher: (opts.watcherFactory ?? createInlineTriggerWatcher)(),
      registry,
      planQueueSink: safeSink(opts.planQueueSink, logger),
      threadId: opts.threadId,
      defaultRoot: root,
    })
  } catch (e) {
    const reason = errMessage(e)
    logger.warn(`[playbook-trigger] startPlaybookFromTrigger threw: ${reason}`)
    return NOOP_HANDLE
  }

  let stopped = false
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      try {
        controller.stop()
      } catch {
        /* idempotent — host MUST be able to call stop() multiple times */
      }
    },
    isActive: () => true,
  }
}
