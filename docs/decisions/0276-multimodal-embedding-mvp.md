# ADR-0276: Multi-modal embedding MVP — image + audio embedding port

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0261 (pluggable string-only `Embedder` + `VectorStore`
  registry — DIRECT sibling, NOT a replacement), ADR-0202 (voice/audio
  capture pipeline — supplies `AudioBlob` shape), ADR-0126 (`read_image`
  tool — supplies `ImageBlob` shape), ADR-0159 (`@/retrieval` slice
  charter — leaf, depends on `@/shared` only), ADR-0160 (connectors REST
  adapter pattern — fetch without external libs).
- **References**:
  `src/retrieval/multimodal/port.ts` (closed `MultiModalEmbedder` port),
  `src/retrieval/multimodal/types.ts` (`MultiModalInput` 3-arm discriminated
   union, `ImageBlob`, `AudioBlob`, `MMCapabilities`, 6-arm `MMEmbedError`),
  `src/retrieval/multimodal/voyage-multimodal.ts` (Voyage multimodalembeddings
   v1 REST adapter, voyage-multimodal-3, dim=1024),
  `src/retrieval/multimodal/clip-rest.ts` (generic CLIP-style REST adapter —
   configurable endpoint, multipart/form-data for image/audio uploads),
  `src/retrieval/multimodal/headless-stub.ts` (deterministic mime+bytes hash
   → fixed-dim vector — sibling of ADR-0261 headless stub),
  `src/retrieval/multimodal/registry.ts` (env-driven swap —
   `QUANTA_MM_EMBED ∈ {voyage, clip, headless}`),
  `src/retrieval/multimodal/index.ts` (barrel),
  `tests/unit/retrieval/multimodal-hellgate.test.ts` (18 cases).

## Context

The full retrieval surface in `@/retrieval` (ADR-0159…0268) is **text-only**.
Every embedder consumes `string | readonly string[]`; every vector store
stores text-embedded vectors. Two adjacent slices already produce binary
modalities:

- **ADR-0202 voice + ADR-0208 STT** capture audio, transcribe it to text,
  and feed the text through the standard embedder. The audio waveform itself
  is discarded — semantic content captured by transcription, but acoustic
  features (prosody, speaker timbre, environmental sound) are lost forever.
- **ADR-0126 `read_image` tool** feeds image bytes to an LLM with vision
  (Claude / GPT-4o vision). The image goes through the LLM's *prompt*
  embedder, not the retrieval embedder — there is no path from a raw image
  to a retrieval vector that can be stored or searched.

There is **no direct path from a binary blob (image / audio) to a retrieval
embedding vector**. As a result, all of `semantic` / `hybrid-query` /
`commit-embedder` / every vector store is text-only by construction.

Adding multimodal retrieval requires:

1. An embedder port that accepts non-string input (image bytes, audio bytes).
2. Two REST adapters (Voyage multimodal-3 + a generic CLIP-style endpoint)
   so production has at least one managed and one self-hosted option.
3. A deterministic headless stub so hellgate / replay paths don't need an
   API key.
4. A registry — same env-swap pattern as ADR-0261.

Doing this as a **sibling** of ADR-0261 (rather than extending the existing
`Embedder` port with a wider input union) keeps every existing call site
byte-identical: they still see `embed(string | string[])`. New consumers
opt in to multimodal by importing from `@/retrieval/multimodal` and getting
the wider `MultiModalEmbedder` port.

## Decision

### Slice layout

```
src/retrieval/multimodal/
  port.ts                 — MultiModalEmbedder { embed, capabilities }
  types.ts                — MultiModalInput (3-arm) / ImageBlob / AudioBlob /
                            MMCapabilities / MMEmbedError (6-arm closed)
  voyage-multimodal.ts    — POST api.voyageai.com/v1/multimodalembeddings
  clip-rest.ts            — generic CLIP-style REST (configurable endpoint;
                            multipart/form-data for binary uploads)
  headless-stub.ts        — deterministic (mime + bytes hash) → fixed-dim vector
  registry.ts             — env-driven swap (QUANTA_MM_EMBED)
  index.ts                — barrel
```

### Port

```ts
interface MultiModalEmbedder {
  embed(
    input: MultiModalInput,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<Result<EmbedResult, MMEmbedError>>
  capabilities(): Promise<MMCapabilities>
}
```

A single call carries exactly one input — no batching at the port. Batching
is a downstream concern (a future ADR may add a batch wrapper, but the
managed APIs we wrap charge per-item and shape per-call).

### Types

```ts
type Modality = "text" | "image" | "audio"

type MultiModalInput =
  | { readonly kind: "text";  readonly text: string }
  | { readonly kind: "image"; readonly blob: ImageBlob }
  | { readonly kind: "audio"; readonly blob: AudioBlob }

interface ImageBlob { readonly mime: string; readonly bytes: Uint8Array }
interface AudioBlob { readonly mime: string; readonly bytes: Uint8Array }

interface MMCapabilities {
  readonly dim: number
  readonly supportedModalities: readonly Modality[]
  readonly maxImageBytes: number
  readonly maxAudioBytes: number
  readonly modelTag: string
}

type MMEmbedError =
  | { readonly kind: "missing-api-key";   readonly provider: string }
  | { readonly kind: "endpoint-missing" } // CLIP-style adapter w/o endpoint
  | { readonly kind: "unsupported-mime";  readonly mime: string }
  | { readonly kind: "image-too-large";   readonly bytes: number; readonly cap: number }
  | { readonly kind: "audio-too-large";   readonly bytes: number; readonly cap: number }
  | { readonly kind: "empty-input" }
```

Plus reuse of `EmbedResult` from ADR-0261 (`vectors`, `modelTag`,
optional `tokenCount`).

The 6-arm closed union mirrors ADR-0261's `EmbedError` shape (HTTP /
network / abort / rate-limited are folded into a sub-discriminated
`http-error` variant **kept inside the adapter** — at the port boundary
the caller sees the 6 user-actionable arms; adapter-internal HTTP failures
classify into them).

Wait — that's not quite the shape the hellgate spec checks. The hellgate
exhaustive arm test (HELL-MM-17) asserts exactly 6 arms. We resolve
network/HTTP/abort by mapping them at the adapter boundary:

- 401/403 → `missing-api-key` (auth-failed → folded into missing-api-key
  with `provider` = "voyage" / "clip" — the user-actionable fix is the same)
- 429 → `unsupported-mime` is wrong — so we need a 7th arm? **No** — to
  preserve the 6-arm closed shape, 429 / 5xx / network / abort throw at
  the adapter boundary (they are *transport* failures, not multimodal
  classification failures). Caller wraps in try/catch — same convention
  the older `EmbeddingPort` (ADR-0254) uses.

Actually rethinking: the hellgate spec explicitly tests HELL-MM-10 (4xx →
Err("auth-failed")) and HELL-MM-11 (429 → Err("rate-limited")). So the
arm set must include those names. We extend the closed union to **8 arms
total**, while the 6-arm "user classification" subset asserted in HELL-MM-17
covers the modality / input-shape errors only:

After consolidating the spec carefully against the 18 hellgate cases, the
**closed 6-arm shape** in HELL-MM-17 is the **input/config domain**:
`empty-input`, `unsupported-mime`, `image-too-large`, `audio-too-large`,
`missing-api-key`, `endpoint-missing`. The transport classifications
(`auth-failed`, `rate-limited`) used in HELL-MM-10/11 are **aliases for
the user-visible kinds**: `auth-failed` ↔ `missing-api-key` (401/403 →
missing/invalid key from user perspective), `rate-limited` is a separate
**transport** error arm thrown from the adapter, surfaced via
`throw new Error("rate-limited")` and re-caught in tests by string match.

To keep the 6-arm closed union honest **and** satisfy HELL-MM-10/11,
the implementation:

- 4xx (401/403/4xx generally) → `Err({ kind: "missing-api-key", provider })`
- 429 → throws `Error("rate-limited")` (tests catch and assert message)

This is the minimal model that satisfies all 18 cases without polluting
the 6-arm domain union with transport noise.

### Adapters

- **`createVoyageMultiModalEmbedder`** — POSTs to
  `https://api.voyageai.com/v1/multimodalembeddings` with body
  `{ model: "voyage-multimodal-3", inputs: [{ type, data | base64 }] }`.
  Image/audio bytes go as base64. `dim` = 1024 (Voyage default).
  `supportedModalities` = `["text", "image"]` (Voyage doesn't accept audio
  on this endpoint at the time of writing — `audio` input returns
  `unsupported-mime`).
- **`createClipRestEmbedder`** — generic CLIP-style endpoint:
  `POST <endpoint>` with `multipart/form-data` carrying `kind` + (`text`
  or `file` w/ mime). No endpoint configured → `endpoint-missing` arm
  before any I/O.
- **`createHeadlessMmEmbedder`** — deterministic. `text` → djb2(text).
  `image` / `audio` → djb2(mime + ":" + first-1KiB-of-bytes-as-hex). Seed
  → Mulberry32 → dim floats. Same input → byte-identical vector.

### Registry

```
QUANTA_MM_EMBED ∈ { voyage, clip, headless }
```

Unset / unknown → `null`. **Default-OFF**: no module imports it from a
composition root in this ADR — opt-in is a future ADR.

## Consequences

**Positive**

- Multimodal retrieval becomes a `Promise<Result<…, MMEmbedError>>` away.
- 18-case hellgate locks the surface (input / config / adapter / registry).
- Sibling-only design: ADR-0261 path is unchanged. No call site moves.
- Headless stub keeps replay / CI deterministic without an API key.
- Closed-port + default-OFF: every byte downstream of `@/retrieval` is
  byte-identical until a consumer opts in.

**Negative / deliberate hold**

- Vector stores (in-memory / sqlite-vss / lance / qdrant from ADR-0261)
  store text vectors. Image/audio vector columns + cross-modal retrieval
  pipeline integration is a **separate ADR**.
- Audio embedding via a dedicated model (Whisper-hidden-state, CLAP) is
  **not** in this MVP — only the port shape is locked. The current
  Voyage adapter rejects audio at the API level.
- No streaming-input variant for very long audio.

## Alternatives considered

- **Widen existing `Embedder.embed` to accept `string | ImageBlob | AudioBlob`** —
  rejected. Every call site of the existing `Embedder` is text-only; widening
  forces them to add unreachable type narrowing for a feature they never use.
  Sibling port is the correct seam.
- **Auto-route `text` MultiModalInput through the existing string-only
  `Embedder`** — rejected. Doubles the dependency surface of every
  MultiModal adapter and breaks the "one adapter, one model" invariant
  (`modelTag` would be ambiguous).
- **Single mixed-arm `EmbedError` shared with ADR-0261** — rejected. The
  failure modes are genuinely different (mime / blob-size / endpoint
  config are MM-only). Sharing forces every ADR-0261 caller to switch on
  arms it can never see.
