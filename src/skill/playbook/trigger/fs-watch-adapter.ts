/**
 * `node:fs.watch` adapter for the inline-trigger watcher (ADR-0250).
 *
 * Why `node:fs.watch` and NOT `chokidar`?
 *
 *   - The verify-workflow memory (`verify-workflow.md`) records that
 *     `npm install` is BLOCKED in this environment. Anything imported
 *     here must be present in the toolchain. `chokidar` is not.
 *   - Switching to chokidar later is a one-file body swap — the port
 *     surface (`port.ts: InlineTriggerWatcher`) does not change.
 *
 * The adapter's invariants:
 *
 *   - VALIDATE roots BEFORE installing any watcher. A missing root
 *     yields a typed `root-missing` (HELL-IT-10) without leaking any
 *     partially-attached fs.watch handles for sibling roots.
 *   - `fs.watch({ recursive: true })` throw becomes `watch-failed`
 *     (HELL-IT-09); the host renders the OS error detail.
 *   - DEBOUNCE per absolute file path via `./debouncer.ts`.
 *   - SCAN via `./comment-scanner.ts` AFTER reading the file body as
 *     UTF-8 with `flag: 'r'`. A decode failure (binary file) drops
 *     the event silently — HELL-IT-11 pins this.
 *   - On `unsubscribe()`: close every `FSWatcher`, cancel every
 *     pending debounce timer (HELL-IT-15). Idempotent.
 *
 * Slice discipline: imports `node:fs`, `node:fs/promises`,
 * `node:path`, and the LOCAL sub-slice files only. NO `@/...`
 * imports, NO sibling-slice imports.
 */

import { existsSync, type FSWatcher, statSync, watch } from "node:fs"
import { readFile } from "node:fs/promises"
import { isAbsolute, resolve as resolvePath } from "node:path"
import { errMessage } from "@/shared"
import { scanFile } from "./comment-scanner"
import { createDebouncer, type Debouncer } from "./debouncer"
import type { InlineTriggerWatcher, Subscription, TriggerCallback, WatchResult } from "./port"
import { DEFAULT_DEBOUNCE_MS, type TriggerError } from "./types"

/**
 * Validate a single root. Returns `null` on success, a typed error
 * payload on failure. The split keeps `watch()` short.
 */
const checkRoot = (root: string): { kind: "root-missing"; root: string } | null => {
  if (!existsSync(root)) return { kind: "root-missing", root }
  try {
    if (!statSync(root).isDirectory()) return { kind: "root-missing", root }
  } catch {
    return { kind: "root-missing", root }
  }
  return null
}

/** Read the file's UTF-8 body. Returns `null` on any read / decode error. */
const readUtf8 = async (path: string): Promise<string | null> => {
  try {
    const body = await readFile(path, "utf8")
    // Heuristic binary-file detection: if the body contains a NUL byte we
    // treat it as binary (UTF-8 does not encode NUL inside printable text).
    // This is the same cheap detector `git` uses for `binary file Foo
    // differs` messages. The hellgate pins it (HELL-IT-11).
    if (body.includes("\0")) return null
    return body
  } catch {
    return null
  }
}

/** Resolve a possibly-relative `fs.watch` filename payload to an absolute path. */
const toAbsolutePath = (root: string, filename: string | Buffer | null): string | null => {
  if (filename === null) return null
  const rel = typeof filename === "string" ? filename : filename.toString("utf8")
  return isAbsolute(rel) ? rel : resolvePath(root, rel)
}

/**
 * Close every installed watcher AND clear any pending debounced action.
 * Idempotent — repeated calls are safe.
 */
const teardown = (installed: readonly FSWatcher[], debouncer: Debouncer): void => {
  for (const w of installed) {
    try {
      w.close()
    } catch {
      /* idempotent */
    }
  }
  debouncer.cancelAll()
}

/** Async scan + per-event callback. Stopped guards interleave with awaits. */
const scanAndEmit = async (
  absPath: string,
  markers: readonly string[],
  callback: TriggerCallback,
  isStopped: () => boolean,
): Promise<void> => {
  const body = await readUtf8(absPath)
  if (isStopped()) return
  if (body === null) return
  const events = scanFile(absPath, body, markers)
  for (const ev of events) {
    if (isStopped()) return
    callback(ev)
  }
}

/** Install one recursive `fs.watch` on `root`, wiring through `dispatch`. */
const installOne = (
  root: string,
  dispatch: (abs: string) => void,
): { ok: true; watcher: FSWatcher } | { ok: false; detail: string } => {
  let w: FSWatcher
  try {
    w = watch(root, { recursive: true })
  } catch (e) {
    return { ok: false, detail: errMessage(e) }
  }
  const handler = (_ev: string, filename: string | Buffer | null) => {
    const abs = toAbsolutePath(root, filename)
    if (abs === null) return
    dispatch(abs)
  }
  w.on("change", handler)
  w.on("rename", handler)
  w.on("error", () => {
    /* swallow — caller unsubscribes */
  })
  return { ok: true, watcher: w }
}

/**
 * Construct the production `fs.watch`-backed watcher.
 *
 * Returned `watch()`:
 *  1. Pre-validates every root; on the FIRST missing root, returns
 *     `{ ok: false, error: root-missing }` and does not install any
 *     watchers (no cleanup needed).
 *  2. Installs one `FSWatcher` per root (recursive). If any install
 *     throws, closes every watcher already installed and returns
 *     `{ ok: false, error: watch-failed }`.
 *  3. Wires every watcher's `change`+`rename` event through the same
 *     debounced scanner.
 */
export const createFsWatchInlineTrigger = (): InlineTriggerWatcher => ({
  watch: (roots, markers, callback, debounceMs) => watchImpl(roots, markers, callback, debounceMs),
})

const noopSubscription = (): Subscription => ({ unsubscribe: () => {} })

const watchImpl = (
  roots: readonly string[],
  markers: readonly string[],
  callback: TriggerCallback,
  debounceMs: number | undefined,
): WatchResult => {
  // Empty roots ⇒ NOOP subscription. The caller asked for nothing; we
  // honor that without erroring (composition-root convenience).
  if (roots.length === 0) return { ok: true, subscription: noopSubscription() }

  for (const root of roots) {
    const err = checkRoot(root)
    if (err !== null) return { ok: false, error: err }
  }

  const installed: FSWatcher[] = []
  const debouncer = createDebouncer(debounceMs ?? DEFAULT_DEBOUNCE_MS)
  let stopped = false
  const isStopped = () => stopped

  const dispatch = (abs: string): void => {
    if (stopped) return
    debouncer.schedule(abs, () => {
      if (stopped) return
      // Route the detached scan through a catch sink (audit L3 C-14): the
      // debouncer fires sync, so a throwing/rejecting `callback` inside the
      // async `scanAndEmit` would otherwise surface as an unhandled rejection
      // and crash the process. Swallow — one bad fire must not kill the watcher.
      void scanAndEmit(abs, markers, callback, isStopped).catch(() => {})
    })
  }

  for (const root of roots) {
    const r = installOne(root, dispatch)
    if (!r.ok) {
      teardown(installed, debouncer)
      const error: TriggerError = { kind: "watch-failed", root, detail: r.detail }
      return { ok: false, error }
    }
    installed.push(r.watcher)
  }

  const subscription: Subscription = {
    unsubscribe: () => {
      if (stopped) return
      stopped = true
      teardown(installed, debouncer)
    },
  }
  return { ok: true, subscription }
}
