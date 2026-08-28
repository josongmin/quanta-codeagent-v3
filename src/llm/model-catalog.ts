/**
 * Model-catalog wire (aug-27, hardened aug-28) — a surface's LIVE set of
 * switchable models, WITH a built `LLMPort` for each.
 *
 * Lives in `@/llm` (not in a surface) because BOTH composition roots need it: the
 * CLI's `/model` picker and the web daemon's `set_model` control request. The
 * biome slice fence forbids `@/apps/web-daemon` from importing `@/apps/cli`, so a
 * CLI-local copy would have forced the web surface to re-implement it — and a
 * second implementation of "which models can this session switch to" is exactly
 * how the two surfaces drift.
 *
 * WHY this exists (the defects it closes):
 *   1. the interactive CLI never wired `AgentConfig.modelCandidates`, so the
 *      loop's per-turn model swap (`skill-gate#resolveSkillTurnOverride`, which
 *      resolves an id to a PORT out of that list) could never find a port — a
 *      sticky-model / skill `model:` pick was a SILENT no-op on this surface;
 *   2. the only candidate source was `QUANTA_RETRY_MODELS` (unset by default),
 *      so `/model`'s candidate list held just the boot model and `pickModel`
 *      rejected every other id as unknown — the picker could not pick;
 *   3. a hand-maintained slug list would drift (`MODEL_CONTEXT_WINDOWS` has no
 *      `gpt-5.6-terra` entry while that IS the live default), so the catalog is
 *      probed from the provider instead (`LLMPort.listModels`, the same
 *      `/codex/models` truth Codex itself uses).
 *
 * THREE INVARIANTS an adversarial audit forced (aug-28):
 *
 * A. THE BOOT MODEL GETS NO CANDIDATE PORT. `ids()` lists it (the picker must be
 *    able to name and re-select it), but it is absent from `candidates`, so
 *    picking it makes the loop's `resolvePort` MISS and fall through to
 *    `config.llm` — the real, fully-decorated session port. Minting a second port
 *    for the boot model would have swapped the turn onto a differently-wrapped
 *    object for a no-op pick.
 *
 * B. EVERY OTHER PORT IS BUILT BY THE COMPOSITION ROOT ({@link buildPort}), not
 *    here. The wire has no way to know the surface's credential/endpoint/decorator
 *    context: re-deriving `tryCreateLLM(provider, {model}, env)` dropped bounded
 *    retry, the empty-stream breaker, the progress heartbeat, `betaHeaders`, and —
 *    on a `QUANTA_LLM_ENDPOINT` session — the operator's configured baseURL, its
 *    guarded fetch and its endpoint-scoped key, silently egressing the
 *    conversation to the public vendor endpoint instead. The default builder is
 *    kept ONLY for hosts/tests that have no composer.
 *
 * C. IDS ARE UNTRUSTED. They come from a provider response or from
 *    `~/.quanta/sticky-model.json` (any local process can write it), and they end
 *    up in a rendered list, in the daemon's `set_model` allowlist, and in an HTTP
 *    request path. So: a charset/length predicate gates admission, the probe is
 *    capped, and dedup is a Set (an unbounded hostile catalog blocked the event
 *    loop for ~67s at 100k slugs with the old `array.some` dedup).
 *
 * FAIL-OPEN by contract: no `listModels`, a rejected probe, an unbuildable id, or
 * an implausible slug all leave the seeded set standing. `/model` then lists what
 * it has; it never errors the session because a catalog lookup failed. Every drop
 * is LOGGED (a silently short menu reads as "my account has one model").
 */

import { errMessage, logger } from "@/shared"
import { type Provider, tryCreateLLM } from "./factory"
import type { ModelCandidate } from "./model-swap"
import type { LLMPort } from "./ports"

/** Hard cap on ids taken from ONE probe. Two orders of magnitude above any real
 *  catalog (the biggest observed is ~10), and it bounds both the port-building
 *  loop and the retained adapter objects when the endpoint is hostile or buggy. */
export const MAX_PROBED_MODEL_IDS = 200

/** Upper bound on a model id. Provider slugs are short (`gpt-5.6-terra`,
 *  `claude-haiku-4-5-20251001`); anything longer is not a slug we can render in a
 *  list or put in a request path. */
export const MAX_MODEL_ID_LENGTH = 120

/**
 * Is `id` plausibly a provider model slug?
 *
 * Deliberately a CHARSET allowlist, not a denylist: the ids reach a terminal
 * (`/model`'s list, the CLI welcome banner), an HTTP request path, and a JSON file
 * shared between surfaces. Letters/digits/`.`/`-`/`_`/`:`/`/` cover every real
 * provider slug (`gpt-4o`, `claude-3-5-sonnet-20241022`, `anthropic/claude-x`,
 * `us.anthropic.claude:1`) while rejecting whitespace, control characters, ANSI
 * escapes, path traversal (`..` is rejected by the `.` run check), and RTL
 * overrides. Pure + total.
 */
export const isPlausibleModelSlug = (id: string): boolean =>
  id.length > 0 &&
  id.length <= MAX_MODEL_ID_LENGTH &&
  /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id) &&
  !id.includes("..")

export interface ModelCatalogWire {
  /** The live candidate array — shared BY REFERENCE with
   *  `AgentConfig.modelCandidates`. Grows in place on {@link refresh}.
   *  EXCLUDES the boot model (invariant A). */
  readonly candidates: readonly ModelCandidate[]
  /** Every id the surface may OFFER: the boot model first, then each candidate.
   *  This — not `candidates` — is what a picker renders and what an allowlist
   *  checks against. */
  readonly ids: () => readonly string[]
  /** Probe the provider catalog and add every newly-discovered model a port can be
   *  built for. Memoized on SUCCESS only: a probe that failed (expired auth,
   *  offline) is retried on the next call rather than caching "no catalog" for the
   *  life of the process. No-throw. */
  readonly refresh: () => Promise<void>
  /** True once a probe has actually SUCCEEDED. A renderer uses it to say "this
   *  list may be incomplete" instead of presenting a short menu as the truth. */
  readonly probeSucceeded: () => boolean
}

/** One catalog probe, isolated: resolves to the provider's slugs, or `[]` for any
 *  failure mode (no probe surface, rejection, non-array). `ok` distinguishes "the
 *  provider says there are none" from "we could not ask". */
const probeCatalog = async (
  llm: LLMPort,
): Promise<{ readonly ok: boolean; readonly slugs: readonly string[] }> => {
  const list = llm.listModels
  if (list === undefined) return { ok: false, slugs: [] }
  try {
    const slugs = await list.call(llm)
    const usable = (Array.isArray(slugs) ? slugs : []).filter(
      (s): s is string => typeof s === "string",
    )
    if (usable.length > MAX_PROBED_MODEL_IDS) {
      logger.warn(
        `model catalog probe returned ${usable.length} ids; using the first ${MAX_PROBED_MODEL_IDS}`,
      )
    }
    return { ok: true, slugs: usable.slice(0, MAX_PROBED_MODEL_IDS) }
  } catch (e) {
    // WARN, not debug: a failed probe is a user-visible DEGRADE — the model list
    // the operator is about to choose from is incomplete (only the seeded ids).
    logger.warn(`model catalog probe failed — candidate list may be incomplete: ${errMessage(e)}`)
    return { ok: false, slugs: [] }
  }
}

export const buildModelCatalogWire = (args: {
  readonly provider: Provider
  readonly bootModel: string
  /** The session's port — the PROBE surface. Never used as a candidate port
   *  (invariant A: the boot model resolves to `config.llm` by fallback). */
  readonly llm: LLMPort
  /** Operator-configured extra candidates (`QUANTA_RETRY_MODELS`), already built
   *  by the surface. Their ports are taken verbatim. */
  readonly seeded: readonly ModelCandidate[]
  /** Ids to build a port for EAGERLY, before any probe. The surface passes the
   *  PERSISTED sticky pick here: the probe is lazy (it only runs when the operator
   *  opens the picker), so a resumed session that never opens it would otherwise
   *  have no port for the model it is supposed to run — and the loop's swap would
   *  silently fall back to the boot model. */
  readonly extraIds?: readonly string[]
  /** THE port builder (invariant B) — the composition root's, so a candidate
   *  carries the same credential/endpoint context and the same always-on
   *  wrappers (bounded retry, empty-stream breaker, progress heartbeat) as the
   *  boot port. Absent ⇒ the bare legacy factory, which is correct only for a
   *  host that composes nothing (tests, simple embedders). */
  readonly buildPort?: (id: string) => LLMPort | null
  readonly env: NodeJS.ProcessEnv
}): ModelCatalogWire => {
  const live: ModelCandidate[] = []
  const known = new Set<string>(args.bootModel.length > 0 ? [args.bootModel] : [])
  const mint =
    args.buildPort ?? ((id: string) => tryCreateLLM(args.provider, { model: id }, args.env))

  /** Admit one id: validate the slug, skip duplicates (incl. the boot model), and
   *  build its port — logging every drop so a short menu is never silent. */
  const admit = (id: string, port?: LLMPort): void => {
    if (known.has(id)) return
    if (!isPlausibleModelSlug(id)) {
      logger.warn(`model catalog: ignoring implausible model id (${id.length} chars)`)
      return
    }
    const built = port ?? mint(id)
    if (built === null) {
      // A candidate whose port cannot be built (no credential for this provider,
      // or an endpoint the composer refused) is DROPPED rather than listed: an
      // unbuildable candidate would render in the picker and then no-op on the
      // consume side, which is the exact silent-failure shape this wire removes.
      logger.warn(`model catalog: no port could be built for "${id}" — not offering it`)
      return
    }
    known.add(id)
    live.push({ id, port: built })
  }

  for (const seed of args.seeded) admit(seed.id, seed.port)
  for (const id of args.extraIds ?? []) admit(id)

  let probed: Promise<void> | undefined
  let succeeded = false
  const runProbe = async (): Promise<void> => {
    const { ok, slugs } = await probeCatalog(args.llm)
    for (const id of slugs) admit(id)
    succeeded = ok
    // Memoize SUCCESS only: a transient auth/network failure must not cache
    // "this account has no catalog" for the rest of the process.
    if (!ok) probed = undefined
  }
  return {
    candidates: live,
    ids: () =>
      args.bootModel.length > 0
        ? [args.bootModel, ...live.map((c) => c.id)]
        : live.map((c) => c.id),
    probeSucceeded: () => succeeded,
    refresh: () => {
      // `runProbe` is no-throw by construction (every fallible step is inside
      // `probeCatalog`'s try or `admit`'s null check), so a cached promise can
      // never be a REJECTED one that every later caller re-throws.
      probed ??= runProbe()
      return probed
    },
  }
}
