/**
 * UX flash duration constants for the REPL status bar.
 *
 * **Why these values?** They are *cosmetic UX flash durations* (not behavioral
 * thresholds) with existing-precedent defaults preserved from the pre-extraction
 * monolith. All are env-overrideable per the user's "no-heuristics" stance —
 * env override always wins, defaults match prior behavior byte-identically.
 *
 * Source of defaults (verbatim from `src/apps/cli/repl.ts` pre-cleanup):
 *   - `errorMs = 4000`   — error toast linger
 *   - `idleMs = 3000`    — idle warning linger
 *   - `escWindowMs = 2000` — second-Esc gesture window
 *   - `transientMs = 1500` — generic cancel/exit toast linger
 *   - `truncateChars = 120` — status-bar copy cap (chars not ms)
 *
 * All knobs follow the same parse contract: positive finite integer required;
 * empty / unset / non-numeric / non-positive / NaN ⇒ default. Decimals are
 * floored. The bias is "an obviously-bad env value must NEVER cripple the
 * surface" — fallback to the byte-identical pre-cleanup default.
 */
export interface StatusFlashConfig {
  /** `QUANTA_FLASH_ERROR_MS` — error toast linger (default: 4000). */
  readonly errorMs: number
  /** `QUANTA_FLASH_IDLE_MS` — idle warning linger (default: 3000). */
  readonly idleMs: number
  /** `QUANTA_ESC_WINDOW_MS` — second-Esc gesture window (default: 2000). */
  readonly escWindowMs: number
  /** `QUANTA_FLASH_TRANSIENT_MS` — generic transient toast linger (default: 1500). */
  readonly transientMs: number
  /** `QUANTA_FLASH_TRUNCATE_CHARS` — status-bar copy cap in chars (default: 120). */
  readonly truncateChars: number
}

const DEFAULTS = {
  QUANTA_FLASH_ERROR_MS: 4000,
  QUANTA_FLASH_IDLE_MS: 3000,
  QUANTA_ESC_WINDOW_MS: 2000,
  QUANTA_FLASH_TRANSIENT_MS: 1500,
  QUANTA_FLASH_TRUNCATE_CHARS: 120,
} as const

const parsePositive = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  if (n <= 0) return fallback
  return Math.floor(n)
}

/**
 * Build a {@link StatusFlashConfig} from the given env (defaults: `process.env`).
 *
 * Pure function — no side effects; safe to call multiple times. Each field is
 * resolved independently so overriding one does NOT perturb the others (every
 * unset/empty/invalid value falls back to its byte-identical pre-cleanup
 * default).
 */
export const buildStatusFlashConfig = (
  env: NodeJS.ProcessEnv = process.env,
): StatusFlashConfig => ({
  errorMs: parsePositive(env.QUANTA_FLASH_ERROR_MS, DEFAULTS.QUANTA_FLASH_ERROR_MS),
  idleMs: parsePositive(env.QUANTA_FLASH_IDLE_MS, DEFAULTS.QUANTA_FLASH_IDLE_MS),
  escWindowMs: parsePositive(env.QUANTA_ESC_WINDOW_MS, DEFAULTS.QUANTA_ESC_WINDOW_MS),
  transientMs: parsePositive(env.QUANTA_FLASH_TRANSIENT_MS, DEFAULTS.QUANTA_FLASH_TRANSIENT_MS),
  truncateChars: parsePositive(
    env.QUANTA_FLASH_TRUNCATE_CHARS,
    DEFAULTS.QUANTA_FLASH_TRUNCATE_CHARS,
  ),
})
