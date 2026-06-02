/**
 * RFC-11 / ADR-0447 — `~/.quanta/keybindings.json` loader + merge.
 *
 * Reuses the EXACT fail-safe shape of the knobs config loader
 * (`src/runner/knobs/persist.ts` read + `resolve.ts` prototype-pollution
 * guard): read failure / parse failure / wrong version ⇒ the default map (no
 * throw), and `__proto__`/`prototype`/`constructor` keys are declined.
 *
 * File schema v1:
 *   { "version": 1, "bindings": { "<keyspec>": "<action>", ... } }
 *
 * Bad entries are dropped individually with a Codex-style warning
 * (`invalid keybinding`, `unknown action`, `duplicate modifier`) — the rest of
 * the file + the default map survive. `loadKeybindings` NEVER throws; it always
 * returns a usable `map`.
 *
 * Slice posture: imports only `node:fs/promises`, `node:os`, `node:path` and
 * the sibling pure modules. No `@/...`.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { DEFAULT_KEYBINDINGS } from "./defaults"
import { normalizeKeySpec } from "./normalize"
import { ACTION_SET, type KeyAction, type KeybindingMap, type KeySpec } from "./types"

/** Same prototype-pollution boundary as `knobs/resolve.ts:34`. */
const PROTO_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"])

export const DEFAULT_KEYBINDINGS_PATH = join(homedir(), ".quanta", "keybindings.json")

export interface LoadResult {
  /** Always usable: the default map merged with any valid file overrides. */
  readonly map: KeybindingMap
  /** Per-entry rejection reasons + structural fallbacks (for stderr). Empty
   *  when the file is absent or fully valid. */
  readonly warnings: readonly string[]
}

/** Outcome of validating one `[rawKey, rawAction]` entry: either a usable
 *  `(spec, action)` pair or a single rejection warning string. */
type EntryResult =
  | { readonly spec: KeySpec; readonly action: KeyAction }
  | { readonly warn: string }

/** Validate ONE config entry against the closed action enum + key grammar.
 *  Pure; the caller folds the result + dedups. Extracted to keep
 *  `mergeOverDefaults` under the cognitive-complexity cap. */
const validateEntry = (rawKey: string, rawAction: unknown): EntryResult => {
  const norm = normalizeKeySpec(rawKey)
  if ("error" in norm) {
    return {
      warn:
        norm.error === "duplicate"
          ? `duplicate modifier in keybinding \`${rawKey}\``
          : `invalid keybinding \`${rawKey}\``,
    }
  }
  if (typeof rawAction !== "string") {
    return { warn: `missing action for keybinding \`${rawKey}\`` }
  }
  if (!ACTION_SET.has(rawAction)) {
    return { warn: `unknown action \`${rawAction}\` for keybinding \`${rawKey}\`` }
  }
  return { spec: norm.spec, action: rawAction as KeyAction }
}

/** Pure merge of a parsed JSON value over the default map. Exposed for unit
 *  tests; `loadKeybindings` is the impure (fs) wrapper. */
export const mergeOverDefaults = (parsed: unknown): LoadResult => {
  if (typeof parsed !== "object" || parsed === null) {
    return {
      map: DEFAULT_KEYBINDINGS,
      warnings: ["keybindings.json: not an object — using defaults"],
    }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 1) {
    return {
      map: DEFAULT_KEYBINDINGS,
      warnings: ["keybindings.json: unknown version — using defaults"],
    }
  }
  const bindings = obj.bindings
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) {
    return { map: DEFAULT_KEYBINDINGS, warnings: [] }
  }
  const warnings: string[] = []
  const merged = new Map<KeySpec, KeyAction>(DEFAULT_KEYBINDINGS)
  const seen = new Set<KeySpec>()
  for (const [rawKey, rawAction] of Object.entries(bindings as Record<string, unknown>)) {
    if (PROTO_KEYS.has(rawKey)) continue // decline prototype-pollution keys silently
    const result = validateEntry(rawKey, rawAction)
    if ("warn" in result) {
      warnings.push(result.warn)
      continue
    }
    if (seen.has(result.spec)) {
      warnings.push(`duplicate keybinding \`${rawKey}\``)
      continue
    }
    seen.add(result.spec)
    merged.set(result.spec, result.action)
  }
  return { map: merged, warnings }
}

/** Load + merge `~/.quanta/keybindings.json`. No-throw: any read/parse defect
 *  degrades to the default map + a warning. */
export const loadKeybindings = async (
  path: string = DEFAULT_KEYBINDINGS_PATH,
): Promise<LoadResult> => {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    // Absent / unreadable file ⇒ defaults, no warning (the common case).
    return { map: DEFAULT_KEYBINDINGS, warnings: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      map: DEFAULT_KEYBINDINGS,
      warnings: ["keybindings.json: invalid JSON — using defaults"],
    }
  }
  return mergeOverDefaults(parsed)
}
