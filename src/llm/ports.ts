import type { LlmSurfaceId, LlmTransportId } from "@/shared/llm-route-types"
import type { StreamEvent, StreamInput } from "./types"

export interface LLMPort {
  /** The configured model id (e.g. `claude-sonnet-4-6`, `gpt-4o`). Real
   *  adapters expose it so the loop can emit a faithful pre-stream
   *  `llm_request` (RFC-0002 §5.2/§9) without probing private fields.
   *  Optional: lightweight test doubles may omit it (loop falls back to
   *  `"unknown"`), so adding this never breaks an existing `LLMPort`. */
  readonly model?: string
  /** Optional CONTEXT-WINDOW resolution key (gap GAP 3, ADR-0505). Distinct from
   *  {@link model} (the API model id, which must stay the canonical un-suffixed
   *  slug). When the `context-1m` beta is active the adapter pins the `<model>-1m`
   *  window key here so compaction + the usage gauge resolve the granted 1M window
   *  instead of the 200k default. Absent ⇒ the window is resolved from `model`
   *  (byte-identical). */
  readonly contextWindowKey?: string
  /** Optional provider id (`anthropic` / `openai` / `chatgpt-oauth`).
   *  Real adapters expose it so the loop's pre-stream `llm_request` marker
   *  can carry it through to the renderer, which paints an unambiguous
   *  auth-mode badge alongside the model. Lightweight test doubles may
   *  omit it; the renderer just paints the model when absent. */
  readonly provider?: string
  /** Optional canonical wire-surface id (`anthropic-messages`,
   *  `openai-chat-completions`, `openai-responses`). Lets telemetry separate
   *  vendor choice from request grammar. */
  readonly surfaceId?: LlmSurfaceId
  /** Optional transport id (`public`, `bedrock`, `vertex`, `foundry`,
   *  `mantle`, `chatgpt-oauth`). Orthogonal to `surfaceId`. */
  readonly transportId?: LlmTransportId
  /** Optional human-readable auth-mode label
   *  (`"ChatGPT subscription"` / `"OpenAI BYOK"` / `"Anthropic BYOK"`).
   *  Same emission rules as {@link provider}. */
  readonly authMode?: string
  /** Streams a single assistant turn. The caller reconstructs the assistant
   *  message from the emitted events (see {@link assembleMessage}). */
  stream(input: StreamInput): AsyncIterable<StreamEvent>
  /**
   * OPTIONAL model-catalog probe — the model ids THIS credential/account is
   * actually allowed to run. Used by the `/model` picker so its candidate set is
   * the provider's live truth instead of a hand-maintained slug list that drifts
   * (the exact drift `MODEL_CONTEXT_WINDOWS` already shows: it has no
   * `gpt-5.6-terra` entry while that is the live default).
   *
   * Contract:
   *   - an adapter MAY cache (the chatgpt-oauth adapter reuses its 5-minute
   *     `/codex/models` memo; the anthropic adapter does a bare `/v1/models`),
   *     and every CALLER should memoize — the CLI's catalog wire probes once per
   *     session;
   *   - it MAY throw (auth expired, offline) — every caller must treat a
   *     rejection as "no catalog" and degrade, never as a session error;
   *   - absent ⇒ the caller keeps whatever candidate set it was seeded with
   *     (boot model + operator-configured ids). Adding this never breaks an
   *     existing `LLMPort` (test doubles omit it);
   *   - it MUST honour `signal` (MR-07): the probe is awaited on BLOCKING,
   *     user-facing paths — the CLI's `/model` picker (`slash/model-cmd`) and the
   *     daemon's `GET /readout/model` route — and the base URL is
   *     env-overridable, so a hung endpoint used to wedge both forever. The
   *     signal MUST reach the REAL HTTP request (the SDK call's `signal` /
   *     `fetch`'s `RequestInit.signal`); a caller-side race alone would return
   *     control while leaving a live request holding the socket. The abort
   *     surfaces as a REJECTION (an `AbortError`/typed `LLMError`), which the
   *     caller already degrades to "no catalog" — see
   *     `model-catalog.ts#probeCatalog`, which composes its own
   *     `AbortSignal.timeout` deadline with any caller signal.
   *
   * A DECORATOR must forward this method with its argument intact (see
   * `port-identity.ts#forwardPortIdentity`, and the two class-shaped ports —
   * `RetryingLLM`, `FallbackLLM` — that hand-roll the identity copy); dropping
   * the parameter silently makes every probe uncancellable again.
   */
  listModels?: (signal?: AbortSignal) => Promise<readonly string[]>
}
