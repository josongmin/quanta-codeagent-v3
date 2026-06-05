# RFC: G1 — appgen / appshot (spec → shareable web-app + screenshot-verify loop)

> Status: **DESIGN (not implemented)** · Author: agent audit · Date: 2026-06-06
> Scope: design doc only. No source file is modified by this RFC.
> Candidate ADRs: 0487 (appshot verify-loop core) · 0488 (app scaffold/render adapter) · 0489 (share surface) — next free after 0486.
> Tier: **G (§7 카테고리 갭)** — large, surface-gated, high-cost. RIGHT-SIZED sketch, not a full design.

---

## 1. 요약 (Summary)

quanta already owns the two halves of a generation→verification loop in **separate
slices** that have never been joined into a closed feedback cycle:
- a **binary-artifact GENERATION axis** — `image_gen` (`src/tool/image-gen/tool.ts:506`,
  text→image), Office authoring (`src/tool/document/authoring/`), and the Canvas/artifact
  store (`src/artifact/registry.ts`) that holds the outputs outside the transcript; and
- a **render + screenshot capability** — `browser_screenshot`
  (`src/tool/browser/index.ts:186-222`) drives a real headless Chromium via CDP
  (`src/browser/cdp-adapter.ts`) and returns a PNG **as a vision image** the model can
  then "see."

**G1 — appgen/appshot** is the desktop extension of that generation axis: take a natural-
language **spec → scaffold a small web app → render it → screenshot it → feed the shot
back to the model → iterate until it matches the spec**, then expose a **share surface**
(a URL / bundle the user can open). It is the appgen pattern (v0.dev / Claude Artifacts /
Cursor's preview pane) realized as a **closed verify loop** rather than a one-shot codegen.

**The honest framing:** the *verify loop* is cheap because both ends already exist
(`image_gen`/authoring to generate, `browser_screenshot` to observe). The *share surface*
and a polished live-preview are the high-cost, Tauri/desktop-gated parts. This RFC's job
is to record the cheapest viable slice (**the screenshot-verify loop alone, reusing the
browser surface**) and to defer the share/preview surface until a desktop host justifies
it.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

### 2.1 v0.dev — spec→app→preview (already partially absorbed)

quanta absorbed v0's `defineTool out-schema` and `plan 3-way` shapes
([[v0-dev-absorption-2026-05-21]], ADR-0060-0065). The piece **not** absorbed is v0's
core product loop: a spec compiles to a runnable web app rendered in an **iframe preview**,
and the model iterates on the rendered result. The render-and-look-back step is the
load-bearing novelty — code that "looks right" as text frequently renders broken.

### 2.2 Claude Artifacts / Cursor preview pane

- **Claude Artifacts** — a generated single-file HTML/React artifact rendered in a
  sandboxed iframe, shareable by link. The artifact is a **first-class output object**,
  not transcript text — quanta's `src/artifact/registry.ts` (`quanta-artifact://<id>`
  preview URL) is the matching primitive already in place.
- **Cursor** — a live preview pane + screenshot-to-fix; the model captures the rendered
  DOM and reasons over pixels, exactly the `browser_screenshot`→vision path quanta has.

### 2.3 Synthesis (what we absorb)

| Concept | Competitor | quanta has today | G1 adds |
|---|---|---|---|
| spec→code | v0/Artifacts | `image_gen`/authoring (other media only) | a web-app scaffold target |
| render | iframe/preview | `browser_navigate` (CDP) | navigate to the scaffolded app |
| observe | screenshot-to-fix | `browser_screenshot`→vision | the **loop** binding observe→edit |
| persist output | artifact object | `src/artifact/registry.ts` | register the app bundle as an artifact |
| share | link/iframe | — (gap) | the share surface (deferred, §8) |

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 The generation axis exists, but stops at single artifacts (no app target)

- `image_gen` (`src/tool/image-gen/tool.ts:506`, gate `QUANTA_IMAGE_GEN`,
  `manifest.ts:489-499`) — text→image / edit, writes a versioned-sibling jailed path.
- Office authoring (`src/tool/document/authoring/{xlsx,docx,pptx}-write.ts`, gate
  `QUANTA_OFFICE_AUTHORING`, `manifest.ts:514`) — pure-TS STORED-ZIP OOXML, no dep.
- Canvas/artifact store (`src/artifact/registry.ts`, `index.ts`; gate
  `QUANTA_ARTIFACT_STORE`, `manifest.ts:541`) — list/get/destroy + `quanta-artifact://<id>`
  preview URL. **This is the share primitive** — but it holds files, not a renderable app.
- **Gap:** none of these emit a *runnable web app* (an `index.html` + assets the browser
  can navigate to). The generation axis tops out at one self-contained artifact.

### 3.2 The render + observe half already exists (the cheap reuse anchor)

- `browser_navigate` / `browser_screenshot` / `browser_snapshot`
  (`src/tool/browser/index.ts:70,117,186`) over `BrowserPort`
  (`src/browser/port.ts:43-123`), backed by a **real CDP adapter** that launches
  Chrome/Chromium (`src/browser/cdp-adapter.ts:58-61, 407-419`) or a headless stub
  (`src/browser/headless-stub.ts`).
- `browser_screenshot` returns a PNG **as a vision image**
  (`index.ts:189` "returned as an image for vision"), capped at 4MB
  (`MAX_SCREENSHOT_BYTES`, `index.ts:58`). This is the exact observe step appshot needs.
- `read_image` (`src/tool/image/read.ts:233`) is BASE/always-on — the vision-input side is
  free.

### 3.3 What is missing for a closed loop

There is **no orchestration** that (a) writes a web-app scaffold to a jailed dir, (b)
serves it / navigates to a `file://` or localhost URL, (c) screenshots, (d) hands the shot
back, and (e) loops on a verify verdict. Each tool exists; the **loop binding them does
not**, and there is no **share surface** beyond the in-memory artifact URL.

---

## 4. 설계 (Design — sketch)

### 4.1 Shape: a verify-loop skill, not a new god-tool

appshot is best expressed as a **closed-port loop orchestrator** that *composes existing
tools*, not a monolithic `appgen` tool. The loop:

```
spec ──► scaffold(spec) ──► render(url) ──► screenshot ──► verify(shot, spec)
              ▲                                                   │
              └──────────────── edit(diff) ◄──────────────────────┘  (until pass | maxIter)
```

Each arrow maps to something that exists or is a thin adapter:
- **scaffold** — write `index.html`(+ optional bundle) to a jailed artifact dir via the
  authoring FS-jail chokepoint (`src/tool/document/authoring/jailed-write.ts` pattern).
- **render** — `browser_navigate(file://<dir>/index.html)` (or a local static server for
  apps needing same-origin).
- **screenshot** — `browser_screenshot` → PNG → vision block (already wired).
- **verify** — an LLM-judge turn ("does this rendering satisfy the spec?") yielding a
  typed `{pass, notes}` verdict (reuse the smoke `expect.json` LLM-judge posture,
  [[smoke-fixture-system]]).
- **edit** — feed `notes` back as the next iteration's spec delta.

### 4.2 Closed-port DI

A single injected port keeps the slice fence-clean (no `@/browser`, no `@/agent` import in
the loop core):

```
interface AppshotPort {
  scaffold(spec: AppSpec, outDir: string): Promise<{ entryUrl: string }>
  render(url: string, signal?: AbortSignal): Promise<void>
  screenshot(signal?: AbortSignal): Promise<Uint8Array>   // → browser_screenshot
  verify(shot: Uint8Array, spec: AppSpec): Promise<{ pass: boolean; notes: string }>
}
```

The composition root wires `render`/`screenshot` to the real `BrowserPort`, `verify` to the
LLM-judge, `scaffold` to the jailed writer. Hellgate runs against a `FakeAppshotPort`
(scripted "renders" + deterministic verdicts) — no Chrome, CI-safe.

### 4.3 Output = an artifact, share = an artifact URL (reuse, don't invent)

The scaffolded app registers into `src/artifact/registry.ts` as an artifact, getting a
`quanta-artifact://<id>` URL for free. The **share surface** (a real openable link / a
bundled zip / a Tauri webview) is layered on top of that registry entry — see §8 for why
that layer is the expensive, deferred part.

---

## 5. 통합 (Integration)

- **Knob (default-OFF):** gate `QUANTA_APPSHOT` / slot `appshot.enable`, mirroring the
  `image_gen` opt-in-everywhere posture (`manifest.ts:498`,
  `default: { cli:"opt-in", bench:"opt-in", web:"opt-in", ide:"opt-in", headless:"opt-in" }`).
  It composes `browser_*` (which themselves need Chrome) + spends LLM-judge tokens + writes
  files, so it **never auto-seeds** on any surface.
- **Surface gating:** the *loop* runs anywhere `browser_*` runs (CLI-embedded browser is a
  declared quanta surface, [[surface-model]]). The *live-preview share* is **Web-Tauri-only**.
  Per [[surface-model]], do NOT gate the loop's ROI on a desktop surface — the verify loop
  is surface-portable; only the share pane is Tauri-bound.
- **Tool surface:** one new `appshot` group leader in `src/tool/surface/manifest.ts` (risk
  `mutating` — writes scaffolds), plus the matching feature-catalog node so the two-way
  drift guard (`tests/unit/tool-surface-manifest-hellgate.test.ts`) stays green.

---

## 6. 테스트 계획 (Test plan — sketch)

- **Hellgate (FakeAppshotPort, deterministic):** loop terminates on `pass`; loop hits
  `maxIter` and fails-closed with the last verdict (no infinite loop); scaffold path is
  jail-confined (a `../` escape in the spec is rejected); screenshot > cap is refused
  (reuse `MAX_SCREENSHOT_BYTES` invariant); artifact registered exactly once per run.
- **Default-OFF:** with `QUANTA_APPSHOT` unset, the tool does not register (assert against
  the real assembler).
- **e2e (Chrome-gated, skip if no Chromium):** spec "a red button centered" → scaffold →
  navigate `file://` → screenshot → assert PNG non-empty + ≥ some dimension. Runs only
  where Chromium exists (tier-1/live split, [[smoke-fixture-system]]).

---

## 7. 단계 (Phasing)

- **Phase 1 — the screenshot-verify loop (cheapest viable slice).** `src/tool/appshot/`
  loop core + `AppshotPort` + Fake hellgate, composing existing `browser_*` +
  jailed-write + LLM-judge. Output registers as an artifact (`quanta-artifact://`). **No
  new render engine, no share pane.** This alone delivers "render-and-look-back" — the
  load-bearing novelty.
- **Phase 2 — richer scaffold targets.** Move beyond single-file HTML to a small bundler
  target (a static SPA), behind a local static server for same-origin apps.
- **Phase 3 — the share surface (Tauri/desktop).** A live-preview webview pane + a real
  shareable link/bundle export. **High-cost, desktop-gated — deferred (§8).**

---

## 8. 리스크 / 대안 (Risks / alternatives — biggest section)

- **Why it's high-cost:** the *share surface* is the expensive part. A genuine
  "shareable web app" implies either (a) a hosted endpoint (a server quanta does not run —
  out of scope, security surface), or (b) a Tauri webview preview pane (a desktop host
  feature that does not exist yet). The codegen + verify loop is **not** the cost; the
  product surface around it is.
- **Cheapest viable slice (recommend PROCEED on this slice only):** Phase 1 — the
  screenshot-verify loop reusing `browser_screenshot` + the artifact store. It needs **no
  new dep, no new surface, no server** — it binds tools that already exist into a closed
  cycle, default-OFF. ROI is high precisely because the hard parts (real CDP render, vision
  input, artifact persistence) are already paid for.
- **Defer-unless-X (the honest verdict):** **defer Phases 2-3 unless** the Web-Tauri
  surface ships a webview preview pane (then the share surface is a natural extension) OR a
  concrete user need for shareable links emerges. Until then a scaffolded app is reachable
  only via `quanta-artifact://<id>` + a manual `file://` open — acceptable for the loop,
  insufficient for "share."
- **Browser dependency / flakiness.** The loop inherits Chrome-launch fragility from the
  browser slice (`cdp-adapter.ts:407-419`). Mitigation: Fake-adapter hellgate is the CI
  default; live e2e is gated on a Chromium probe. A render that can't bring up Chrome
  degrades to "verify skipped," not a crash.
- **Verify-loop non-termination / token burn.** An LLM-judge that never says "pass" burns
  tokens. Mitigation: hard `maxIter` cap + the existing objective/token-budget breaker
  ([[observability-and-budget]], ADR-0138) wraps the loop; fail-closed on cap.
- **Untrusted spec → scaffold injection.** A spec could try to scaffold a path escape or
  embed a `file://`/`localhost` SSRF target. Mitigation: scaffold writes through the
  authoring FS-jail chokepoint (`jailed-write.ts`); navigate inherits the browser slice's
  SSRF/protocol guard (`index.ts:5` "SSRF/protocol guard on navigate", `net-guard.ts`).
- **Alternative — a single monolithic `appgen` tool.** Rejected: it would re-implement
  render/screenshot/verify already owned by `browser_*` + artifact slices, violating the
  slice-fence posture. The loop-orchestrator-over-existing-tools shape keeps the fence
  clean and the Phase-1 cost near-zero.
- **Alternative — hosted preview server.** Rejected for now: running a web server to serve
  generated apps is a network/security surface quanta deliberately does not own (cf. F12
  posture). The artifact-URL + `file://` path stays inside the existing jail.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (when implemented):**
- `src/tool/appshot/` — `port.ts` (`AppshotPort`), `loop.ts` (the verify cycle, imports
  only `zod` + the port), `scaffold.ts` (jailed-write adapter), `tools.ts` (the gated
  `appshot` tool). + `docs/decisions/0487-appshot-verify-loop.md`.

**Touched (gate-wiring only):**
- `src/tool/surface/manifest.ts` — new `appshot` group row (risk `mutating`, opt-in
  everywhere) + feature-catalog node + drift-guard test.
- composition root (`@/host/runtime` assembler) — wire `render`/`screenshot` to
  `BrowserPort`, `verify` to LLM-judge; CLI `seedEnvVarsForSurface`.

**Audited ground truth (cited, NOT modified):**
- `src/tool/image-gen/tool.ts:506` + `src/tool/document/authoring/` — the generation axis G1 extends.
- `src/tool/browser/index.ts:186-222` + `src/browser/port.ts:101` + `src/browser/cdp-adapter.ts:407-419` — render+screenshot reuse anchor.
- `src/artifact/registry.ts` + `manifest.ts:541` — the artifact/share primitive.
- `src/tool/surface/manifest.ts:489-541` — the opt-in-everywhere posture for generation tools.
