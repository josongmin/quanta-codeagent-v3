/**
 * `apps/cli/memory-compose.ts` — the CLI's long-term-memory composition
 * envelope: store / embedder / memory tuning block, plus the ADR-0555
 * credential-provenance projection the banner prints.
 *
 * Split out of `internal.ts` (god-module ceiling) — export NAMES and
 * SIGNATURES are unchanged and `internal.ts` re-exports them, so every
 * existing consumer (`buildTooling`, `env-knob-branches`, the delegation
 * hellgates) is unaffected. This module OWNS the `process.env` read for the
 * memory knobs; the surface-agnostic cores in `@/runner/assemble` read none.
 */

import type { AgentConfig } from "@/agent"
import {
  buildEmbedderCore,
  buildMemoryForSession,
  type buildStoreCore,
  resolveMemoryConfigFromEnv,
} from "@/runner/assemble"
import { type EmbedderProvenance, resolveEmbedderProvenance } from "@/runner/assemble/store"
import { getKnobOverride, isTruthyToken, logger } from "@/shared"
import { envFileSourceOf } from "@/shared/env-files"
import { readCliKnob } from "./cli-knobs-accessor"

/**
 * Build the long-term memory store from env (ADR-0413 default-ON, ADR-0557
 * durable-by-default). Unset / bare-truthy `QUANTA_MEMORY` (the CLI seeds `1`)
 * ⇒ the DURABLE `SqliteStore` at `~/.quanta/memory/memory.sqlite`; an existing
 * legacy `<cwd>/.quanta/memory.sqlite` is honored instead, once, with a
 * migration notice. `=memory` ⇒ the explicit VOLATILE `InMemoryStore`, gone at
 * process exit (ADR-0555 makes the banner + `/memory stats` say so);
 * `=off/0/false/no` ⇒ no store (legacy byte-identical escape hatch);
 * `QUANTA_MEMORY_PATH` overrides the file. The full `QUANTA_MEMORY_*` knob
 * table lives in ADR-0413 + `cli-knobs.ts`. Legacy shim — delegates to
 * `buildMemoryForSession` so the default-ON contract is centralized.
 *
 * NOTE — this docstring described the PRE-0557 contract (unset ⇒ volatile,
 * `=sqlite` the only durable opt-in) for two and a half weeks after the flip.
 * `tests/unit/memory/memory-doc-parity-hellgate.test.ts` now derives the claim
 * from the runtime resolver so the two cannot drift again silently.
 */
export const buildStore = (): ReturnType<typeof buildStoreCore> =>
  buildMemoryForSession(process.env).store

/** ADR-0555 — where the embedder's `OPENAI_API_KEY` / `OPENAI_BASE_URL` came
 *  from (dotenv file path per key, or absent for the real env). Paths only —
 *  never a value — so the banner can print it. */
export const memoryEmbedProvenance = (): EmbedderProvenance =>
  resolveEmbedderProvenance(envFileSourceOf)

/**
 * Build the semantic embedder from env. Enabled only when a `store` exists,
 * `QUANTA_MEMORY_EMBED` is not `off`, and `OPENAI_API_KEY` is set. ADR-0555:
 * a key that `loadEnvFiles` pulled from a repo's `.env*` arms egress ONLY with
 * an EXPLICIT `QUANTA_MEMORY_EMBED=1` (gateOn vocab; the knob's default-ON is
 * not consent) — the refusal is one attributed `logger.warn` naming the FILE.
 * A real-env key is byte-identical to before. `env` is injectable (DI seam).
 */
export const buildEmbedder = (
  store: ReturnType<typeof buildStoreCore>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReturnType<typeof buildEmbedderCore> =>
  buildEmbedderCore({
    store,
    // ADR-0503 P4: routed through the typed accessor (was gateDisabled). The
    // knob default is ON, so disabled = NOT readBool(raw, true) — byte-identical
    // to gateDisabled (both treat unset/empty/unrecognized as ON, falsy as off).
    disabled: !(readCliKnob("QUANTA_MEMORY_EMBED", "bool", env) ?? true),
    // Explicit opt-in = a truthy TOKEN from `/knobs set` or env — never the
    // accessor's default (which would read "true" for an unset knob).
    embedExplicitlyOn: isTruthyToken(
      getKnobOverride("QUANTA_MEMORY_EMBED") ?? env.QUANTA_MEMORY_EMBED,
    ),
    provenance: memoryEmbedProvenance(),
    onNotArmed: (line) => logger.warn(line),
    ...(env.OPENAI_API_KEY !== undefined ? { apiKey: env.OPENAI_API_KEY } : {}),
    ...(env.OPENAI_BASE_URL !== undefined ? { baseURL: env.OPENAI_BASE_URL } : {}),
    ...(env.QUANTA_MEMORY_EMBED_MODEL !== undefined
      ? { model: env.QUANTA_MEMORY_EMBED_MODEL }
      : {}),
  })

/**
 * Build the `memory` tuning block from env. ADR-0414 single-source-of-truth:
 * this is a THIN shim that delegates the env → config projection to the
 * factory's {@link resolveMemoryConfigFromEnv} — the SAME helper
 * `buildMemoryForSession` uses internally. The CLI no longer re-reads any
 * `QUANTA_MEMORY_*` tuning knob (recallLimit / distill / consolidate /
 * selfEdit / recallTiers); that truth lives in exactly one place.
 *
 * Contract (unchanged, now centralized):
 *   - `store === undefined` + no knobs ⇒ `undefined` (key omitted).
 *   - `store === undefined` + any sub-knob set ⇒ a block carrying that knob
 *     (the loop's `config.store` check is separate; the block is informational
 *     until a store is wired). This is the legacy escape-hatch symmetry: a
 *     caller that already opted out of the store can still surface a tuning
 *     block when an operator set a sub-knob.
 *   - `store` present ⇒ a truthy block (possibly empty) so the loop wires it.
 *
 * The `store` argument is forwarded verbatim to the factory helper, which
 * uses it ONLY to decide whether an empty block is still returned — never to
 * change a knob value. Byte-identical config bytes for the same env.
 */
export const buildMemoryConfig = (
  store: ReturnType<typeof buildStoreCore>,
): AgentConfig["memory"] | undefined => resolveMemoryConfigFromEnv(process.env, store)
