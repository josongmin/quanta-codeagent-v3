/**
 * ADR-0432 memory-extras — PURE env-projection helpers, side-effect-free.
 *
 * Split out from `memory-mode.ts` (which calls `registerKnob(...)` at module
 * level) so the env-read assembler path (`resolveMemoryConfigFromEnv`) can
 * reuse the SAME projection WITHOUT importing the registry side-effect. One
 * source of truth for the three-env → config projection; zero divergence
 * between the knob surface and the factory.
 */

export type MemoryThreadMode = "enabled" | "disabled" | "read-only"

/** The three resolved axes. Each is omitted when its env did not resolve. */
export interface MemoryModeValue {
  readonly threadMode?: MemoryThreadMode
  readonly lineCitations?: boolean
  readonly writeGuardMinRemainingPercent?: number
}

/** Parse `QUANTA_MEMORY_MODE` → closed literal, else `undefined`. */
export const parseMemoryThreadMode = (raw: string | undefined): MemoryThreadMode | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "enabled" || s === "disabled" || s === "read-only") return s
  return undefined
}

/** Parse `QUANTA_MEMORY_WRITE_GUARD_PCT` → integer in [0,100], else `undefined`. */
export const parseMemoryWriteGuardPct = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  // Strict: optional sign + digits only (rejects `5.0`, `5e1`, `0x5`, ` 5 5`).
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isInteger(n) || n < 0 || n > 100) return undefined
  return n
}

/** Parse `QUANTA_MEMORY_LINE_CITATIONS` → `true` iff exactly `"1"`, else `undefined`. */
export const parseMemoryLineCitations = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  return raw.trim() === "1" ? true : undefined
}

/** Project three env values → a `MemoryModeValue` (or `undefined` if none resolved). */
export const projectMemoryModeValue = (env: {
  mode: string | undefined
  guardPct: string | undefined
  lineCitations: string | undefined
}): MemoryModeValue | undefined => {
  const threadMode = parseMemoryThreadMode(env.mode)
  const writeGuardMinRemainingPercent = parseMemoryWriteGuardPct(env.guardPct)
  const lineCitations = parseMemoryLineCitations(env.lineCitations)
  if (
    threadMode === undefined &&
    writeGuardMinRemainingPercent === undefined &&
    lineCitations === undefined
  ) {
    return undefined
  }
  return {
    ...(threadMode !== undefined ? { threadMode } : {}),
    ...(lineCitations !== undefined ? { lineCitations } : {}),
    ...(writeGuardMinRemainingPercent !== undefined ? { writeGuardMinRemainingPercent } : {}),
  }
}
