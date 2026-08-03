/**
 * CLI AI-session-title composition delegate (RFC jun-6-ai-session-title).
 *
 * god-code split of `apps/cli/internal.ts` (fix-on-sight per AGENTS.md SE size
 * metric — internal.ts crossed the 1000-line god-MODULE ceiling): the
 * fire-and-forget AI titler assembly + its placeholder predicate move here
 * VERBATIM. `internal.ts` re-exports `buildAutoTitlePort` so every existing
 * importer (repl.ts, the reachability hellgate) keeps resolving it from
 * `./internal` unchanged (byte-identical surface; structural move only).
 */

import type { LLMPort } from "@/llm"
import { buildSummarizerLlmCore, type Provider as RunnerProvider } from "@/runner/assemble"
import { type AutoTitlePort, createAutoTitlePort } from "@/runner/session-ops/auto-title"
import { loadSessionById, renameSession } from "@/session"
import { runtimeConfig } from "@/shared"

/** Provider union — same alias the CLI internal barrel uses (`@/runner/assemble`
 *  factory type), so the moved `buildAutoTitlePort` signature stays identical. */
type Provider = RunnerProvider

/** jun-6 (RFC jun-6-ai-session-title) — TRUE iff a title is still the
 *  auto/placeholder value (safe to overwrite). A fresh id-mode session is
 *  seeded with `defaultUntitled(now)` (`"Untitled YYYY-MM-DD HH:mm"`); an empty
 *  title is also a placeholder. Anything else ⇒ a human (or a prior auto-title)
 *  named it ⇒ the titler MUST yield (don't-clobber). Mirrors the leaf's
 *  injected-predicate contract so the leaf never encodes the seeded-title shape. */
const isAutoTitlePlaceholder = (title: string): boolean =>
  title === "" || title.startsWith("Untitled")

/** jun-6 (RFC jun-6-ai-session-title) — build the fire-and-forget AI session
 *  titler at the CLI composition root, MIRRORING the `QUANTA_COMPACT_MODEL`
 *  second-LLM construction (`buildSummarizerLlm`): a CHEAP `LLMPort` is built
 *  synchronously from `QUANTA_SESSION_TITLE_MODEL` and injected into
 *  `createAutoTitlePort` alongside the real `renameSession` writer +
 *  `loadSessionById` title-reader + placeholder predicate + clock.
 *
 *  DEFAULT-OFF BYTE-IDENTITY (RFC §1.2): returns `undefined` unless
 *  `runtimeConfig().sessionAutoTitle` is on AND `sessionTitleModel` resolves a
 *  cheap port. Absent ⇒ no `AgentConfig.autoTitlePort` ⇒ the loop's first-turn
 *  title branch is dead ⇒ no extra LLM call, no title write (byte-identical).
 *  The cheap port NEVER falls back to the expensive main model — an armed
 *  `sessionAutoTitle` with no `sessionTitleModel` stays inert (the cost gate).
 *
 *  `seamLlm` is a TEST seam (mirrors `buildSummarizerLlm`/`buildLLM` DI): a
 *  reachability test injects a fake cheap LLM so the titler runs without a real
 *  provider key. Production omits it ⇒ the cheap port is built from env via the
 *  proven `buildSummarizerLlmCore` (retry-wrapped, same as the main stack). */
export const buildAutoTitlePort = (
  mainProvider: Provider,
  signal: AbortSignal,
  seamLlm?: LLMPort,
): AutoTitlePort | undefined => {
  const cfg = runtimeConfig()
  if (!cfg.sessionAutoTitle) return undefined
  const llm =
    seamLlm ??
    buildSummarizerLlmCore({
      mainProvider,
      signal,
      model: cfg.sessionTitleModel,
      env: process.env,
    })
  // No cheap model ⇒ inert (NEVER the expensive main model). Both the knob AND
  // the model must be present (advertise-iff-able), exactly like the compaction
  // summarizer's `QUANTA_COMPACT_MODEL` gate.
  if (llm === undefined) return undefined
  return createAutoTitlePort({
    llm,
    rename: (id, title) => renameSession(id, title),
    currentTitle: async (id) => (await loadSessionById(id))?.meta.title,
    isPlaceholder: isAutoTitlePlaceholder,
    clock: () => Date.now(),
  })
}
