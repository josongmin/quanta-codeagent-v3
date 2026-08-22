/**
 * Inline-trigger sub-slice BARREL (ADR-0250).
 *
 * Slice posture: SELF-CONTAINED. Re-exports the closed port, the
 * `fs.watch` production adapter, the headless test stub, the pure
 * helpers (debouncer + comment-scanner), and the public types.
 *
 * Default-OFF wire: nothing here is constructed in production paths
 * unless a host calls one of the factories. The sibling
 * `../inline-trigger-watcher.ts` (ADR-0203) remains the path used by
 * `auto-dispatch`; THIS slice is the smaller primitive available to
 * hosts that want raw marker scans without the playbook envelope.
 *
 * Recommended consumption:
 *
 *   import { createFsWatchInlineTrigger, type TriggerEvent } from
 *     "@/skill/playbook/trigger"
 *
 *   const watcher = createFsWatchInlineTrigger()
 *   const res = watcher.watch([process.cwd()], ["AIDER!", "QUANTA!"], (ev) => {
 *     console.log(`${ev.file}:${ev.line}  ${ev.marker}`)
 *   })
 *   if (!res.ok) handle(res.error)
 *   // … later …
 *   res.subscription.unsubscribe()
 */

export { findMarkerLine, scanFile } from "./comment-scanner"
export { createDebouncer, type Debouncer } from "./debouncer"
export { createFsWatchInlineTrigger } from "./fs-watch-adapter"
export {
  createHeadlessInlineTrigger,
  type HeadlessInlineTriggerWatcher,
} from "./headless-stub"
export type {
  InlineTriggerCallback,
  InlineTriggerWatcher,
  Subscription,
  TriggerCallback,
  WatchResult,
} from "./port"
export { DEFAULT_DEBOUNCE_MS, type TriggerError, type TriggerEvent } from "./types"
