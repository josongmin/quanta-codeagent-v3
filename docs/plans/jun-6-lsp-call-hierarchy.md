# RFC: jun-6 — LSP call hierarchy (incoming / outgoing calls)

> Status: **DESIGN (not implemented)** · Author: agent audit · Date: 2026-06-06
> Scope: design doc only. No source file is modified by this RFC.
> Candidate ADRs: 0479 (call-hierarchy wire methods) · 0480 (lsp_incoming/outgoing_calls tools).

---

## 1. 요약 (Summary)

quanta's LSP slice has 8 nav tools (definition / references / hover /
type-definition / implementation / document-symbol / workspace-symbol /
rename), but it has **no call-hierarchy surface**. The question a refactorer
actually asks — *"if I change this function's signature, what calls it (and
therefore breaks), and what does it call?"* — is **not** answerable today.
`lsp_references` is the closest proxy but it conflates read sites, write sites,
imports, and type annotations; it cannot give the *caller→callee* tree that
`callHierarchy/incomingCalls` and `callHierarchy/outgoingCalls` provide (with
the **exact call-site ranges** inside each caller).

This RFC designs **two new wire methods** on `LspPort`
(`incomingCalls` / `outgoingCalls`) and **two new read-only tools**
(`lsp_incoming_calls` / `lsp_outgoing_calls`), mirroring the existing
`lsp_references` / `lsp_implementation` pattern end-to-end (port method →
`base.ts` adapter using the shared `ensureOpen` + `callOrNullOnUnsupported`
machinery → slice-isolated `LspNavSession` method → `positionTool`-style tool →
manifest row → `lsp-bridge` forwarder). It is **strictly additive** and rides
the existing `QUANTA_LSP_TOOLS` knob (default-OFF), so no byte changes occur on
any default surface.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

LSP call hierarchy is a 3-step protocol (standardized since LSP 3.16) that all
three competitors expose:

- **`textDocument/prepareCallHierarchy`** at a position → an array of
  `CallHierarchyItem` (the resolved symbol(s): `name`, `kind`, `uri`, `range`,
  `selectionRange`). This is the **anchor** step — a position resolves to a
  concrete callable item, which the next two requests take as input.
- **`callHierarchyItem/incomingCalls`** → `CallHierarchyIncomingCall[]`, each
  `{ from: CallHierarchyItem, fromRanges: Range[] }` — *who calls this*, plus
  the **exact ranges inside the caller** where the call appears.
- **`callHierarchyItem/outgoingCalls`** → `CallHierarchyOutgoingCall[]`, each
  `{ to: CallHierarchyItem, fromRanges: Range[] }` — *what this calls*, with
  the call-site ranges inside the current function.

Cursor and Codex both surface this through their LSP bridge as a
"change-impact" / "who-calls" affordance; the protocol shape is identical
across servers (pyright, typescript-language-server, rust-analyzer, gopls all
implement `callHierarchyProvider`). The key architectural cue we absorb: **it is
a two-hop request** — `prepareCallHierarchy` first (server resolves the item),
then `incomingCalls`/`outgoingCalls` keyed on that item. We hide both hops
behind one port method each, so the model issues a single tool call with a
`PATH:LINE:CHARACTER` and gets back the caller (or callee) list directly.

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 No call-hierarchy anywhere

`grep -n "callHierarchy\|incomingCalls\|outgoingCalls" src/lsp/adapters/base.ts`
→ **0 hits**. The `initialize` capabilities block
(`src/lsp/adapters/base.ts:634-639`) advertises only `publishDiagnostics` +
`synchronization` — there is **no** `textDocument.callHierarchy` client
capability declared, so even capability-gated servers won't offer it. `LspPort`
(`src/lsp/ports.ts:16-44`) has `definition`/`references`/`hover`/
`typeDefinition`/`implementation`/`documentSymbol`/`workspaceSymbol`/
`prepareRename` and **no** call-hierarchy method. The slice-isolated
`LspNavSession` (`src/tool/lsp_nav/types.ts:90-117`) mirrors that 8-method set,
also with **no** call-hierarchy.

### 3.2 The wire pattern this RFC mirrors (verified, reusable as-is)

The `references` adapter is the exact template:
- `src/lsp/adapters/base.ts:685-704` — `references()` calls `ensureOpen()`,
  then `callOrNullOnUnsupported("textDocument/references", { textDocument:{uri},
  position, context:{includeDeclaration} })`, then null-guards and maps
  `RawLocation[] → Location[]`.
- `callOrNullOnUnsupported` (`base.ts:1180-1192`) is the shared helper that
  converts a server `-32601` "method not supported" into `null` (the
  "unsupported" vs "no hits" split the whole slice depends on — `ports.ts:9-14`).
- `ensureOpen` (`base.ts:1164`) lazily `didOpen`s the document (idempotent).
- `navLocations` (`base.ts:1196-1217`) is the shared body for
  definition/typeDefinition/implementation — a `Location|Location[]|
  LocationLink[]|null` normalizer. Call hierarchy returns a *different* shape
  (`CallHierarchyItem` with name/kind), so it needs its **own** mapper, not
  `navLocations` — but the open→request→null-guard skeleton is identical.

### 3.3 The tool pattern this RFC mirrors (verified)

- `lspNavTools(provider)` (`src/tool/lsp_nav/index.ts:266`) builds the 8 tools;
  `references` is a **hand-rolled** `Tool` (`:275-312`) because it has an extra
  `includeDeclaration` field, while `implementation`/`typeDefinition` use the
  `positionTool` factory (`:213-252`, `:323-337`). Our two new tools take a bare
  `PATH:LINE:CHARACTER` (no extra field) → they fit the `positionTool` factory
  cleanly, like `implementation` (`:331-337`).
- Every nav tool is `isReadOnly: () => true`, `isConcurrencySafe: () => false`
  (`index.ts:232-233`) and **never fails the turn** — it degrades to a clean
  `ok:false` message via `openOrEmitUnavailable` when no server is present.
- `lsp-bridge.ts` adapts the live `LspClient` to `LspNavSession` by a
  method-by-method forwarder (`src/agent/lsp-bridge.ts:237-242`:
  `references`/`implementation` are one-line delegations). Two new forwarders
  slot in identically.

### 3.4 Manifest (verified)

The `lsp_references` group row (`src/tool/surface/manifest.ts:316-332`) lists
the 7 sibling nav tools under `gate:{env:"QUANTA_LSP_TOOLS"}`,
`default:{cli:"opt-in"}`. The two new tools are **read-only** and join this
group; the row's `risk:"mutating"` is the group's max-risk label (rename/format
mutate), so adding two read-only siblings does not change the gate or risk.

**Verdict: NOT superseded.** Call hierarchy is genuinely absent — no port
method, no capability advertised, no tool.

---

## 4. 설계 (Design, closed-port DI)

### 4.1 Two new `LspPort` methods (`src/lsp/ports.ts`)

```ts
/** Callers of the symbol at `pos` (LSP callHierarchy/incomingCalls). Each
 *  entry is one calling function plus the exact call-site ranges inside it.
 *  `null` = server has no callHierarchyProvider / returned null. `[]` = no
 *  callers. */
incomingCalls(filePath: string, pos: Pos, signal?: AbortSignal): Promise<CallHierarchyEntry[] | null>
/** Callees invoked by the symbol at `pos` (callHierarchy/outgoingCalls). */
outgoingCalls(filePath: string, pos: Pos, signal?: AbortSignal): Promise<CallHierarchyEntry[] | null>
```

New normalized type (added to `src/lsp/types.ts`, mirrored into
`src/tool/lsp_nav/types.ts` to keep the slice import-free — the existing
duplicate-types convention, `types.ts:13-18` note):

```ts
export interface CallHierarchyEntry {
  /** The other end of the edge: caller (incoming) or callee (outgoing). */
  name: string
  kind: SymbolKind        // reuse the existing SymbolKind union (types.ts:25)
  /** Owning file URI of that function. */
  uri: string
  /** The callable's full range (declaration + body). */
  range: Range
  /** Identifier-only range (navigate-to). */
  selectionRange: Range
  /** The exact call-site ranges (LSP `fromRanges`) — for incoming, the spots
   *  inside `name` that call us; for outgoing, the spots inside US that call
   *  `name`. This is the "what breaks where" payload. */
  fromRanges: Range[]
}
```

### 4.2 Adapter (`src/lsp/adapters/base.ts`) — two-hop, shared skeleton

A private `callHierarchy(method, filePath, pos, signal)` helper mirrors
`navLocations` (`base.ts:1196`) but does the **prepare → resolve** two-hop:

```
1. uri = await this.ensureOpen(filePath, signal)                 // base.ts:1164
2. items = await callOrNullOnUnsupported(                        // base.ts:1180
     "textDocument/prepareCallHierarchy", { textDocument:{uri}, position:pos }, signal)
   if (items == null) return null            // no callHierarchyProvider
   if (!Array.isArray(items) || items.length === 0) return []
3. // resolve ALL prepared items (overloads/ambiguity), flatten:
   for (const item of items as RawCallHierarchyItem[]) {
     raw = await callOrNullOnUnsupported(method, { item }, signal)  // method =
       // "callHierarchyItem/incomingCalls" | "...outgoingCalls"
     map each {from|to, fromRanges} → CallHierarchyEntry (toCallEntry)
   }
4. return flattened CallHierarchyEntry[]   ([] if every resolve was empty)
```

`incomingCalls` reads `entry.from`; `outgoingCalls` reads `entry.to`. A new pure
mapper `toCallEntry(item, fromRanges)` reuses the existing `toRange`
(`base.ts`) + `SYMBOL_KIND` map (`base.ts:~50`) — no new normalization
primitives. The "unsupported→null vs empty→[]" split falls out of
`callOrNullOnUnsupported` for free (`base.ts:1180-1192`).

**Capability advertisement (required).** Add `callHierarchy:{
dynamicRegistration:false }` under `textDocument` in the `initialize`
capabilities (`base.ts:634-639`). Without it, spec-strict servers may withhold
the provider. This is the **one** change to an existing code path; it is purely
additive to the capabilities object (no behavior change for diagnostics/nav).

### 4.3 Closed-port DI

Nothing new to inject — the slice already runs against an injected
`LspNavProvider` (`src/tool/lsp_nav/types.ts:125-129`) and the bridge forwards
to a live `LspClient`. The clock/exec/process boundaries are already owned by
the existing adapter (`Bun.spawn` of the server, `sendRequest` correlation,
`requestTimeoutMs`). The two new session methods are pure additions to the
`LspNavSession` interface; the **fake provider** used in unit tests
(`nullLspNavProvider`, `index.ts:255-258`, plus test fakes) gains two scripted
methods. No real server is needed in the default gate.

### 4.4 Two tools (`src/tool/lsp_nav/index.ts`)

Built with the existing `positionTool` factory (`index.ts:216-252`) — bare
`positionSchema` (PATH:LINE:CHARACTER 1-based), `isReadOnly:true`,
`isConcurrencySafe:false`, never-fail-the-turn degradation:

```ts
const incomingCalls = positionTool<PositionInput>(
  "lsp_incoming_calls", positionSchema,
  (s, fp, pos, _i, signal) => s.incomingCalls(fp, pos, signal),
  (_i, _abs, entries: CallHierarchyEntry[] | null) =>
    formatCallHierarchy("incoming", entries),
  provider)
const outgoingCalls = positionTool<PositionInput>(
  "lsp_outgoing_calls", positionSchema,
  (s, fp, pos, _i, signal) => s.outgoingCalls(fp, pos, signal),
  (_i, _abs, entries) => formatCallHierarchy("outgoing", entries),
  provider)
```

A new pure `formatCallHierarchy(dir, entries)` (sibling of the existing
`formatLocations`, `index.ts:271`) renders one line per edge:
`<name> (<kind>) — <uri>:<line> · N call site(s) [line:col, …]`, and emits the
"no language server available" / "no callers found" clean messages on
`null` / `[]` respectively. Both tools join the returned list at `index.ts:426`.

`lsp_incoming_calls` description: *"PREFER over grep when answering 'if I change
this function, what breaks?' — given PATH:LINE:CHARACTER on a function, returns
every CALLER with the exact call-site lines. Semantic; follows imports/aliases;
no name-shadow false positives."* `lsp_outgoing_calls`: *"What does this
function call? Returns each callee + the call-site line inside this function."*

### 4.5 Bridge forwarders (`src/agent/lsp-bridge.ts`)

Two one-liners in `adaptToNavSession` (`lsp-bridge.ts:237-242`), beside the
existing `references`/`implementation` delegations:

```ts
incomingCalls: (file, pos, signal) => client.incomingCalls(file, pos, signal),
outgoingCalls: (file, pos, signal) => client.outgoingCalls(file, pos, signal),
```

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF, no new knob)

Both tools ride the **existing** `QUANTA_LSP_TOOLS` env-flag gate
(`manifest.ts:327`), `default:{cli:"opt-in"}`. No new config slot — they are
siblings in the existing `lsp_references` group. Default surfaces are
**byte-identical** (the group is opt-in; absent the flag, no LSP tool registers).

### 5.2 Manifest rows

Append `"lsp_incoming_calls"` and `"lsp_outgoing_calls"` to the `group:[…]`
array of the `lsp_references` row (`manifest.ts:318-325`). No new top-level row,
no gate/risk change (read-only siblings under an already-`mutating`-labeled
group). The two-way drift guard
(`tests/unit/tool-surface-manifest-hellgate.test.ts`) requires every registered
tool name to appear in the manifest — so both names MUST be added there or CI
fails (the guard that caught `apply_patch_structured` as an fc-orphan).

### 5.3 Feature catalog (fc)

One fc node **"lsp-call-hierarchy"** on the feature axis + the two manifest
group entries on the tool-access axis, keeping the bidirectional fc↔manifest
guard green.

### 5.4 Fence

`src/tool/lsp_nav/` MUST NOT import `@/lsp` (the slice-isolation rule the
duplicate `Nav*` types exist for, `types.ts:4-11`). The new `CallHierarchyEntry`
is therefore declared **twice** (normalized `@/lsp/types` + slice `Nav*`
mirror), structurally compatible — exactly how `NavLocation`/`Location` already
coexist. The bridge (`@/agent/lsp-bridge`) is the only cross-slice adapter and
already does the forwarding.

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (adversarial, fake-provider — no real server)

A `FakeLspNavSession` scripting `incomingCalls`/`outgoingCalls`:
- **unsupported→null:** session returns `null` → tool emits "no language server
  / capability" clean `ok:false`, never throws (the `ports.ts:9-14` invariant).
- **empty→[]:** `[]` → "no callers found" (distinct from unsupported).
- **fromRanges fidelity:** an entry with 3 `fromRanges` renders exactly 3
  call-site `line:col`s, in order, no dedup-loss.
- **two-hop prepare ambiguity:** `prepareCallHierarchy` returns 2 items
  (overloads) → both resolved + flattened, no item dropped.
- **prepare empty:** `prepareCallHierarchy` → `[]` ⇒ tool returns "[]" path, not
  null (we DID resolve, there were just no callable items).
- **abort:** `ctx.signal` pre-aborted → "aborted before start" (matches
  `index.ts:235-237`).
- **default-OFF:** with `QUANTA_LSP_TOOLS` unset, neither tool registers (assert
  against the real assembler).

### 6.2 Adapter unit (canned JSON-RPC, no subprocess)

Override the capture seam (`base.ts:1149` note: subclasses may capture sent
messages) and feed canned `prepareCallHierarchy` + `incomingCalls` responses:
- `-32601` on `prepareCallHierarchy` → `null` (server lacks provider).
- a `CallHierarchyIncomingCall[]` with `from` + `fromRanges` maps 1:1 to
  `CallHierarchyEntry`; verify `name`/`kind`/`uri`/`fromRanges` exact.
- `outgoingCalls` reads `to` (not `from`) — assert the field selection.

### 6.3 e2e (pyright/tsserver-gated — skip if binary absent)

1. Fixture: `function foo(){} function bar(){ foo() } function baz(){ foo() }`.
2. `lsp_incoming_calls` on `foo` → callers `bar`, `baz`, each with a call-site
   range. `lsp_outgoing_calls` on `bar` → callee `foo` with the inner range.
Matches the smoke tier-1/live split — live runs only where the server exists.

---

## 7. 단계 (Phasing)

- **Phase 1 (shippable unit).** `incomingCalls`/`outgoingCalls` on `LspPort` +
  `LspNavSession`; the `callHierarchy` two-hop helper + `toCallEntry` mapper in
  `base.ts`; the `callHierarchy` client-capability line; the two `positionTool`
  tools + `formatCallHierarchy`; two bridge forwarders; manifest group entries +
  fc node; fake-provider hellgate + adapter unit. Default-OFF.
- **Phase 2 (optional polish).** A `depth`/recursion knob to expand the
  hierarchy 2 levels (Cursor/Codex render a tree, not just direct edges).
  Deferred — direct edges answer "what breaks if I change this signature," which
  is the whole ask; recursion is a strict superset and not needed for v1.

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **Server support varies.** Not every language server implements
  `callHierarchyProvider`. Mitigated entirely by the existing unsupported→null
  contract (`callOrNullOnUnsupported`, `base.ts:1180`): on an unsupporting
  server the tool degrades to a clean message, never an error. pyright +
  typescript-language-server (the two configured adapters, `pyright.ts` /
  `typescript.ts`) both support it.
- **Two round-trips per call** (prepare + resolve, ×items). Bounded by the
  existing `requestTimeoutMs` (`base.ts:1102` note) and `ensureOpen` caching
  the `didOpen`. No new unbounded loops. We resolve every prepared item to
  handle overloads — bounded by the (small) item count the server returns.
- **Alternative — reuse `lsp_references` and label.** Rejected: `references`
  cannot distinguish a *call* from a type annotation / import / read, and gives
  no `fromRanges`-style call-site grouping. Call hierarchy is the semantically
  correct primitive for "what breaks if I change the signature."
- **Alternative — collapse into one `lsp_calls(direction)` tool.** Rejected to
  mirror the existing one-tool-per-nav-concept convention (`lsp_references` vs
  `lsp_implementation` are separate tools); two clearly-named tools read better
  to the model than a mode flag.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (this RFC, when implemented):**
- `src/lsp/types.ts` — `CallHierarchyEntry` (normalized).
- `src/tool/lsp_nav/types.ts` — `NavCallHierarchyEntry` mirror + 2 new
  `LspNavSession` methods (`incomingCalls`/`outgoingCalls`).
- `src/lsp/ports.ts` — 2 new `LspPort` methods.
- `src/lsp/adapters/base.ts` — `callHierarchy()` two-hop helper + `toCallEntry`
  mapper + `incomingCalls`/`outgoingCalls`; `callHierarchy` client capability in
  the `initialize` block (`:634`).
- `src/tool/lsp_nav/index.ts` — 2 `positionTool` tools + `formatCallHierarchy`.
- `src/agent/lsp-bridge.ts` — 2 forwarders in `adaptToNavSession` (`:237`).
- `docs/decisions/0479-lsp-call-hierarchy.md` + `0480-call-hierarchy-tools.md`.

**Touched (gate-wiring only):**
- `src/tool/surface/manifest.ts:318-325` — add 2 names to the `lsp_references`
  group array.
- fc node + `tests/unit/tool-surface-manifest-hellgate.test.ts` (drift guard).
- new `tests/.../lsp-call-hierarchy.hellgate.test.ts` + gated e2e.

**Audited ground truth (cited, NOT modified):**
- `src/lsp/ports.ts:16-44` — `LspPort` (no call hierarchy).
- `src/lsp/adapters/base.ts:685-704` (references), `:1180-1217`
  (`callOrNullOnUnsupported` + `navLocations`), `:634-639` (capabilities).
- `src/tool/lsp_nav/index.ts:216-252` (positionTool), `:266-337` (tool build),
  `:275-312` (references tool).
- `src/tool/lsp_nav/types.ts:90-129` (`LspNavSession` / `LspNavProvider`).
- `src/agent/lsp-bridge.ts:237-242` (forwarders).
- `src/tool/surface/manifest.ts:316-332` (`lsp_references` group row).
