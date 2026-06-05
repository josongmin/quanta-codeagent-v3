# RFC — C1: Canvas artifact store (`src/artifact/`)

> Status: PROPOSED (design only — no source changed by this RFC)
> Date: 2026-06-04
> Slice: NEW `src/artifact/`
> Default posture: OFF (byte-identical when the knob is unset)
> Feature axis: artifact-persistence (complements the NEW generation axis — H14a `image_gen` + H14b `xlsx/docx/pptx`)

---

## 1. 요약

quanta just grew a **generation axis** — `image_gen` writes PNG/JPEG/WebP (`src/tool/image-gen/`) and the H14b authoring tools write `.xlsx/.docx/.pptx` (`src/tool/document/authoring/`). Today those bytes land at an FS-jailed, versioned-sibling path inside `ctx.cwd` and the only durable trace is the path string echoed in the tool's text `output`. There is **no first-class registry of produced binaries**: the model cannot enumerate "what did I generate this session", cannot re-reference a generated asset by a stable handle two turns later (the path can be version-bumped or overwritten by a sibling tool), and there is no lifecycle (no destroy, no retention, no preview handle). **Goal:** add a small, fence-clean `src/artifact/` slice exposing an `ArtifactStorePort` (register → `artifact_id`; get → metadata+handle; destroy; list) backed by `~/.quanta/artifacts/`, so non-code outputs are persisted and addressed **separately from the conversation transcript**. The generation tools register their output; the model references it later by id. Entirely default-OFF and byte-identical when the knob is unset.

---

## 2. 경쟁사 레퍼런스 (verified evidence)

### 2.1 Cursor 3.5.33 — `agent.v1.Canvas*` (protobuf, verified)

Source: `.extracted_source/cursor/extensions/cursor-agent-exec/dist/main.js`. The tool-arg **redaction map** (which classifies every field as `SAFE`/`PATH`/`CODE` for telemetry scrubbing) carries the exact wire shape (lines ~129466–129488):

```
"agent.v1.CanvasRegisterArgs":    { path: "PATH" }            // input = a file PATH
"agent.v1.CanvasRegisterSuccess": { canvas_id: "SAFE" }       // output = opaque id
"agent.v1.CanvasRegisterError":   { error: "CODE" }
"agent.v1.CanvasRegisterResult":  {}                          // oneof{success,error}
"agent.v1.CanvasGetUrlArgs":      { canvas_id: "SAFE" }       // input = id
"agent.v1.CanvasGetUrlResult":    { url: "SAFE" }             // output = preview URL
"agent.v1.CanvasDestroyArgs":     { canvas_id: "SAFE" }       // input = id
"agent.v1.CanvasDestroyResult":   {}                          // empty ack
```

This is exactly the three-verb lifecycle the feature asks for: **register(path) → canvas_id**, **getUrl(canvas_id) → url**, **destroy(canvas_id)**. `path` is classified `PATH` (a real filesystem path, scrubbed in telemetry); `canvas_id` is `SAFE` (opaque, non-PII handle). Note the success/error split is a protobuf `oneof` — register is *fallible* and returns a typed error rather than throwing.

A **separate, server-side** sharing layer exists (`aiserver.v1.SharedCanvasMetadata` ~line 111046, `ShareCanvasRequest` ~line 111096):

```
SharedCanvasMetadata { id, title, visibility(enum), created_at, creator(message), updated_at }
ShareCanvasRequest    { title, visibility(enum), app_js: bytes, data_json: bytes, canvas_key? }
```

i.e. the *agent-local* `Canvas*` verbs persist a file and hand back an id+URL; the *cloud* `SharedCanvas*` layer is a publish step that uploads `app_js`/`data_json` for a hosted preview with visibility/creator/timestamps. The data-model fields (`id`, `title`, `created_at`, `updated_at`, `visibility`) are the right shape to mirror **locally** even though we will NOT build the cloud upload.

### 2.2 Codex — `appgen` / `appshot` (verified, partial)

Source: `.extracted_source/REFRESH-DIFF-2026-06-01.md` (lines 25–28, 47). Codex's generation-preview surface is UI-side:

- **`appgen`** — an app-generation surface: `appgen-page`, `appgen-settings-page`, `appgen-share-dialog`, `appgen-url`, `appgen-access-mode`. So a generated app gets a **URL** + a **share dialog** + an **access-mode** (visibility) — same publish-with-visibility idea as Cursor's `SharedCanvas`.
- **`appshot` / `appshots`** — app screenshots (`appshot-window`, `use-is-appshot-available`, `appshot-demo.mp4`): a generated artifact (app) produces a **derived preview** (screenshot/video).
- Plus `agent-sdk/cursor/canvas/*` UI components (collapsible-section, swatch, usage-bar) — a canvas *render* panel.

**What they actually do (summary):** both vendors treat a generated non-code output (an app, a design, a report) as a **first-class addressable object distinct from the chat transcript**, with (a) a stable id/handle, (b) a preview **URL**, (c) a visibility/access-mode, (d) timestamps, and (e) an explicit destroy. Codex adds a derived-preview (screenshot) notion. Neither stores the bytes *in* the transcript — the transcript holds only the id/handle. **This RFC adopts the agent-local register/get/destroy/list lifecycle verbatim in spirit, mirrors the local metadata fields, and explicitly DEFERS the cloud publish/share + screenshot-derivation as out of scope (Phase 3+ / non-goal).**

---

## 3. 현재 quanta 상태 (grep-verified)

### 3.1 ABSENCE confirmed

- `ls src/artifact` → `No such file or directory`.
- `grep -rln "ArtifactStore|artifact_register|canvas_register|ArtifactStorePort" src/` → **no matches**.
- The only `canvas` hits in `src/` are unrelated: `src/skill/system-skills/pr-review-canvas/*` (a PR-review skill, naming coincidence). There is no artifact/canvas persistence store anywhere.

### 3.2 Where generation tools write today

- **image_gen** (`src/tool/image-gen/tool.ts`): takes `outputPath` (line 61), resolves it through the FS jail, and writes via `ImageWritePort.writeBytes` (`src/tool/image-gen/store.ts:31`). Never overwrites — probes versioned siblings `hero.png → hero-v2.png` (`tool.ts:158-175`, `formatFromPath` 195). The written path is returned only as text inside `ToolResult.output`; an optional inline preview rides the `ToolResult.images` channel (`src/tool/types.ts:776`).
- **office authoring** (`src/tool/document/authoring/jailed-write.ts`): `resolveVersionedJailedTarget(cwd, rawPath)` (line 51) → `resolveJailed` (line 61) + first-free `-vN` sibling (`versionedName` line 36, loop 74–87); `writeJailedBytes` (line 93) does `Bun.write`. Bytes are produced by the hand-rolled STORED-ZIP writer `zip-store.ts`. Same story: output path lives only in the tool's text result.

**Gap:** the path is the only handle, and it is *mutable* (a later same-named call version-bumps to a sibling; nothing pins "the asset I made in turn 3"). There is no enumerate/destroy/metadata. That is precisely the registry C1 adds.

### 3.3 Storage substrate

- `~/.quanta/` is the established root: `sessionsRoot()` = `runtimeConfig().sessionsDir ?? ~/.quanta/sessions` (`src/session/paths.ts:19`); shadow-ODB base = `~/.quanta` → `~/.quanta/snapshots/<workspace-hash>/` (`src/storage/shadow-odb/types.ts:5,173`). A new `~/.quanta/artifacts/` sibling is idiomatic.
- `@/storage` already exports the jail chokepoint we need: `resolveJailed`, `FsJailError`, `fileExists`, `writeFileAtomic`, `sha256Hex` (`src/storage/index.ts:5,12,13,18`). The new slice reuses these — it does NOT re-roll path safety.
- Id sanitation precedent: `sanitizeId` (`src/session/paths.ts`) rejects separators/NUL/`..`/leading-`-`, length-cap 128 — the exact validator an `artifact_id`-as-path-component needs.

### 3.4 Overlap analysis — shadow-ODB (be honest)

`src/storage/shadow-odb/` (ADR-0108/0119/0122) is a **git-backed snapshot store of the user WORKSPACE TREE**, re-pointing `GIT_DIR`/`GIT_WORK_TREE` to `~/.quanta/snapshots/<hash>/` to record point-in-time *source* states for rewind/verify (`types.ts:1-18`). Its API is `init/registerHead/diffSinceLast/rewindToLast/markVerified/listSnapshots/cleanup` — all keyed on `workspaceRoot`, all about **tracked source files**, all expressed as **git commits/refs**.

It is the wrong substrate for artifacts:
- **Identity model mismatch.** Shadow-ODB addresses by *commit SHA / ref*, tied to a workspace path and the user's working tree. An artifact needs a *stable opaque id* decoupled from any git tree and from `ctx.cwd` (a generated PNG is not a tracked source edit).
- **Content model mismatch.** Shadow-ODB snapshots the *whole tree diff*; we want a *single registered blob* with metadata (mime, sourceTool, kind). Storing a binary PNG as a git-committed worktree file would pollute snapshots, inflate the ODB, and mix generated outputs into "rewind my source" semantics.
- **Lifecycle mismatch.** Shadow has no per-object destroy; its `cleanup(maxBytes)` evicts *whole workspace snapshot dirs* by LRU. Artifacts need per-id `destroy` + a *blob-LRU* retention.
- **Coupling cost.** `ShadowOdb` pulls `@/tool/git` (`types.ts:20`) and spawns `git`. An artifact store should depend on nothing heavier than `@/storage` + `@/shared`.

**Decision: NEW slice, not shadow-ODB reuse.** We *borrow patterns* from shadow-ODB (closed-port DI with injectable clock/fs/baseDir; hard-coded canonical paths to defeat traversal; LRU `cleanup(maxBytes)` with a `QUANTA_*_MAX_BYTES` knob; typed discriminated error class) but the contract, identity model, and storage layout are distinct. Reuse would force-fit a git-commit identity onto opaque-id blob storage — a net complexity *increase*. (Reuse-vs-new is revisited in §8.)

---

## 4. 설계

### 4.1 Slice placement + fence

New slice `src/artifact/`. Fence posture (per `biome.json` `noRestrictedImports`, lines 62–144):

- `@/artifact` imports **only** `@/storage` (jail + atomic write + sha256) and `@/shared` (runtime-config). It imports NO `@/agent`, `@/permission`, `@/tool`, `@/git`, `@/llm`.
- Per the existing rule that "only `@/agent` may cross slices" and "`@/tool` may only reach `@/storage`, `@/runtime`, `@/shared`" — to keep `@/tool` able to call the store from the generation tools, we add `@/artifact` to the **`@/tool`-reachable allowlist** (alongside `@/storage`/`@/runtime`/`@/shared`), and add `@/artifact` to the global restricted-paths block for every OTHER library slice (mirroring the `@/storage` entry: "reachable only via `@/agent`/`@/tool`"). Net: only `@/tool` (generation tools) and `@/agent` (assembly) may import `@/artifact`; CLI reaches it via `@/agent`/composition.
- A `tools/arch-scan`/biome ratchet rule is added so `src/artifact/**` may import only `node:*`, `@/storage`, `@/shared` (same shape as the slice-import guards memory records for image-gen/document).

### 4.2 `ArtifactStorePort` (closed-port contract)

```ts
// src/artifact/types.ts
export type ArtifactKind = "image" | "document" | "design" | "report" | "app" | "other"

export interface ArtifactRecord {
  readonly id: string            // opaque, url-safe, single path component (sanitizeId-class)
  readonly kind: ArtifactKind
  readonly path: string          // absolute path to the stored blob under artifactsRoot()
  readonly mime: string          // e.g. image/png, application/vnd.openxmlformats-…
  readonly bytes: number         // blob size
  readonly sha256: string        // content hash (dedup key)
  readonly createdAt: string     // UTC ISO-second (injected clock — deterministic in tests)
  readonly sourceTool: string    // "image_gen" | "xlsx_write" | … (provenance)
  readonly title?: string        // optional human label (mirrors Cursor SharedCanvasMetadata.title)
  readonly originPath?: string   // the in-cwd path the generation tool wrote (provenance, optional)
}

export interface RegisterArgs {
  readonly sourcePath: string    // jailed absolute path of a just-written blob (Cursor: path:"PATH")
  readonly kind: ArtifactKind
  readonly mime: string
  readonly sourceTool: string
  readonly title?: string
  readonly copy?: boolean        // true (default) = copy bytes into the store; false = reference in place
}

export type ArtifactErrorCode =
  | "invalid-id" | "not-found" | "jail-error" | "io-error" | "store-full" | "bad-source"

export class ArtifactStoreError extends Error {
  constructor(readonly code: ArtifactErrorCode, message: string) { super(message); this.name = "ArtifactStoreError" }
}

export interface PreviewHandle {
  readonly kind: "file"          // Phase 1/2: a local file:// handle. "http" reserved for Phase 3.
  readonly url: string           // file://<abs path>  (Cursor: CanvasGetUrlResult.url)
  readonly path: string          // absolute blob path (for surfaces that prefer a raw path)
}

export interface ArtifactStorePort {
  register(args: RegisterArgs): Promise<ArtifactRecord>           // → record with fresh id (Cursor register→canvas_id)
  get(id: string): Promise<ArtifactRecord>                        // throws not-found
  getPreview(id: string): Promise<PreviewHandle>                  // Cursor getUrl→url
  list(filter?: { kind?: ArtifactKind; sourceTool?: string }): Promise<readonly ArtifactRecord[]> // newest-first
  destroy(id: string): Promise<void>                             // idempotent ack (Cursor destroy)
  cleanup(maxBytes: number): Promise<number>                      // blob-LRU eviction, returns #evicted
}
```

Closed-port DI like `ShadowOdbConfig`/`ImageWritePort`: the default factory `createArtifactStore(cfg?)` injects `baseDir` (default `artifactsRoot()`), `now: () => Date`, and an FS seam (default `@/storage` primitives). Tests inject an in-memory map + frozen clock, exactly as `defaultImageWritePort` tests do.

### 4.3 FS layout under `~/.quanta/artifacts/`

```
~/.quanta/artifacts/
  index.jsonl                      # append-only record log (one ArtifactRecord JSON per line); newest-wins on id
  blobs/<id>.<ext>                 # the stored binary (ext derived from mime; id is the filename stem)
```

- `artifactsRoot()` resolves `runtimeConfig().artifactsDir ?? join(homedir(), ".quanta", "artifacts")` — a new field mirroring `sessionsDir` (`runtime-config.ts:295`-style). `QUANTA_ARTIFACTS_DIR` overrides wholesale.
- `id = "art_" + crypto.randomUUID()` (url-safe, opaque; passes the `sanitizeId`-class validator). Every public method runs the id through the validator BEFORE touching the FS → `invalid-id` on separators/NUL/`..`/leading-`-`/over-128.
- `register` copies (default) the source blob into `blobs/<id>.<ext>` via `writeFileAtomic` and appends the record to `index.jsonl`. `sha256Hex` over the bytes is the **dedup key**: if a record with the same sha already exists, `register` returns the EXISTING record (idempotent, no duplicate blob) — this is the "dedup/versioning" axis. `copy:false` registers an in-place reference (path must already be jailed; bytes not copied — used when the generation tool's versioned-sibling path is itself the canonical location).
- `index.jsonl` is the durable registry; an in-memory map is rebuilt by replaying it on first access. `destroy` appends a tombstone line (`{id, tombstone:true}`) and unlinks the blob — newest-wins replay hides destroyed ids (same tombstone discipline memory records for fallback/sessions).

### 4.4 Preview handle

Phase 1/2 preview is a **local `file://` URL** (`getPreview` → `{kind:"file", url:"file://"+abs, path}`), mirroring `CanvasGetUrlResult.url` but local. The model/CLI gets a clickable handle without any server. Phase 3 reserves `kind:"http"` for an optional localhost preview server (see §7/§8) — explicitly NOT built now, because a real preview URL is a security surface (§8).

### 4.5 How generation tools register output

Generation tools stay the chokepoint owners; registration is a thin, OPTIONAL post-write step:

1. `image_gen` / `*_write` write bytes through their existing jailed-write seam (unchanged).
2. When an injected `ArtifactStorePort` is present on the tool's options (default `undefined` ⇒ no-op ⇒ byte-identical), the tool calls `store.register({ sourcePath: writtenAbs, kind, mime, sourceTool, title })` with `copy:false` (the versioned-sibling file IS the canonical blob; the store references it and records metadata).
3. The returned `artifact_id` is surfaced in the tool's text `output` (e.g. `wrote hero.png (artifact: art_…)`) so the model SEES the handle in the same turn — the transcript carries the *id*, never the bytes.

This keeps the store OFF the hot path: the port is `undefined` unless wired, identical to how `ImageGenPort`/`officeAuthoring` are conditionally wired in `buildDefaultTools` (`src/tool/index.ts:492`).

### 4.6 How the model references an artifact later

A dedicated `artifact_*` tool surface (see §5) lets the model, in a LATER turn, call `artifact_list` (enumerate what was produced) and `artifact_get`/`artifact_open` (resolve id → metadata + preview handle / read the bytes for re-use, e.g. feed a generated PNG back into `image_gen mode:edit`). Because the id is stable and the blob is in the store (not the cwd, which may have been version-bumped or cleaned), the reference survives across turns and across `cwd` churn — the core value over today's "path-in-text" handle.

---

## 5. 통합

### 5.1 Config knob (default-OFF, byte-identical)

- Add `artifactStore: boolean` to `RuntimeConfig`, parsed `env["QUANTA_ARTIFACT_STORE"] === "1"` (strict, mirroring `imageGen` at `runtime-config.ts:217,538`). Default `false`.
- Add `artifactsDir: string | undefined` (`QUANTA_ARTIFACTS_DIR`) and `artifactStoreMaxBytes` (`QUANTA_ARTIFACT_STORE_MAX_BYTES`, default e.g. 512 MiB, mirroring `DEFAULT_SHADOW_ODB_MAX_BYTES`).
- **OFF ⇒** composition root wires no `ArtifactStorePort`; generation tools get `store: undefined` (no register); the `artifact_*` tools are NOT registered. The default tool menu, every existing tool's behavior, and on-disk layout are **byte-identical** — proven by the existing tool-surface drift guard + a "no `~/.quanta/artifacts/` touched when off" hellgate case.

### 5.2 Tools + tool-surface manifest

Add three GATED entries to `src/tool/surface/manifest.ts` (shape per lines 61–95):

```
artifact_list    gate:{kind:"config-slot", slot:"artifactStore", env:"QUANTA_ARTIFACT_STORE"}  default:{}  risk:"read-only"
artifact_get     …same gate…  default:{}  risk:"read-only"
artifact_destroy …same gate…  default:{}  risk:"mutating"
```

(register is NOT a model-facing tool — it is an internal port the generation tools call; exposing a raw `artifact_register` to the model would let it register arbitrary jailed paths, low value + extra surface. Cursor's `CanvasRegister` is producer-side too.) `default:{}` (opt-in on every surface) because the store spends disk and is a new capability — never auto-seeds, same posture as `image_gen`.

### 5.3 Feature-catalog entry

Add `tools/feature-catalog/features/02-tool-system/C1-canvas-artifact-store.yaml` (schema per `H14a-image-gen.yaml`): `section:2`, `subsystem: Artifact persistence (C1)`, `maturity: L2` (seam) → `L3` once wired, `labels:[surface:cli, category:artifact, default-off]`, `depends_on:[image-gen, office-authoring]`, `config_refs.env:[QUANTA_ARTIFACT_STORE, QUANTA_ARTIFACTS_DIR]`, `config_refs.runtime:[artifactStore]`, evidence.code listing the new files + the touched generation tools + manifest + runtime-config.

### 5.4 CLI / slash

- `/artifacts` (and `quanta artifacts list|open <id>|rm <id>`) — list newest-first (id, kind, mime, bytes, createdAt, sourceTool, title), `open` resolves `getPreview` and opens the `file://` handle, `rm` calls `destroy`. Lives in `src/apps/cli/` calling the store via the composition seam (CLI may not import `@/artifact` directly — reaches it through `@/agent` assembly, per fence).

---

## 6. 테스트 계획

### 6.1 Hellgate (adversarial) — `tests/unit/artifact-store-hellgate.test.ts`

- **id safety:** `get`/`destroy`/`getPreview` with `../../etc/passwd`, `a/b`, NUL byte, leading `-`, 129-char id, empty → typed `invalid-id`, ZERO FS touch (assert no stat/unlink outside `artifactsRoot()`).
- **jailed source:** `register({sourcePath})` with a path outside `artifactsRoot()`/outside jail / symlink-leaf → `jail-error`/`bad-source` (reuse `resolveJailed`/`FsJailError`).
- **lifecycle:** register → get returns the record; destroy → get throws `not-found`; destroy twice → idempotent (no throw); list excludes destroyed ids (tombstone replay).
- **dedup/versioning:** register the SAME bytes twice → one blob, same id returned (sha dedup); register DIFFERENT bytes with same title → two records, two ids.
- **missing-id:** `get`/`getPreview` of a never-registered id → `not-found`; `cleanup` on empty store → 0.
- **LRU retention:** fill past `maxBytes` → `cleanup` evicts oldest-by-createdAt until under cap, never touches anything outside `artifactsRoot()/blobs/`; index replay still consistent after eviction.
- **index corruption resilience:** a malformed `index.jsonl` line is skipped (not fatal), good records still load.
- **determinism:** injected clock ⇒ `createdAt` stable; no `Date.now()`/`Math.random()` in prose or impl (memory discipline) — id uses `crypto.randomUUID` only.

### 6.2 E2E — `tests/unit/artifact-store-e2e-hellgate.test.ts`

- `image_gen` (stub provider) → writes blob → registers → returns `art_…` in output → `artifact_get(id)` resolves the record → `artifact_list` shows it → `image_gen mode:edit` re-reads the blob BY the stored path (cross-turn reference survives a cwd version-bump). Mirrors `tests/unit/image-gen-e2e-hellgate.test.ts`.
- **OFF byte-identical:** with `QUANTA_ARTIFACT_STORE` unset, the same `image_gen` call produces the identical `ToolResult` and touches NO `~/.quanta/artifacts/` path.

---

## 7. 단계

- **Phase 1 — seam (this slice, default-OFF).** `src/artifact/{types,store,index}.ts` (`ArtifactStorePort` + default FS impl + `index.jsonl` registry + sha dedup + LRU cleanup), runtime-config knobs, biome fence rule + arch-scan ratchet, hellgate §6.1, feature-catalog yaml. NO generation-tool change, NO model-facing tool. Pure seam — fully tested in isolation.
- **Phase 2 — wire generation tools + model tools.** Inject the optional `ArtifactStorePort` into `image_gen` + office authoring (register-on-write, `copy:false`, id in output); register `artifact_list`/`artifact_get`/`artifact_destroy` in `buildDefaultTools` (gated); manifest entries; e2e §6.2.
- **Phase 3 — preview + CLI.** `/artifacts` + `quanta artifacts …`; `getPreview` `file://` handle wired to CLI open. OPTIONAL localhost preview server (`kind:"http"`) deferred behind its own knob with the §8 security mitigations — only if a real interactive preview (HTML report / generated app) demands it.

---

## 8. 리스크 / 대안 / 비결정

- **shadow-ODB reuse (rejected — §3.4).** Tempting because it already does `~/.quanta/<…>` blob-ish storage with LRU `cleanup`. Rejected: its identity is git-commit/ref + workspace tree, its content is whole-tree diffs, it has no per-object destroy, and it pulls `@/tool/git`. Force-fitting opaque-id binary blobs onto git commits raises complexity and pollutes rewind semantics. We reuse its *patterns* (closed-port DI, injectable clock, hard-coded canonical paths, LRU+knob, typed error) but a new slice is the lower-complexity decision. **Revisit only if** a future need to *diff/version* artifacts as a tree emerges (unlikely — artifacts are immutable blobs; "versioning" here = new id, not a commit).
- **Retention / cleanup.** Default `512 MiB` LRU is a guess; the honest posture (no-heuristics memory) is to make it a knob (`QUANTA_ARTIFACT_STORE_MAX_BYTES`) and NOT auto-run cleanup on the hot path — `cleanup` is caller-invoked (CLI/closeout), like shadow-ODB. Risk: unbounded growth if never invoked; mitigated by a closeout-time cleanup call (Phase 3) and the cap.
- **Preview-URL security (Phase 3, deferred deliberately).** A `file://` handle (Phase 1/2) leaks only the local path — acceptable for a single-user CLI. An `http://localhost` preview server (Phase 3) is a real surface: it could serve arbitrary registered blobs, and a generated *app* (`app_js`) is untrusted code. Mitigations BEFORE building it: bind 127.0.0.1 only, per-session random path token (not guessable ids), short TTL, content-type pinned from the stored `mime` (never `text/html` for a model-produced blob unless explicitly an `app`/`report` kind), and a default-OFF knob. Until those land, preview stays `file://`.
- **`copy:false` reference vs `copy:true` snapshot.** Referencing the in-cwd versioned sibling avoids byte duplication but the blob can be deleted/edited out from under the record (dangling). `copy:true` (copy into `blobs/`) is durable but doubles disk for large assets. **Undecided default:** lean `copy:false` for Phase 2 (generation tools' versioned-sibling policy already prevents overwrite), with `get` surfacing a `missing`/`stale` flag when the referenced path no longer matches the recorded sha. Revisit if dangling references prove common.
- **register exposed to model?** Decided NO (§5.2) — producer-side only, matching Cursor. Low risk; revisit if a skill needs to register a user-provided file.

---

## 9. 코드 위치 요약

**Create:**
- `src/artifact/types.ts` — `ArtifactRecord`, `RegisterArgs`, `ArtifactKind`, `PreviewHandle`, `ArtifactStorePort`, `ArtifactStoreError`.
- `src/artifact/store.ts` — default FS impl (`index.jsonl` registry, sha dedup, atomic blob write, LRU `cleanup`, injectable clock/fs/baseDir).
- `src/artifact/paths.ts` — `artifactsRoot()`, id validator (sanitizeId-class), ext-from-mime.
- `src/artifact/index.ts` — barrel.
- `src/tool/artifact-tools.ts` (Phase 2) — `artifact_list` / `artifact_get` / `artifact_destroy` (gated, port-injected).
- `tools/feature-catalog/features/02-tool-system/C1-canvas-artifact-store.yaml`.
- `tests/unit/artifact-store-hellgate.test.ts`, `tests/unit/artifact-store-e2e-hellgate.test.ts`.

**Touch:**
- `src/shared/runtime-config.ts` — add `artifactStore` / `artifactsDir` / `artifactStoreMaxBytes` (+ env parse).
- `biome.json` — add `@/artifact` to the `@/tool`-reachable allowlist + global restricted-paths for other slices; arch-scan ratchet for `src/artifact/**`.
- `src/tool/image-gen/tool.ts`, `src/tool/document/authoring/{docx-write,xlsx-write,pptx-write}.ts` (Phase 2) — optional `ArtifactStorePort` injection + register-on-write + id-in-output.
- `src/tool/index.ts` (Phase 2) — `DefaultToolPorts.artifactStore?` + gated registration of `artifact_*` tools, wire store into generation-tool options.
- `src/tool/surface/manifest.ts` (Phase 2) — 3 GATED entries + drift-guard test update.
- `src/apps/cli/**` (Phase 3) — `/artifacts` + `quanta artifacts list|open|rm`.
