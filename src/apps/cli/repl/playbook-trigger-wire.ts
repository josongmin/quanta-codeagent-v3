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
 * helper returns a NOOP handle and allocates NOTHING (no watcher, no
 * controller, no fs.stat). The env precedence (env wins over flag=false)
 * is documented in ADR-0293.
 *
 * No-throw: every public surface returns a handle. Construction failures
 * (registry root missing, watcher.start ok:false) surface via `logger.warn`
 * + NOOP handle. Sink throws DO NOT bubble — the wrapped sink catches
 * + reports via `logger.warn`.
 *
 * Slice posture: leaf-level. Imports `@/skill/playbook` (the wire +
 * controller types) and `node:fs` (existsSync — synchronous because we
 * fail fast on session bootstrap, not in a hot path). NO `@/agent` runtime
 * imports beyond the structural `PlaybookPlanQueueSink` type from the
 * playbook barrel.
 */

import { existsSync, statSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { errMessage } from "@/shared"
import {
  createInlineTriggerWatcher,
  type PlaybookPlanQueueSink,
  type PlaybookRegistry,
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
}

/** Inert handle reused for every default-OFF / no-op path. Shared singleton
 *  so default-OFF allocates NOTHING beyond this one frozen object. */
const NOOP_HANDLE: PlaybookTriggerWireHandle = Object.freeze({
  stop: () => {
    /* noop — idempotent */
  },
  isActive: () => false,
})

/** Empty registry — the CLI bind opt-in does NOT scan SKILL.md files today
 *  (that's a follow-up wire). A real registry can be injected later by a
 *  surface-composition step; for now the trigger fires + dispatches against
 *  whatever the watcher sees, with this stand-in keeping `enabled: true`
 *  byte-identical to "no registrations matched". */
const EMPTY_REGISTRY: PlaybookRegistry = {
  list: () => [],
}

/** True when the CLI opt-in is active. Env value MUST be the literal `"on"`
 *  (case-sensitive); `"1"` / `"true"` / `"off"` / `"ON"` all evaluate false.
 *  Env wins over a flag=false because operators tend to set env vars to
 *  override a hard-coded default. */
const isOptedIn = (env: NodeJS.ProcessEnv, cliFlag: boolean | undefined): boolean => {
  if (env.QUANTA_PLAYBOOK_TRIGGER === "on") return true
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

/** Validate the registry root resolves to an actual directory. Returns the
 *  resolved absolute path on success; `undefined` on miss (the caller logs
 *  + returns NOOP). */
const validateRoot = (root: string): string | undefined => {
  try {
    if (!existsSync(root)) return undefined
    if (!statSync(root).isDirectory()) return undefined
    return root
  } catch {
    return undefined
  }
}

/** CLI auto-bind opt-in for the inline-trigger watcher. See file-level
 *  JSDoc for env/flag precedence + default-OFF guarantees. */
export const maybeStartPlaybookTriggerWire = (
  opts: PlaybookTriggerWireOptions,
): PlaybookTriggerWireHandle => {
  const logger = opts.logger ?? { warn: () => undefined }
  if (!isOptedIn(opts.env, opts.cliFlag)) return NOOP_HANDLE

  const root = resolvePath(opts.registryRoot ?? `${process.cwd()}/.quanta/playbooks`)
  const validated = validateRoot(root)
  if (validated === undefined) {
    logger.warn(`[playbook-trigger] registry root not found or not a directory: ${root}`)
    return NOOP_HANDLE
  }

  let controller: ReturnType<typeof startPlaybookFromTrigger>
  try {
    controller = startPlaybookFromTrigger({
      enabled: true,
      watcher: createInlineTriggerWatcher(),
      registry: EMPTY_REGISTRY,
      planQueueSink: safeSink(opts.planQueueSink, logger),
      threadId: opts.threadId,
      defaultRoot: validated,
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
