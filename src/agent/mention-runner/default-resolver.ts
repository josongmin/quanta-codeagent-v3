/**
 * ADR-0422 — common default `MentionResolverPort` builder.
 *
 * DRY composition root shared by EVERY surface (the unified-agent
 * `apps/agent/assemble.ts` wire AND the CLI host-runtime wire). Reads the
 * `QUANTA_MENTION_*` env knobs (all default-ON; `=off` opts out per kind),
 * then assembles a {@link createCompositeMentionResolver} from whatever deps
 * the surface can supply:
 *
 *   - `@file`   — always available (workspace root = `cwd`); `QUANTA_MENTION_FILE`.
 *   - `@symbol` — available when an `lsp` and/or `semantic` SymbolLookup port
 *                 is injected (built by the surface via ADR-0422's
 *                 `createLspSymbolLookup` / `createSemanticSymbolLookup`);
 *                 `QUANTA_MENTION_SYMBOL`.
 *   - `@skill`  — available when a `SkillRegistryReadOnly` is injected;
 *                 `QUANTA_MENTION_SKILL`.
 *
 * GRACEFUL OMIT: a kind whose dep is absent (no symbol ports / no registry)
 * is simply NOT attached, so that kind resolves to `null` — byte-identical to
 * the legacy path, never a regression. A kind whose env knob is `=off` is also
 * skipped even if its dep is present.
 *
 * BYTE-IDENTICAL: with every knob `=off` (or every dep absent) the composite
 * exposes only the 3 legacy skill/plugin/app methods with no registry, so the
 * built resolver resolves every mention to `null` — the loop injects nothing.
 *
 * File caps: `QUANTA_MENTION_FILE_MAX_BYTES` / `QUANTA_MENTION_FILE_TAIL_RATIO`
 * map onto the file-resolver knobs; symbol strategy / timeout map onto the
 * symbol resolver via `QUANTA_MENTION_SYMBOL_RESOLVER` /
 * `QUANTA_MENTION_SYMBOL_TIMEOUT_MS`.
 */

import {
  createSymbolResolver,
  type MentionResolverPort,
  type SymbolLookupLspPort,
  type SymbolLookupSemanticPort,
  type SymbolResolverPriority,
} from "@/agent/mention-injection"
import {
  type CompositeResolverDeps,
  createCompositeMentionResolver,
  type FileResolverOptions,
  type SkillRegistryReadOnly,
} from "@/agent/plugin-app-resolver"
import { parseEnvFlag } from "@/shared"

/** Env subset the builder reads. A plain bag so callers can pass
 *  `process.env` OR a hermetic record (tests / non-Node hosts). */
export type MentionEnv = Readonly<Record<string, string | undefined>>

/** Options for {@link buildDefaultMentionResolver}. */
export interface BuildDefaultMentionResolverOptions {
  /** Workspace root for the `@file` resolver. */
  readonly cwd: string
  /** Env source (e.g. `process.env`). */
  readonly env: MentionEnv
  /** Read-only skill registry for `@skill`. Omit ⇒ `@skill` resolves null. */
  readonly skills?: SkillRegistryReadOnly
  /** LSP-backed `@symbol` lookup. Omit ⇒ LSP strategy disabled. */
  readonly lsp?: SymbolLookupLspPort
  /** Semantic-backed `@symbol` lookup. Omit ⇒ semantic strategy disabled. */
  readonly semantic?: SymbolLookupSemanticPort
}

/** A knob is ON unless explicitly disabled. Delegates to the canonical
 *  `parseEnvFlag` truth table so the falsey set (`0`/`false`/`off`/`no`) is
 *  shared with memory + all other default-ON knobs across the codebase — no
 *  more mention-only `!== "off"` asymmetry that audit found. */
const isOn = (env: MentionEnv, key: string): boolean => parseEnvFlag(env[key], /* defaultOn */ true)

const parsePositiveNumber = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const parseRatio = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined
}

const parsePriority = (raw: string | undefined): SymbolResolverPriority => {
  if (raw === "lsp" || raw === "semantic" || raw === "auto") return raw
  return "auto"
}

/** Build the `@file` deps slot when the knob is ON. */
const fileDeps = (opts: BuildDefaultMentionResolverOptions): FileResolverOptions | undefined => {
  if (!isOn(opts.env, "QUANTA_MENTION_FILE")) return undefined
  const maxBytes = parsePositiveNumber(opts.env.QUANTA_MENTION_FILE_MAX_BYTES)
  const tailRatio = parseRatio(opts.env.QUANTA_MENTION_FILE_TAIL_RATIO)
  return {
    root: opts.cwd,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(tailRatio !== undefined ? { tailRatio } : {}),
  }
}

/** Build the `@symbol` resolver fn when the knob is ON AND at least one
 *  lookup port is injected. No ports ⇒ undefined (graceful omit). */
const symbolDep = (
  opts: BuildDefaultMentionResolverOptions,
): CompositeResolverDeps["symbol"] | undefined => {
  if (!isOn(opts.env, "QUANTA_MENTION_SYMBOL")) return undefined
  if (opts.lsp === undefined && opts.semantic === undefined) return undefined
  const priority = parsePriority(opts.env.QUANTA_MENTION_SYMBOL_RESOLVER)
  const timeoutMs = parsePositiveNumber(opts.env.QUANTA_MENTION_SYMBOL_TIMEOUT_MS)
  return createSymbolResolver({
    ...(opts.lsp !== undefined ? { lsp: opts.lsp } : {}),
    ...(opts.semantic !== undefined ? { semantic: opts.semantic } : {}),
    priority,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
}

/** Build the `@skill` registry slot when the knob is ON AND a registry is
 *  injected. No registry ⇒ undefined (graceful omit). */
const skillDep = (opts: BuildDefaultMentionResolverOptions): SkillRegistryReadOnly | undefined => {
  if (!isOn(opts.env, "QUANTA_MENTION_SKILL")) return undefined
  return opts.skills
}

/**
 * Build the default composite {@link MentionResolverPort} for a surface.
 *
 * @param opts — cwd + env (+ optional skills registry / lsp / semantic ports).
 * @returns A composite resolver. With all knobs off / all deps absent the
 *          resolver answers `null` for every kind (byte-identical default-OFF).
 */
export const buildDefaultMentionResolver = (
  opts: BuildDefaultMentionResolverOptions,
): MentionResolverPort => {
  const files = fileDeps(opts)
  const symbol = symbolDep(opts)
  const skills = skillDep(opts)
  return createCompositeMentionResolver({
    ...(files !== undefined ? { files } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    ...(skills !== undefined ? { skills } : {}),
  })
}
