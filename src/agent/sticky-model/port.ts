/**
 * Sticky model-per-mode port (ADR-0212).
 *
 * The closed-port surface for the sticky-model store. A store remembers the
 * last-chosen `modelId` for each `AgentMode` so that the user's choice of
 * "use gpt-5 for plan mode, use a fast model for editor mode" survives
 * across turns and sessions.
 *
 * Pure-by-contract for the IN-MEMORY default impl; the fs-backed impl
 * (separate file) performs IO and is the only port surface allowed to
 * touch disk. The {@link StickyModelResolver} composes the store with the
 * caller's explicit override + global default — its result is the
 * effective modelId for the current mode.
 *
 * No-throw public surface: every store method returns Promises that
 * RESOLVE with a typed result rather than reject. Corruption / IO errors
 * surface via {@link StickyModelLoadResult.error} so the resolver can fall
 * back to the global default deterministically.
 */

import type { QuantaError } from "@/shared"
import type { AgentMode } from "../prompt"

/** The sticky-model store port. Two methods: read a per-mode modelId,
 *  write one. Reads return `undefined` (NOT throw) when no entry exists —
 *  "no preference yet" is the canonical empty state. */
/** The key a pick is stored under (aug-28: `provider` joined the key).
 *
 *  WHY the provider is part of the key: a model id is only meaningful for the
 *  provider it belongs to, and `tryCreateLLM` validates the CREDENTIAL, never the
 *  slug — so an anthropic pick read back in an openai session produced a
 *  real-looking port that failed at the wire on EVERY turn. Keying by provider
 *  makes the pick simply not apply there (the boot model runs), which is the
 *  honest degrade. Absent `provider` ⇒ the legacy bare-mode key (test doubles and
 *  callers that have no provider). */
export interface StickyModelKey {
  readonly mode: AgentMode
  readonly provider?: string
}

/** THE file/map key for a pick. `<provider>:<mode>` when a provider is known,
 *  else the bare mode (legacy shape). Spelled once so every store impl and every
 *  reader compose it identically — a mismatched key is a silent no-preference. */
export const stickyModelKeyOf = (key: StickyModelKey): string =>
  key.provider !== undefined && key.provider.length > 0 ? `${key.provider}:${key.mode}` : key.mode

/**
 * The keys a READ may satisfy, in precedence order (aug-28).
 *
 * Writes always use {@link stickyModelKeyOf} — one canonical shape. Reads accept a
 * second, LEGACY one: the bare mode, which is what every pick written before the
 * provider joined the key looks like on disk. Without this fallback, adding the
 * provider silently orphaned every existing `~/.quanta/sticky-model.json` — the
 * file still held the user's preference, the loop composed a key that was not in
 * it, and nothing anywhere said the preference had been dropped. That is the same
 * silent-no-preference failure the provider key was added to prevent, just aimed
 * at existing users instead of cross-provider ones.
 *
 * A scoped entry WINS over a bare one for the same mode (it is the more specific
 * statement), and the next write supersedes the legacy key rather than editing it.
 */
export const stickyModelReadKeys = (key: StickyModelKey): readonly string[] => {
  const scoped = stickyModelKeyOf(key)
  return scoped === key.mode ? [scoped] : [scoped, key.mode]
}

/** First value present under {@link stickyModelReadKeys}. Shared by every store
 *  impl so the precedence cannot differ between them. */
export const readStickyModelFrom = (
  lookup: (key: string) => string | undefined,
  key: StickyModelKey,
): string | undefined => {
  for (const candidate of stickyModelReadKeys(key)) {
    const found = lookup(candidate)
    if (found !== undefined && found.length > 0) return found
  }
  return undefined
}

export interface StickyModelStore {
  /** Return the sticky modelId for `mode` (and provider, when keyed), or
   *  `undefined` if no entry exists (no preference). MUST NOT throw on IO errors —
   *  implementations surface those via the {@link load} method instead so the read
   *  path is always quick and predictable. */
  get(input: StickyModelKey): Promise<string | undefined>
  /** Record a sticky modelId for `mode`. Idempotent — writing the same
   *  value twice is a no-op. MUST NOT throw on IO errors; implementations
   *  surface those via the returned {@link StickyModelSetResult}. */
  set(input: StickyModelKey & { readonly modelId: string }): Promise<StickyModelSetResult>
  /** REMOVE the pick for `input`, returning that key to "no preference" (aug-28).
   *
   *  WHY THE PORT NEEDS A REMOVAL AT ALL. Before this the port could only ever
   *  ACCUMULATE preferences: `get`/`set`/`load`/`peek`, and an empty id is exactly
   *  what the resolver reads as "no override", so `set('')` would be a silent
   *  no-op (the surfaces reject it up front). One `/model gpt-4o` was therefore
   *  PERMANENT — it applied to every future session for that provider+mode, and
   *  the only escape was hand-editing `~/.quanta/sticky-model.json` or pinning
   *  `--model`/`QUANTA_MODEL` on every invocation (which overrides a single run and
   *  leaves the stored pick standing). "Go back to whatever this session booted
   *  with" is an ordinary thing to want and had no front door at all. This is that
   *  door's back half; `/model --clear` and `/sticky-model <mode> --clear` are the
   *  front.
   *
   *  REQUIRED, not optional, for the same reason {@link peek} is: an optional
   *  removal is one a future impl silently omits while the command above it keeps
   *  offering the verb — and the failure would look like "the clear worked" while
   *  the pick came back on the next session.
   *
   *  IDEMPOTENT: removing a key that holds no pick is a SUCCESS (`ok:true`), never
   *  an error — the caller asked for the end state "no preference here", and that
   *  state already holds. MUST NOT throw; IO faults surface through the same
   *  {@link StickyModelSetResult} union `set` uses. */
  unset(input: StickyModelKey): Promise<StickyModelSetResult>
  /** Snapshot the whole store as a plain map. Used by `/status` and tests.
   *  Never throws; returns an empty record on IO error (with the error
   *  payload in {@link StickyModelLoadResult}). */
  load(): Promise<StickyModelLoadResult>
  /** SYNCHRONOUS read of the same pick {@link get} returns (aug-28).
   *
   *  WHY THE PORT AND NOT A CACHE AT EACH CALLER. Everything that DISPLAYS the
   *  active model is sync — the `/model` picker's `current()`, the status line,
   *  the welcome banner, `SessionHost.describe().modelSlug` (and through it the
   *  attach pill, the SDK's `session.model`, and the web `/state` readout) — while
   *  this port is async. Every one of those grew its own shadow copy of the pick,
   *  and each copy was a fresh chance to disagree with the turn: the measured
   *  defect was a picker announcing a model the loop was not running.
   *
   *  REQUIRED, not optional, so a future impl cannot silently reintroduce the
   *  split by omitting it. `undefined` means "no preference for this key" — the
   *  same empty state as {@link get}. MUST NOT throw. */
  peek(input: StickyModelKey): string | undefined
}

/** Result of {@link StickyModelStore.set}. `ok` discriminates success vs. a
 *  recorded IO error; the error is a {@link QuantaError} subclass so the
 *  caller's typed-error union holds. */
export type StickyModelSetResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: QuantaError }

/** Result of {@link StickyModelStore.load}. `ok=true` carries the snapshot;
 *  `ok=false` carries the typed error AND an empty snapshot so callers
 *  defensively reading `result.snapshot` always get a Record. */
export type StickyModelLoadResult =
  | { readonly ok: true; readonly snapshot: Readonly<Record<string, string>> }
  | {
      readonly ok: false
      readonly snapshot: Readonly<Record<string, string>>
      readonly error: QuantaError
    }

/** Sticky-model resolver port (ADR-0212). Compose the store with the
 *  explicit caller override and the global default in ONE call site so
 *  precedence is enforced by ONE function, not by every caller. */
export interface StickyModelResolver {
  /** Resolve the effective modelId for `mode`. Precedence:
   *    1. `explicitOverride` (caller-supplied; user CLI flag, slash command)
   *    2. sticky store entry for `mode`
   *    3. `globalDefault`
   *
   *  `globalDefault` is REQUIRED — the resolver never returns `undefined`.
   *  Any IO error from the store falls through to the global default
   *  silently (recorded via the store's `load()` result for callers that
   *  want to observe). */
  resolve(input: {
    readonly mode: AgentMode
    readonly globalDefault: string
    readonly explicitOverride?: string
  }): Promise<string>
}
