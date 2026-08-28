/**
 * MR-01 — ONE authority for "which provider + which model does this session
 * boot on, and did the operator PIN it?".
 *
 * ── The drift this closes ────────────────────────────────────────────────────
 * FIVE composition roots each answered that question differently, and
 * `QUANTA_MODEL` meant four different things depending on which binary you ran:
 *
 *   | root                                    | `--model` | `QUANTA_MODEL`   | pin flag |
 *   | --------------------------------------- | --------- | ---------------- | -------- |
 *   | `apps/cli/repl/session-runtime-config`   | (via env) | boot model + pin | yes      |
 *   | `host/runtime/agent-arg-builder`         | honored   | IGNORED          | no       |
 *   | `apps/web-daemon/runtime-factory`        | n/a       | IGNORED          | no       |
 *   | `apps/cli/serve-stdio-cmd`               | honored   | IGNORED          | no       |
 *   | `apps/bench/run-main`                    | honored   | honored          | no       |
 *
 * So `QUANTA_MODEL=gpt-5.4 quanta web` (and `quanta -p …`, and
 * `quanta serve --stdio`) silently booted the provider DEFAULT while the very
 * same variable was authoritative in the interactive REPL and in bench.
 *
 * ── The contract (fixed decision — do NOT redesign per-root) ─────────────────
 *   1. MODEL PRECEDENCE: `modelArg` (the surface's `--model` flag) beats
 *      `QUANTA_MODEL`, which beats the provider's canonical
 *      {@link DEFAULT_MODEL} entry. No local slug tables anywhere.
 *   2. `pinned` is TRUE whenever the model came from the flag OR from
 *      `QUANTA_MODEL` — both mean "the operator named a model for THIS
 *      invocation". It is FALSE only for the provider default. Downstream this
 *      is what lets a session skip a PERSISTED `/model` pick (a `QUANTA_MODEL=x`
 *      cron/CI/git-hook run must not inherit whatever a human last chose
 *      interactively). This module only PRODUCES the flag; consumers own the
 *      skip.
 *   3. An explicit `providerArg` (a surface `--provider`) WINS over env /
 *      OAuth-home probing. It is seeded into the env view `pickProvider` reads,
 *      so an UNKNOWN provider name still falls through to the probe exactly as
 *      it did before (registry-validated, no new failure mode).
 *   4. EMPTY / whitespace-only `QUANTA_MODEL` or `modelArg` counts as UNSET.
 *      This repo's gate vocabulary treats `""` as not-an-opt-in, and the CLI's
 *      previous `process.env[k] ?? fallback` read let `QUANTA_MODEL=` boot a
 *      port with a LITERAL EMPTY model id.
 *
 * ── What this module deliberately does NOT do ────────────────────────────────
 * It builds no port. Key lookup, adapter construction and the null-on-missing-key
 * policy stay in `./factory` (`createLLM` / `tryCreateLLM`); each root keeps its
 * own "no key" message + exit contract.
 */

import { DEFAULT_MODEL, type EnvLike, type Provider, pickProvider } from "./factory"

/** Where the boot model id came from. `"flag"` = the surface's `--model`,
 *  `"env"` = `QUANTA_MODEL`, `"default"` = {@link DEFAULT_MODEL}[provider]. */
export type BootModelSource = "flag" | "env" | "default"

/** Inputs to {@link resolveBootSelection}. Surfaces map their own argv/env/IPC
 *  shape onto this once; no `process.env` / `process.argv` read happens here. */
export interface BootSelectionInput {
  /** The env view the provider probe + `QUANTA_MODEL` are read from. A root
   *  that already seeded `QUANTA_PROVIDER` may pass that seeded view; passing
   *  {@link BootSelectionInput.providerArg} instead is equivalent. */
  readonly env: EnvLike
  /** An explicit `--provider` flag. Empty / whitespace-only ⇒ treated as unset. */
  readonly providerArg?: string
  /** An explicit `--model` flag. Empty / whitespace-only ⇒ treated as unset. */
  readonly modelArg?: string
}

/** The single boot answer every composition root now shares. */
export interface BootSelection {
  /** The provider whose adapter the root should build. */
  readonly provider: Provider
  /** The model id to boot on — never empty, never whitespace. */
  readonly modelId: string
  /** True when the operator named the model for THIS invocation (flag OR
   *  `QUANTA_MODEL`); false only for the provider default. */
  readonly pinned: boolean
  /** Provenance of {@link BootSelection.modelId} — for logs / status lines. */
  readonly source: BootModelSource
}

/** `""` / `"   "` ⇒ `undefined`; otherwise the TRIMMED value. Mirrors the
 *  `.trim()` discipline `pickProvider` already applies to `QUANTA_PROVIDER`, so
 *  a `.env` line with a trailing space cannot mint a bogus model id. */
const meaningful = (raw: string | undefined): string | undefined => {
  const t = raw?.trim()
  return t !== undefined && t.length > 0 ? t : undefined
}

/**
 * Resolve the boot provider + model + pin for ONE invocation. See the module
 * header for the full contract; the short version is
 * `--model` > `QUANTA_MODEL` > `DEFAULT_MODEL[provider]`, with `pinned` true
 * for the first two.
 */
export const resolveBootSelection = (input: BootSelectionInput): BootSelection => {
  const providerArg = meaningful(input.providerArg)
  // Seed rather than branch: `pickProvider` already validates a provider name
  // against the registry (`in DEFAULT_MODEL`) and falls through to the probe on
  // a miss. Re-implementing that check here would be a SECOND validity table.
  const env: EnvLike =
    providerArg !== undefined ? { ...input.env, QUANTA_PROVIDER: providerArg } : input.env
  const provider = pickProvider(env)

  const flagModel = meaningful(input.modelArg)
  if (flagModel !== undefined) {
    return { provider, modelId: flagModel, pinned: true, source: "flag" }
  }
  const envModel = meaningful(env.QUANTA_MODEL)
  if (envModel !== undefined) {
    return { provider, modelId: envModel, pinned: true, source: "env" }
  }
  return { provider, modelId: DEFAULT_MODEL[provider], pinned: false, source: "default" }
}
