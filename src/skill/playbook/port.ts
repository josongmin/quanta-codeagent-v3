/**
 * Ports for the playbook slice (ADR-0203).
 *
 * Two ports — each kept small so test rigs can substitute an in-memory fake
 * without dragging a real filesystem watcher into the test process:
 *
 *   1. {@link InlineTriggerWatcherPort} — abstracts the OS file-watcher.
 *      Real adapter is `inline-trigger-watcher.ts` (uses `node:fs.watch`
 *      because the original spec called for chokidar which is not installed
 *      in this environment — `chokidar` is the obvious sibling-adapter swap
 *      target if/when installs unblock).
 *   2. {@link RepoRulesReaderPort} — read-only port into the repo-rules tree
 *      (ADR-0098). The validator MUST NOT mutate the rules; consuming the
 *      tree via a port (instead of importing `loadRepoRules` directly)
 *      lets tests pin specific rule trees without touching disk and keeps
 *      this slice off the `@/agent` boundary.
 *
 * Both ports are leaf-level. They define INTERFACE only — no implementation.
 */

import type { PlaybookFrontmatter } from "./types"

/**
 * A single trigger fire — the watcher detected a saved file whose contents
 * contain the configured comment marker.
 */
export interface InlineTriggerFire {
  /** Absolute path of the saved file. */
  readonly path: string
  /** The literal marker substring that matched (so dispatch can log it). */
  readonly marker: string
  /** 1-based line number where the marker was first found in the file. */
  readonly line: number
  /** Epoch ms of the dispatch decision. */
  readonly firedAt: number
}

/** Callback invoked by the watcher when a trigger fires. */
export type InlineTriggerCallback = (fire: InlineTriggerFire) => void

/**
 * Spec for starting a watcher. Bundles the playbook id, the resolved root,
 * and the dependency-injected callback so the watcher itself is pure-config.
 */
export interface InlineTriggerWatchSpec {
  /** Stable id of the owning playbook — embedded in fire telemetry. */
  readonly playbookId: string
  /** Absolute filesystem root the watcher scans (defaults to cwd). */
  readonly root: string
  /** Frontmatter trigger config (must be present on the playbook). */
  readonly trigger: NonNullable<PlaybookFrontmatter["trigger"]>
  /** Fire callback. */
  readonly onFire: InlineTriggerCallback
  /**
   * Debounce window in ms — fires for the same file within this window are
   * coalesced. Default 200ms (chosen to be longer than a typical editor's
   * atomic-write rename burst).
   */
  readonly debounceMs?: number
}

/** Handle returned by {@link InlineTriggerWatcherPort.start}. */
export interface InlineTriggerWatcherHandle {
  /** Stop watching and release any fs resources. Idempotent. */
  readonly stop: () => void
  /** Whether `.stop()` has been called. */
  readonly isStopped: () => boolean
}

/**
 * Filesystem watcher port. Implementations spawn a watcher rooted at
 * `spec.root` and invoke `spec.onFire` for each saved file matching
 * `spec.trigger.watchGlob` whose body contains `spec.trigger.commentMarker`.
 *
 * The port returns a typed `start` result rather than throwing on a bad root
 * so the host can render a clear error (e.g. ENOTDIR on a missing path).
 */
export interface InlineTriggerWatcherPort {
  readonly start: (
    spec: InlineTriggerWatchSpec,
  ) =>
    | { readonly ok: true; readonly handle: InlineTriggerWatcherHandle }
    | { readonly ok: false; readonly reason: "root-not-found" | "root-not-dir" | "io-error" }
}

/**
 * The slim view of the repo-rules tree the playbook validator needs. The
 * full {@link import("@/agent").RepoRules} carries more than this; we
 * project it down to JUST the fields the validator reads. This is the
 * smallest-stable-shape pattern (interface segregation): the validator
 * never sees per-layer paths or load timestamps.
 */
export interface RepoRulesView {
  /** The fully rendered rules body the host already injected this session. */
  readonly body: string
}

/**
 * Read-only port returning the current repo-rules view (if any). Returns
 * `undefined` when no rules exist for the active cwd.
 */
export interface RepoRulesReaderPort {
  readonly read: () => RepoRulesView | undefined
}
