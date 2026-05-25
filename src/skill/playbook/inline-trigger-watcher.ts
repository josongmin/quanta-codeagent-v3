/**
 * Inline-trigger watcher (ADR-0203) — Aider `// fix this AI!`-style dispatch.
 *
 * The spec called for `chokidar`, but `chokidar` is not installed in this
 * environment (verify-workflow memory: installs blocked). We use Node's
 * built-in `fs.watch({ recursive: true })`. The semantics are weaker than
 * chokidar (no debounce, may double-fire on atomic renames, glob is left
 * to us) but the seam is identical so the swap to chokidar later is a
 * one-line adapter-body change.
 *
 * Design constraints:
 *   - PURE Node — `node:fs.watch` + `node:fs/promises.readFile` only.
 *   - DEBOUNCED — coalesces fires for the same path within a configurable
 *     window (default 200ms). The default was picked because most editors
 *     do an atomic-write rename burst (.tmp → rename) on save, which fires
 *     `fs.watch` twice in rapid succession.
 *   - FAIL-CLOSED — a missing/non-dir root yields an `ok:false` start
 *     result; we never throw.
 *   - GLOB SUBSET — same fnmatch-style subset {@link matchesAnyGlob} uses
 *     for `paths:` activation. Heavy regex-style globs are intentionally
 *     OUT of scope (one less surface for authoring confusion).
 *
 * Slice discipline: leaf-level. Imports `node:fs`, `node:fs/promises`,
 * `node:path`, and our local `port.ts` types only. NO `@/agent`, `@/tool`,
 * `@/storage`, `@/permission`.
 */

import { existsSync, type FSWatcher, statSync, watch } from "node:fs"
import { readFile } from "node:fs/promises"
import { isAbsolute, resolve as resolvePath } from "node:path"
import type {
  InlineTriggerCallback,
  InlineTriggerFire,
  InlineTriggerWatcherHandle,
  InlineTriggerWatcherPort,
  InlineTriggerWatchSpec,
} from "./port"

const DEFAULT_DEBOUNCE_MS = 200

/**
 * Default file-system adapter — uses `node:fs.watch`. Test rigs substitute
 * an in-memory port via {@link createMemoryWatcher}.
 */
/** Validate `spec.root` resolves to an actual directory, fail-closed otherwise. */
const validateRoot = (
  root: string,
): { ok: true } | { ok: false; reason: "root-not-found" | "root-not-dir" | "io-error" } => {
  if (!existsSync(root)) return { ok: false, reason: "root-not-found" }
  try {
    if (!statSync(root).isDirectory()) return { ok: false, reason: "root-not-dir" }
  } catch {
    return { ok: false, reason: "io-error" }
  }
  return { ok: true }
}

/** Build the debounced fs.watch handler. Extracted to keep `start` simple. */
const buildFsHandler = (
  spec: InlineTriggerWatchSpec,
  lastFire: Map<string, number>,
  isStopped: () => boolean,
): ((ev: string, filename: string | Buffer | null) => void) => {
  const debounceMs = spec.debounceMs ?? DEFAULT_DEBOUNCE_MS
  return (_ev, filename) => {
    if (isStopped()) return
    if (filename === null) return
    const rel = typeof filename === "string" ? filename : filename.toString("utf8")
    if (!matchesGlobSubset(rel, spec.trigger.watchGlob)) return
    const abs = isAbsolute(rel) ? rel : resolvePath(spec.root, rel)
    const now = Date.now()
    const prev = lastFire.get(abs) ?? 0
    if (now - prev < debounceMs) return
    lastFire.set(abs, now)
    void scanAndMaybeFire(abs, spec.trigger.commentMarker, spec.onFire, now)
  }
}

export const createInlineTriggerWatcher = (): InlineTriggerWatcherPort => ({
  start: (spec) => {
    const rootCheck = validateRoot(spec.root)
    if (!rootCheck.ok) return { ok: false, reason: rootCheck.reason }

    let watcher: FSWatcher
    try {
      watcher = watch(spec.root, { recursive: true })
    } catch {
      return { ok: false, reason: "io-error" }
    }

    const lastFire = new Map<string, number>()
    let stopped = false
    const handler = buildFsHandler(spec, lastFire, () => stopped)
    watcher.on("change", handler)
    watcher.on("rename", handler)
    watcher.on("error", () => {
      /* swallow — caller stops via .stop() */
    })

    const handle: InlineTriggerWatcherHandle = {
      stop: () => {
        if (stopped) return
        stopped = true
        try {
          watcher.close()
        } catch {
          /* idempotent */
        }
        lastFire.clear()
      },
      isStopped: () => stopped,
    }
    return { ok: true, handle }
  },
})

/**
 * In-memory port for tests + headless CI rigs. The returned `fire()` helper
 * lets tests inject "as if the watcher saw a save" without touching disk.
 */
export interface MemoryWatcher extends InlineTriggerWatcherPort {
  /** Simulate a saved file. Returns true if any spec consumed it. */
  readonly fire: (path: string, contents: string) => boolean
  /** Number of active (non-stopped) watch handles. */
  readonly active: () => number
}

interface MemorySub {
  readonly spec: InlineTriggerWatchSpec
  readonly handle: InlineTriggerWatcherHandle
  stopped: boolean
  lastFire: Map<string, number>
}

/** Single-sub fire decision. Returns true iff this sub consumed the event. */
const tryFireOne = (sub: MemorySub, path: string, contents: string, t: number): boolean => {
  if (sub.stopped) return false
  if (!matchesGlobSubset(path, sub.spec.trigger.watchGlob)) return false
  const debounceMs = sub.spec.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const prev = sub.lastFire.get(path) ?? 0
  if (t - prev < debounceMs) return false
  const found = findMarkerLine(contents, sub.spec.trigger.commentMarker)
  if (found === -1) return false
  sub.lastFire.set(path, t)
  const fire: InlineTriggerFire = {
    path,
    marker: sub.spec.trigger.commentMarker,
    line: found,
    firedAt: t,
  }
  sub.spec.onFire(fire)
  return true
}

export const createMemoryWatcher = (now: () => number = Date.now): MemoryWatcher => {
  const subs: MemorySub[] = []
  return {
    start: (spec) => {
      const sub: MemorySub = {
        spec,
        stopped: false,
        lastFire: new Map(),
        handle: {
          stop: () => {
            sub.stopped = true
          },
          isStopped: () => sub.stopped,
        },
      }
      subs.push(sub)
      return { ok: true, handle: sub.handle }
    },
    fire: (path, contents) => {
      const t = now()
      let consumed = false
      for (const sub of subs) {
        if (tryFireOne(sub, path, contents, t)) consumed = true
      }
      return consumed
    },
    active: () => subs.filter((s) => !s.stopped).length,
  }
}

/**
 * Read the file and dispatch ONE fire if the marker is present. Failures
 * (ENOENT during the read window, permission, binary file) are silently
 * dropped — the watcher continues to receive further events.
 */
const scanAndMaybeFire = async (
  path: string,
  marker: string,
  onFire: InlineTriggerCallback,
  firedAt: number,
): Promise<void> => {
  let body: string
  try {
    body = await readFile(path, "utf8")
  } catch {
    return
  }
  const line = findMarkerLine(body, marker)
  if (line === -1) return
  onFire({ path, marker, line, firedAt })
}

/** 1-based line number of the first occurrence of `marker`, or -1. */
export const findMarkerLine = (body: string, marker: string): number => {
  if (marker === "") return -1
  const idx = body.indexOf(marker)
  if (idx === -1) return -1
  let line = 1
  for (let i = 0; i < idx; i++) {
    if (body[i] === "\n") line++
  }
  return line
}

/**
 * Tiny fnmatch-style glob matcher. Supports `*`, `?`, and `{a,b,c}` brace
 * alternation. Path separator is `/`. `*` does NOT cross `/`; use `**` to
 * cross. Same subset {@link matchesAnyGlob} uses for `paths:` activation;
 * keeping this matcher LOCAL (rather than importing `activation.ts`) so the
 * slice does not depend on the activation module's evolution.
 */
export const matchesGlobSubset = (path: string, glob: string): boolean => {
  const expanded = expandBraces(glob)
  for (const g of expanded) {
    if (matchOne(path, g)) return true
  }
  return false
}

const expandBraces = (glob: string): string[] => {
  const m = glob.match(/^(.*?)\{([^{}]+)\}(.*)$/)
  if (m === null) return [glob]
  const [, pre, body, post] = m
  const parts = (body ?? "").split(",")
  const out: string[] = []
  for (const p of parts) {
    for (const tail of expandBraces(`${pre ?? ""}${p}${post ?? ""}`)) {
      out.push(tail)
    }
  }
  return out
}

const matchOne = (path: string, glob: string): boolean => {
  // Translate glob to a RegExp. `**` matches anything (including `/`);
  // `*` matches anything except `/`; `?` matches one char except `/`.
  let re = "^"
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"
        i += 2
        if (glob[i] === "/") i++
      } else {
        re += "[^/]*"
        i++
      }
      continue
    }
    if (c === "?") {
      re += "[^/]"
      i++
      continue
    }
    if (c !== undefined && /[\\^$.|+()[\]]/.test(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
    i++
  }
  re += "$"
  return new RegExp(re).test(path)
}
