# RFC: G3 — native computer-use (desktop screenshot + mouse/keyboard control)

> Status: **DESIGN (not implemented) · DEFER** · Author: agent audit · Date: 2026-06-06
> Scope: design doc only. No source file is modified by this RFC.
> Candidate ADRs: 0487 (computer-use port + screen-capture) · 0488 (input-injection adapter) — number assigned at impl time.
> Tier: **G (§7 카테고리 갭)** — Tauri/desktop-only, high security surface, high-cost. RIGHT-SIZED sketch with an HONEST defer verdict.
> Cross-ref: this is the §5 niche already recorded as the intentionally-deferred "screen / computer-use" gap (F11, see §2.3).

---

## 1. 요약 (Summary)

G3 is **native desktop control** — let the model **see the whole OS screen** (not just a
browser page) and **drive real mouse + keyboard** to operate arbitrary native apps. This is
the Claude/Codex/Cursor "computer use" / "computer-use.app" capability: a loop of
`screenshot → reason → click/type at (x,y) → screenshot → …` over the *operating system*,
via macOS **ScreenCaptureKit** (capture) + **Accessibility (AXUIElement) / CGEvent**
(input injection).

**The honest framing (this RFC's job):** quanta already has the *browser-scoped* analogue
of this loop — `browser_screenshot` + `browser_click`/`browser_type` over CDP — which
covers most agentic UI work safely inside a sandboxed Chromium. G3 extends that loop from a
*browser page* to the *whole desktop*, and that extension crosses two hard lines: (1) it is
**Tauri/desktop-only** (the CLI surface has no screen to capture and no OS input bus to
drive), and (2) it is the **highest-security-surface feature in the product** — a model
moving the real cursor and typing into any focused app can do anything the human user can.
The recommendation is **DEFER** until a desktop (Tauri) host exists and a hard permission
posture is designed. This is already the §5/F11 intentionally-deferred niche; this RFC
records what absorbing it would take and the cheapest safe slice.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

### 2.1 Claude — Desktop computer_use + image block (verified, in corpus)

The 4-way comparison records Claude as **"Desktop computer_use + image block"**
(`docs/analysis/경쟁사리뷰/code-agent-loop/quanta-comparison.md:541`, F11 row) — a desktop
IPC capability that screenshots the OS and injects input, distinct from in-browser tools.
Claude Desktop's IPC surface ([[claude-desktop-1-7196-catalog]]) is the host that makes
this possible — a native shell with privileged OS access, not a CLI.

### 2.2 Codex — computer-use / browser directories (verified)

Codex ships a **computer-use** capability and a browser engine set
([[codex-feature-catalog-2026-05-21]]: "computer-use/browser 디렉터리 보유",
comparison.md:551, :541 "Desktop computer_use + image block"). Codex pays for a native
desktop host + OS sandbox (Seatbelt, [[codex-seatbelt-sandbox-profile]]) to contain it.

### 2.3 The §5/F11 niche (quanta's own recorded posture)

`quanta-comparison.md:541` (F11) states it plainly: **"스크린·computer_use는 ❌(scope)"** /
**"screen/computer-use만 의도적 미보유"** — image *input* is covered (`read_image`), but
**screen capture + computer-use is the deliberately-unbuilt niche**, all three competitors
have it, quanta scoped it out. G3 = the concrete RFC for that recorded gap.

### 2.4 Synthesis (what G3 would absorb, and the safety lineage)

| Concern | Claude/Codex | quanta has today | G3 adds |
|---|---|---|---|
| Capture | OS screenshot (Desktop) | `browser_screenshot` (page only) | **whole-screen** via ScreenCaptureKit |
| Input | mouse/keyboard inject | `browser_click`/`browser_type` (DOM) | **OS-level** CGEvent / AX |
| Containment | Seatbelt / OS sandbox | browser net-guard + CDP allowlist | **needs an OS permission posture** |
| Host | native desktop app | CLI + Tauri shell | **Tauri-only** |

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 The browser-scoped loop exists (the safe, sandboxed analogue)

- Capture: `browser_screenshot` → PNG **as a vision image** (`src/tool/browser/index.ts:186-222`,
  4MB cap `MAX_SCREENSHOT_BYTES` `:58`), over `BrowserPort.screenshot`
  (`src/browser/port.ts:101`), backed by real CDP (`src/browser/cdp-adapter.ts`).
- Input: `browser_click` / `browser_type` operate on **accessibility-tree refs** from
  `browser_snapshot` (`index.ts:117` — refs valid only until the page changes), NOT raw
  pixel coordinates. This is the sandboxed, structured version of "computer use."
- Vision input: `read_image` (`src/tool/image/read.ts:233`, BASE/always-on) +
  `read_image_url` — the model can already *see* images; the gap is OS-screen capture, not
  vision.

### 3.2 There is NO OS-level capture or input injection

- `grep -rln "ScreenCaptureKit\|CGEvent\|AXUIElement\|screencapture\|computer_use" src` →
  matches are **prose only** (skill docs / prompt-body mentioning "screenshot" as a word) —
  **no implementation**. There is no native module, no FFI, no OS input bus.
- The only "screenshot" that produces pixels is the **browser-page** one
  (`cdp-adapter.ts` Page.captureScreenshot). Nothing captures the desktop.
- No Tauri/native host code drives the OS — the desktop surface is a shell
  ([[surface-model]], [[claude-desktop-1-7196-catalog]] is a *reference*, not quanta code).

### 3.3 What G3 requires that is entirely absent

A ScreenCaptureKit (or `CGWindowListCreateImage`) capture adapter, a CGEvent/AX input-
injection adapter, a Tauri native bridge to call them, and a **permission/containment
posture** for a model driving the real desktop. None exist; G3 is a new native subsystem
gated to a desktop host.

---

## 4. 설계 (Design — sketch)

### 4.1 Reuse the browser loop's *shape*, swap the backend

The model-facing loop is identical to the existing browser one (screenshot → reason →
act → screenshot); only the port backend changes from CDP-page to OS-desktop. A single
closed port:

```
interface ComputerUsePort {
  screenshot(opts?: { display?: number }): Promise<Uint8Array>      // ScreenCaptureKit
  cursorTo(x: number, y: number): Promise<void>                     // CGEvent move
  click(button: "left"|"right", x: number, y: number): Promise<void>
  type(text: string): Promise<void>                                 // CGEvent keystrokes
  key(combo: string): Promise<void>                                 // e.g. "cmd+space"
  bounds(): Promise<{ width: number; height: number; displays: DisplayInfo[] }>
}
```

quanta owns the **tool/loop layer** (pure, testable against a `FakeComputerUsePort`); the
**native adapter** (ScreenCaptureKit + CGEvent, behind a Tauri command) is the desktop-only,
privileged part injected at the desktop composition root.

### 4.2 Security posture (the design's center of gravity)

This is the highest-trust tool in the product; the posture is the hard part, not the I/O:
- **Per-action HITL by default.** Every `click`/`type`/`key` flows through the permission/
  HITL classifier (the way dangerous `exec_command` does, `manifest.ts:167`). A model
  typing into a focused banking app must prompt.
- **Coordinate-bound + screenshot-attested.** An action carries the screenshot seq it was
  reasoned from; if the screen changed since, the action fails-closed (stale-frame guard) —
  mirrors the browser `snapshot` "ref valid only until the page changes" invariant
  (`index.ts:117`).
- **Capture redaction option.** A capture-time blur/exclude list (don't ship the password
  manager window to the model) — a knob, default conservative.
- **OS sandbox alignment.** On macOS, screen-capture + accessibility are themselves
  OS-permission-gated (TCC); quanta inherits that as a second fence. The Codex Seatbelt
  posture ([[codex-seatbelt-sandbox-profile]]) is the reference for containing the host.

### 4.3 Closed-port DI + Fake adapter

`FakeComputerUsePort` returns scripted frames + records injected events → hellgate runs
with no real screen/mouse (CI-safe, deterministic). The real adapter is Tauri-only.

---

## 5. 통합 (Integration)

- **Knob (default-OFF, OFF on every surface):** gate `QUANTA_COMPUTER_USE` + a mandatory
  sub-slot `computerUse.confirmEveryAction` (default `true`). It never auto-seeds anywhere —
  it is the most dangerous capability in the catalog.
- **Surface gating (intrinsic, not policy):** **Web-Tauri-only.** The CLI and CLI-embedded-
  browser surfaces have no OS screen to capture and no input bus to drive
  ([[surface-model]]). Unlike most features, the surface gate here is *physical*, not an ROI
  choice — there is literally nothing to control on a headless CLI.
- **Tool surface:** new `computer_use` group (risk `exec`, the most-restrictive class) in
  `src/tool/surface/manifest.ts`, with a `note` that it is desktop-only + per-action-HITL,
  plus the feature-catalog node for the drift guard. Mutating OS-input ops are `exec`;
  `screenshot`/`bounds` are `read-only` (still gated, capture is sensitive).

---

## 6. 테스트 계획 (Test plan — sketch)

- **Hellgate (FakeComputerUsePort, deterministic):** every `click`/`type`/`key` routes
  through HITL when `confirmEveryAction` is on (no silent action); a stale screenshot-seq
  action fails-closed; coordinates outside `bounds()` are rejected; capture redaction list
  is honored; default-OFF (`QUANTA_COMPUTER_USE` unset ⇒ no registration).
- **Surface guard:** on a non-Tauri surface the tool is structurally unavailable (assert the
  assembler never wires it there).
- **No live test in CI** — driving a real screen/mouse is non-deterministic and unsafe in
  CI; any live verification is a manual, gated, desktop-only check.

---

## 7. 단계 (Phasing)

- **Phase 0 — this RFC (record only).** The §5/F11 niche, scoped. **No code.** (Current
  recommendation stops here.)
- **Phase 1 — read-only capture (cheapest safe slice, only when a Tauri host exists).**
  `screenshot()` + `bounds()` only — the model can *see* the desktop but **cannot act**.
  This delivers real value (visual context / "what's on screen") at a fraction of the risk,
  since no input is injected. Per-capture redaction + TCC permission inherited.
- **Phase 2 — input injection (high-cost, high-risk).** `click`/`type`/`key` with mandatory
  per-action HITL + stale-frame guard. This is where the security design earns its keep and
  the cost concentrates.

---

## 8. 리스크 / 대안 (Risks / alternatives — biggest section, and the verdict)

- **Why it's high-cost:** (1) **Tauri/desktop-only native code** — ScreenCaptureKit +
  CGEvent + AX via a Tauri bridge; none of quanta's adapters touch OS-level capture/input
  today (§3.2), so it is a from-scratch native subsystem, per-OS (macOS first; Linux X11/
  Wayland + Windows are separate ports). (2) The **security posture is the bulk of the
  work**, not the I/O — a model driving the real cursor/keyboard can do *anything the human
  can* (drain accounts, delete files, send messages). HITL design, stale-frame attestation,
  capture redaction, and OS-sandbox alignment are all required before any input op ships.
- **Cheapest safe slice:** **Phase 1 — read-only desktop capture** (`screenshot`+`bounds`,
  no input). It gives the model visual desktop context with **no ability to act**, so the
  blast radius is "can see your screen" (still sensitive, but bounded). It is the only slice
  that could be justified before a full input-security design — and even it requires a Tauri
  host + TCC permission + redaction.
- **DEFER — the honest verdict. Defer-unless BOTH:** (1) a real Web-Tauri desktop host
  exists to provide the native bridge + a place to render confirmations (it does not today,
  §3.2); **and** (2) a hardened permission posture (per-action HITL + stale-frame guard +
  redaction + OS-sandbox alignment) is designed and reviewed. Absent the Tauri host, there
  is **nothing to capture or control** — the feature is physically unbuildable on the CLI
  surface. This matches the existing §5/F11 "의도적 미보유 (scope)" posture; G3 does not
  change that recommendation, it documents the path.
- **Security is the deciding factor (why even Phase 1 is gated).** Screen capture can leak
  passwords, tokens, private messages; input injection is full remote-control. This is the
  one capability where "default-OFF" is insufficient — it needs default-OFF **plus**
  per-action HITL **plus** OS-permission **plus** redaction, all of which is a deliberate,
  reviewed posture, not a knob flip.
- **Alternative — stay browser-scoped (recommend this; already shipped).** The
  `browser_screenshot` + `browser_click`/`browser_type` loop (§3.1) covers the large
  majority of agentic UI tasks **inside a sandboxed Chromium** with an SSRF/protocol guard
  and a CDP allowlist (`index.ts:5`, `cdp-allowlist.ts`). For "operate a web UI," this is
  strictly safer and already exists. G3's marginal value is only "operate *native* apps,"
  which is a narrow need against a very large risk. **Prefer browser-scoped; defer G3.**
- **Alternative — coordinate-free AX-tree control instead of pixel clicks.** If G3 is ever
  built, prefer driving via the Accessibility tree (named elements) over raw `(x,y)` pixel
  clicks — mirroring how `browser_click` uses snapshot refs, not coordinates (`index.ts:117`).
  AX-tree control is more robust and more auditable (you log "clicked button 'Send'", not
  "clicked 412,330"). Pixel control is the fallback, not the default.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (only if Phase 1+ is ever undertaken, Tauri host required):**
- `src/tool/computer-use/` — `port.ts` (`ComputerUsePort`), `loop.ts` (screenshot→act,
  imports only `zod` + the port), `fake.ts` (test double), `tools.ts` (gated tools).
- A **native Tauri adapter** (ScreenCaptureKit + CGEvent), injected at the desktop
  composition root — lives outside the pure slice. + an ADR at impl time.

**Touched (gate-wiring only, when built):**
- `src/tool/surface/manifest.ts` — `computer_use` group (risk `exec`, Tauri-only,
  per-action-HITL note) + feature-catalog node + drift-guard test.

**Audited ground truth (cited, NOT modified) — the safe analogue + the gap:**
- `src/tool/browser/index.ts:58,117,186-222` + `src/browser/port.ts:101` +
  `src/browser/cdp-adapter.ts` + `src/browser/cdp-allowlist.ts` — the browser-scoped,
  sandboxed loop G3 extends to the OS (and the recommended alternative).
- `src/tool/image/read.ts:233` — vision input already covered (the gap is OS capture, not vision).
- `docs/analysis/경쟁사리뷰/code-agent-loop/quanta-comparison.md:541` (F11) — the recorded
  §5 "screen/computer-use 의도적 미보유 (scope)" niche this RFC formalizes.
- [[surface-model]] + [[codex-seatbelt-sandbox-profile]] + [[claude-desktop-1-7196-catalog]]
  — surface posture + the OS-containment reference + the competitor desktop host.
