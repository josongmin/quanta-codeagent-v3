# ADR-0477: Artifact canvas store — session-scoped registry for non-code generation outputs

- **상태**: Accepted
- **날짜**: 2026-06-06
- **관련**:
  - ADR-0280 (`automation_update` tool — the caller-wired, default-OFF, duck-typed-port registration pattern this slice mirrors exactly: `DefaultToolPorts.X` set ⇒ tools appended, absent ⇒ byte-identical menu)
- **참조**:
  - `src/artifact/registry.ts` — `createArtifactRegistry(opts) → ArtifactRegistry` (PURE in-memory store), closed `ArtifactKind` + `ARTIFACT_KINDS`, `Artifact`/`ArtifactSpec`, `previewUrl` + `ARTIFACT_URL_SCHEME`, `monotonicIdFactory`, `ArtifactRegistryOptions{ now, idFactory }`.
  - `src/tool/artifact/index.ts` — `artifactTools(registry)` builds `artifact_register` / `artifact_list` / `artifact_get` / `artifact_destroy`; duck-typed `ArtifactRegistryPort` (fence-clean mirror of `@/artifact`).
  - `src/tool/index.ts` — `DefaultToolPorts.artifactRegistry?` + the conditional `base.push(...artifactTools(ports.artifactRegistry))` (registration only when wired).
  - `src/host/runtime/agent-arg-builder.ts` — `buildGatedToolPorts` mints ONE per-session `createArtifactRegistry({ now: Date.now, idFactory: monotonicIdFactory() })` gated on `QUANTA_ARTIFACT_STORE === "1"`.
  - Tests: `tests/unit/artifact-registry-hellgate.test.ts` (8 cases), `tests/unit/artifact-store-e2e-hellgate.test.ts` (5 cases).
  - Feature catalog: `tools/feature-catalog/features/02-tool-system/c1-artifact-canvas-store.yaml`.

## 맥락

The generation axis produces NON-code binary outputs — `image_gen` PNGs, `xlsx_write` / `docx_write` / `pptx_write` Office files. These are not transcript content: pasting their bytes back into the conversation is both useless to the model and ruinously expensive in tokens, and writing a bare `file://`/absolute path into the transcript leaks the fs jail layout and breaks the moment the file is relocated.

There was no first-class way to answer "I made a file — where does it live and how do I refer to it later?". Cursor solves this with `agent.v1.Canvas{Register, GetUrl, Destroy}`: a session-scoped handle store that mints a stable id + an opaque preview URL per artifact, so the agent registers an output once and thereafter references / lists / destroys it **by id** rather than by bytes or by raw path. This ADR absorbs that pattern.

## 결정

A two-layer slice: a PURE registry core in `@/artifact` and a thin model-facing tool surface in `@/tool`, wired only at the composition root.

**Core — `src/artifact/registry.ts` (PURE leaf, imports only `@/shared`):**

- Closed `ArtifactKind = "image" | "spreadsheet" | "document" | "presentation" | "other"` with `ARTIFACT_KINDS` as the stable-order array for exhaustiveness + drift guards. `other` is the deliberate escape hatch; the generation tools map to the specific kinds.
- `Artifact { id, kind, path, mediaType, label?, createdAt }` — `id` is registry-minted, `path` is the on-disk (jailed) location the producing tool already wrote, `createdAt` is from the injected clock. `ArtifactSpec` is the caller spec (everything *but* the registry-owned `id`/`createdAt`).
- `createArtifactRegistry({ now, idFactory })` returns the `ArtifactRegistry` port: `register / get / list / destroy`. Backed by a `Map` (insertion-ordered); `list()` returns a **frozen-by-copy snapshot sorted by `createdAt` then `id` via `byteCompare`** so ties are deterministic regardless of insertion timing, and so a caller mutating the returned array cannot corrupt the store.
- **No clock, no RNG in the core.** `ArtifactRegistryOptions` injects `now: () => number` and `idFactory: () => string` — the *only* time/id sources — so the core is byte-deterministically testable (no `Date.now()` / `Math.random()`). The default host id source is `monotonicIdFactory(prefix = "art")`: a monotonic counter (`art-1`, `art-2`, …), collision-free within a session without a clock or RNG.
- **NO-THROW**: every method returns a value — `get`/`destroy` of an unknown id yield `undefined`/`false`, never an exception.
- `previewUrl(a) = "quanta-artifact://" + a.id` (`ARTIFACT_URL_SCHEME`). Chosen over a bare `file://` precisely so the reference (a) stays valid if the file is later moved and (b) never leaks the absolute fs path into the transcript. The host resolves the scheme to the jailed path / a served preview.

**Tools — `src/tool/artifact/index.ts`:**

`artifactTools(registry)` builds four tools. `@/tool` may NOT import `@/artifact` (slice fence), so the tool layer declares a **duck-typed `ArtifactRegistryPort`** — a structural mirror of `@/artifact`'s `ArtifactRegistry` — and the composition root passes the real registry, which matches structurally. `ARTIFACT_URL_SCHEME` is duplicated here as a stable wire contract to keep the fence clean.

- `artifact_register` — mutating (`isReadOnly: false`, `isConcurrencySafe: false`); registers a produced artifact, returns the rendered line with id + `quanta-artifact://<id>` URL.
- `artifact_list` — read-only + concurrency-safe; optional closed-enum `kind` filter; checks `ctx.signal.aborted`; empty store ⇒ `"No artifacts registered this session."`.
- `artifact_get` — read-only; unknown id ⇒ typed `ok:false` with `failure.mode: "not_found"`.
- `artifact_destroy` — mutating; removes the registry entry only (does NOT delete the on-disk file); unknown id ⇒ `ok:false / not_found`.

Every tool `safeParse`s its input and yields a typed `ok:false` (`mode:"rejected", reason:"bad_input"`) on invalid input — NO-THROW end to end.

**Default-OFF wiring (mirrors ADR-0280 `automation_update`):** the tools are appended ONLY when `DefaultToolPorts.artifactRegistry` is set — `src/tool/index.ts` does `if (ports.artifactRegistry !== undefined) base.push(...artifactTools(ports.artifactRegistry))`. The composition root (`buildGatedToolPorts` in `agent-arg-builder.ts`) mints exactly ONE per-session `createArtifactRegistry({ now: () => Date.now(), idFactory: monotonicIdFactory() })` — and only when `QUANTA_ARTIFACT_STORE === "1"`. The real clock + monotonic id factory are injected at this single composition point, keeping `Date.now()` out of the core. An unset deployment never instantiates a registry; the artifact tools are simply not in the menu.

## 결과

- Generated non-code outputs get a session lifecycle (register → list → inspect → destroy) and a stable, move-safe, path-non-leaking reference (`quanta-artifact://<id>`) the model can carry across turns without re-pasting bytes.
- With `QUANTA_ARTIFACT_STORE` unset the default tool menu and all behavior are **byte-identical** to the pre-ADR code — no registry constructed, no tools registered, no env touched beyond the single gate read.
- The core is fully deterministic and unit-pinnable: injected clock + id factory mean tests assert exact ids (`art-1`) and `createdAt` values with no fakes-of-globals.
- The duck-typed port keeps the `@/tool` → `@/artifact` slice fence intact while letting the composition root pass the concrete registry structurally.

## Trade-offs / Negative invariants

Deliberately NOT done:
- **No disk/DB persistence** — the registry is in-memory and session-scoped. The `ArtifactRegistry` interface is the seam: a future disk-backed impl satisfies the same NO-THROW contract without touching callers.
- **No file deletion on `destroy`** — destroying an entry removes the registry handle only; the on-disk (jailed) file is left to the fs lifecycle. (Pinned by the destroy tool's description + behavior.)
- **`register` is model-facing here but host-owned in the live wire** — the feature ships `artifact_register` as a tool (self-contained: a model can explicitly register), while the intended steady state is the generation tools auto-registering at the composition root. That auto-register hop is an additive follow-up, not part of this ADR.

Load-bearing invariants pinned by the hellgate tests (each adversarial case → one invariant):

- *register mints monotonic ids + stamps `createdAt` from the injected clock* — ids/timestamps come ONLY from injected sources; no global clock/RNG leaks into the core.
- *label is OMITTED when absent (exactOptional), present when given* — `label` is a true optional property, never materialized as `undefined`.
- *every `ArtifactKind` round-trips* — the closed kind vocabulary is exhaustive end to end.
- *get returns the artifact; unknown id ⇒ undefined* and *destroy removes (true) and is false for an unknown id* — NO-THROW total functions over the id space; idempotent destroy.
- *list is deterministic (createdAt then id) + an immutable snapshot* — `byteCompare` tie-break gives a stable order; mutating the returned array cannot corrupt the store.
- *previewUrl is the stable `quanta-artifact://<id>` reference* + *monotonicIdFactory honors the prefix + never repeats* — the wire scheme and id sequence are fixed contracts.
- e2e: *register → list → get → destroy round-trip surfaces id + preview URL*, *list kind filter*, *bad input ⇒ typed `ok:false` (no throw)* — the tool surface preserves the core's contract through the `Tool.execute` generators.
- e2e: *absent registry ⇒ `artifact_*` NOT in the default menu (byte-identical)* and *wired registry ⇒ all four artifact tools registered* — the default-OFF gate is the registration boundary; nothing in the default menu changes until the registry is wired.
