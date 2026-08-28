/**
 * MR-01 + MR-E5 — the HEADLESS composition root's BOOT PORT.
 *
 * ONE cohesive answer to "what does `buildBaseFromArgs` boot on, and through
 * what port?": the provider/model resolution (delegated to the `@/llm`
 * `resolveBootSelection` authority the other four roots share), the adapter
 * construction, the typed missing-key failure, and the always-on wrapper stack.
 *
 * Split out of the `agent-arg-builder.ts` keystone (god-MODULE approaching-cohort
 * ratchet). The keystone keeps a ONE-LINE call and re-exports
 * {@link ProviderKeyMissingError} so no consumer's import path moves.
 */

import { type LLMPort, type Provider, resolveBootSelection, tryCreateLLM } from "@/llm"
import { decorateSwappableModelPort } from "@/runner/assemble"

/** ADR-0303 — thrown by `buildBaseFromArgs` when no API key resolves for the
 *  selected provider. The host launcher composition layer must NOT own
 *  `process.exit` (terminal-defaults invariant); it throws this typed error and
 *  the surface entry maps `exitCode` onto its own exit. `exitCode = 2` preserves
 *  the prior POSIX behavior (missing-credentials). */
export class ProviderKeyMissingError extends Error {
  readonly exitCode = 2
  constructor(message: string) {
    super(message)
    this.name = "ProviderKeyMissingError"
  }
}

/** What the keystone hands in: the env view it already seeded with an explicit
 *  `--provider`, the partial carrying `--provider` / `--model`, and the
 *  composition root's real cancellation signal (absent for callers that build a
 *  base without a root — the retry decorator then self-manages). */
export interface HeadlessBootPortInput {
  readonly env: Record<string, string | undefined>
  readonly p: { readonly provider?: string; readonly model?: string }
  readonly signal: AbortSignal | undefined
}

/**
 * Resolve the boot provider + model and build the DECORATED port.
 *
 * MR-01 — provider + model come from the ONE authority (`resolveBootSelection`):
 * `--model` > `QUANTA_MODEL` > canonical `DEFAULT_MODEL[provider]`. INTENDED
 * BEHAVIOUR CHANGE: this root previously never read `QUANTA_MODEL`, so
 * `QUANTA_MODEL=x quanta -p "…"` booted the provider default while the very same
 * variable was authoritative in the interactive REPL and in bench. It is honored
 * here now.
 *
 * MR-E5 — the boot port carries the same always-on safety net a SWAPPED model
 * already had on this very root (`model-switch-wire.ts` decorates every
 * candidate port). Without this the irony was exact: the model you switched TO
 * kept bounded retry / the empty-stream circuit breaker / the progress
 * heartbeat, while the DEFAULT model ran BARE — a transient 429 was a hard turn
 * failure on `quanta -p` and on every bench/batch row (`mode-presets/batch.ts`
 * runs each instance on `req.base.llm`).
 *
 * `decorateSwappableModelPort` — not `composeLLMCore` — is the right wrapper
 * here: `composeLLMCore` additionally wires `FallbackLLM` + `withLiveUsage`,
 * which need fallback model ids and a TTY notion this host-layer root has
 * neither of. Port identity is preserved through the wrapper
 * (`forwardPortIdentity`), so `model` / `provider` / `contextWindowKey` /
 * `listModels` still forward to every downstream slot.
 */
export const buildHeadlessBootPort = (
  input: HeadlessBootPortInput,
): { provider: Provider; llm: LLMPort } => {
  const boot = resolveBootSelection({
    env: input.env,
    ...(input.p.provider !== undefined ? { providerArg: input.p.provider } : {}),
    ...(input.p.model !== undefined ? { modelArg: input.p.model } : {}),
  })
  const bare = tryCreateLLM(boot.provider, { model: boot.modelId }, input.env)
  if (bare === null) {
    throw new ProviderKeyMissingError(
      `no API key for provider '${boot.provider}'. Set OPENAI_API_KEY or ANTHROPIC_API_KEY (or --provider <other>).`,
    )
  }
  return {
    provider: boot.provider,
    llm: decorateSwappableModelPort({
      inner: bare,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }),
  }
}
