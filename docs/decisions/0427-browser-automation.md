# ADR-0427 — Browser automation (interactive CDP driving)

**Status:** Accepted (2026-06-01)
**Type:** New capability slice — the last remaining pure functional gap vs Cursor/Codex (interactive browser driving). Plan: `docs/plans/jun-1-browser-automation/{README,ARCHITECTURE,EXECUTION}.md`.
**Scope:** new `src/browser/` (execution channel, plane-clean) + `src/tool/browser/` (model-facing tools + security gates) + `src/agent/tier1/browser.ts` (default-OFF builder). No existing code mutated except a one-line `@/browser` alias in `tsconfig.base.json`.

## Context

`web_fetch` returns static HTML only — it cannot drive a JS-rendered page, click, type, or read a live DOM. Cursor (its own a11y-snapshot tool surface over an Electron-embedded Chromium) and Codex both ship interactive browser automation; quanta did not. This is surface-agnostic — headless CDP runs from the CLI — so it is a genuine capability gap, not a surface-gated one ([[surface-model]]).

The value for a coding agent: it closes the verification loop on the front end. With `verify-guard` (ADR-0067) quanta already refuses to claim success on unverified backend changes; the browser lets the agent *prove* a UI change renders and works, not just claim it.

## Decision

Build a hexagonal slice driving a **system Chrome spawned headless over raw CDP** (no Playwright dependency — installs are blocked and quanta keeps an 8-dep footprint; the `BrowserPort` makes Playwright a drop-in adapter later). Perception is an **accessibility-tree snapshot** (cheaper, more deterministic, and more token-efficient than pixel screenshots); actions are **ref-based** (`click(ref)` over a snapshot-issued opaque handle), with raw coordinate/CDP access available only through a hard gate.

### Architecture

- **`src/browser/` — execution channel, imports ONLY `@/shared`.** `BrowserPort` (no-throw `Result`), two adapters behind it: `cdp-adapter` (production: spawn → DevToolsActivePort discovery → ws CDP → teardown) and `headless-stub` (deterministic, no-IO, for tests/CI). All non-determinism (process spawn, ws transport, fs, timers) is injected via `cdp/ports.ts`, so the adapter logic is unit-tested with fakes — the only un-unit-tested files are the thin Bun-backed `cdp/defaults.ts`.
- **Perception split:** `cdp/collect.ts` `COLLECT_SCRIPT` runs in-page (non-deterministic IO) and returns a serialized `DomModel`; `snapshot.ts` `buildSnapshot` is a **pure** function (`DomModel → YAML`) → byte-stable, hellgate-tested with fixtures. Element refs (`e1`, `e2`…) are monotonic and held **out-of-band** in a `RefMap` — the live DOM is never mutated (Cursor writes `data-cursor-ref`; we do not → zero page pollution + replay-stable refs).
- **`src/tool/browser/` — model-facing layer.** 6 tools (`browser_navigate/snapshot/click/type/screenshot/cdp`) over a lazily-spawned, reused, disposable session handle.

### The five strengthen points (vs Cursor)

| # | Strengthen | Cursor | quanta |
|---|---|---|---|
| 1 | **Closed CDP allowlist as a hard gate** | dangerous methods restricted only in the tool's prose description | `cdp-allowlist.ts` is a closed Set of **6** read-only-introspection methods enforced in code at `port.cdp()`; everything else → `Err{cdp-method-denied}`. ★ R1 audit [17]: `Runtime.evaluate` is DELIBERATELY EXCLUDED from the model surface (it is arbitrary in-page JS that could `fetch()` a private address, defeating the SSRF guard) — the adapter's own snapshot/click/type call it via `session.request` directly, bypassing the allowlist by design. Asymmetric: gates the model-reachable surface only. |
| 2 | **SSRF default-ON + structural classifier + DNS** | origin allowlist is opt-in config | SSRF logic lives once in `@/shared/net/ssrf` (R1 audit [1] — was triplicated). `classifyHost` is a STRUCTURAL IP classifier (R1 audit [15] — handles IPv4-mapped IPv6 `::ffff:7f00:1`, `::1`, link-local, ULA, not just string prefixes). `net-guard.guardNavigationUrl` allows only `http`/`https` and, when a DNS resolver is wired, denies a public NAME resolving to a private address (R1 audit [16]). |
| 3 | **Page text = un-forgeable data** | — | all page-derived text (snapshot, navigate title, cdp output) routed through `escapeBoundary("system-reminder", …)` (`@/agent/untrusted`) so a malicious page cannot forge a `<system-reminder>` boundary. |
| 4 | **Downloads jailed, not blocked** (Phase 2) | `Page.setDownloadBehavior` denied wholesale | will allow downloads via `resolveJailed` into the fs-jail. |
| 5 | **Verb-tiered HITL + dispose lifecycle** | one `browser_lock` + IDE lifecycle | `hitlTier` per verb (navigate/snapshot/screenshot low; click/type/cdp `always-confirm`); the stateful browser handle is disposed on session teardown via the `WiredSearchPipeline.dispose` pattern. |

### Test strategy

Six hellgate batteries + one e2e, all over injected fakes (no real browser): pure snapshot byte-stability + ref monotonicity/prune; CDP allowlist control(7 allowed)+adversarial(16 dangerous denied)+frozen-size; CdpSession correlation/timeout/abort/dispose/garbage (settle-exactly-once); endpoint poll termination + DomModel fail-closed parse + caps; the real `createCdpBrowser` orchestration over fakes against the same `BrowserPort` contract the stub satisfies; the tool layer's gates + lifecycle; and an e2e through the real `ToolRegistry`.

## Negative invariants (do NOT)

- Do **not** write `data-*` ref attributes into the live DOM (Cursor does) — page pollution + non-deterministic tests. Refs live out-of-band in `RefMap`.
- Do **not** enforce the CDP method restriction in prose only — it must be the closed code allowlist.
- Do **not** default to an attach-to-running-Chrome adapter — ambient-authority footgun; spawn an isolated temp profile. (Attach is a legitimate *second* adapter behind the same port, gated on explicit opt-in.)
- Do **not** add `Input.*`/`Storage.*`/`Cookies.*`/`Browser.*`/`Target.*`/`Page.setDownloadBehavior`/`Page.navigate` to the CDP allowlist — those are reachable through the typed verbs under their own gates.

## Status / wiring

Default-OFF but REACHABLE (R1 audit [9]): `buildBrowserBlock` is wired into `features.ts` (tools → registry) and `loop.ts` teardown (`browserDispose`), gated on the duck-typed `config.browser.port` slot. With the slot absent the registry is byte-identical. The remaining operator step (like `web_search`'s provider): the CLI composition root populates `config.browser = { port: createCdpBrowser({ profileRoot: resolveJailed(".quanta/browser", cwd), … }), resolver: nodeDnsResolver }` behind an env gate + `availability()` probe. The `cdp/defaults.ts` Bun primitives are smoke-validated, not unit-tested.

## R1 audit closeout (2026-06-01)

A 4-lens (code-quality / feature-gaps / security / test-quality) parallel audit with adversarial verification surfaced 31 confirmed findings; 29 fixed, 2 consciously deferred. Highlights: shared structural SSRF classifier closing the IPv4-mapped-IPv6 bypass (blocker [15]); `Runtime.evaluate` dropped from the model CDP surface (major [17]); DNS-resolution guard step (major [16]); spawn now tears down the proc+profile on every error/throw/abort path ([4][18][19]); `dispose()` settles in-flight `waitForEvent` waiters (real hang bug [22]); +60 test cases covering previously-unproven error branches.

## R2 audit closeout (2026-06-01)

A second 4-lens audit on the R1-fixed code surfaced 21 confirmed (de-duped to ~16 distinct); all addressed. The notable second-order findings: (1) `dispose()` during an **in-flight** spawn leaked the real Chrome proc+profile — the holder now tracks a `disposed` flag, awaits the in-flight spawn, and self-closes the freshly-spawned handle; dispose is now **terminal** (no resurrection). (5) navigate now subscribes to `Page.loadEventFired` BEFORE issuing `Page.navigate` (subscribe-then-act, kills the fast-load race). (8) Chrome bring-up now sends `Page.setDownloadBehavior:deny`. (6) the slice is now genuinely activatable: `assembleAgentConfig` populates `config.browser` behind `QUANTA_BROWSER_TOOL=on` + an `availability()` chrome-probe double-gate, with `profileRoot = resolveJailed(".quanta/browser", cwd)` and the node DNS resolver. (3) abort signal threaded into the `Page.enable` bring-up. (10) `defaultCdpTransport` cleans up its listeners + closes the socket on abort/error. (13) IPv6 zone-id (`%eth0`) stripped before classification. The `browser_cdp` tool description is now DERIVED from `CDP_ALLOWED_METHODS` so prose cannot drift. +test cases for the dispose-during-spawn leak, rejecting-spawn, endpoint-abort, Page.enable-failure, IPv4-compat, and the full `buildSessionFeatures → browserDispose` wire.

## Wave 4 — interaction verbs + perception (2026-06-01)

Completed the interactive surface beyond the MVP: **`browser_fill` / `browser_select_option` / `browser_scroll` / `browser_press_key` / `browser_drag` / `browser_mouse_click_xy`** (12 tools total). Form controls + contenteditable handled distinctly; `press_key` / `drag` / `mouse_click_xy` dispatch `Input.*` via `session.request` internally (model-unreachable, allowlist-bypass by design); drag resolves a source ref to its element-center point. Perception enriched: the collector now emits `placeholder` + heading `level`, rendered in the snapshot YAML. Downloads are denied at bring-up (`Page.setDownloadBehavior:deny`).

**Final gate:** 165 browser/ssrf/wire tests across 12 files, 0 fail; src tsc 0; biome 0 errors / 0 warnings. Regression: features/loop/assemble/import-cycle green.

## Edge-hardening closeout (2026-06-01)

A 7-dimension parallel edge battery (~334 cases: SSRF/IP forms, CDP protocol envelopes, snapshot/refMap stress, fail-closed parse, net-guard/DNS, tool/abort/cap, e2e injection) surfaced 3 genuine bugs, all fixed + pinned: (1) trailing-dot `localhost.` bypassed the SSRF deny → `normalizeHost` strips the FQDN root dot; (2) array-shaped CDP event params leaked through `routeEvent` (`typeof [] === "object"`) → `!Array.isArray` guard; (3) `parseDomModel` kept a fractional heading `level` (1.5) → `Number.isInteger` guard.

**Suite total: 499 tests across 19 files, 0 fail, 2152 expect() calls; src tsc 0; biome 0/0.**

## Real-chrome e2e closeout (2026-06-01)

A 3-tier e2e build (tier-1 real-chrome happy, tier-3 real-chrome adversarial, tier-2 deterministic agent-loop) against live headless Chrome — observing via a fixture HTTP server's `/report` sink driven by real in-page DOM events (the gated port has no model-reachable `Runtime.evaluate`, so read-back goes through real events + `snapshot`). This caught **3 real bugs the stub could never surface**:

1. 🔴 **Adapter connected to the BROWSER-level DevTools endpoint and called page-only methods** (`Page.enable` → `-32601 not found`), so spawn() failed against every real Chrome. Fixed: bring-up now does `Target.createTarget` + `Target.attachToTarget{flatten:true}` + `session.useSessionId(sessionId)` (flat protocol) before Page.enable — `cdp-session` stamps the `sessionId` on every page-domain request.
2. **`pressKey("Enter")` didn't submit forms** — `Input.dispatchKeyEvent` lacked `windowsVirtualKeyCode`/`code`/`text`. Fixed: a named-key descriptor table populates the virtual-key fields.
3. **fill/type/click didn't focus the element** — so a subsequent Enter went to `<body>`. Fixed: `el.focus()` before fill/type/click (matches real user/automation behavior).

After the fixes, **43 real-chrome assertions pass** (navigate, a11y snapshot, fill/select/scroll/click via real DOM-event verification, Enter-submit, screenshot PNG, the CDP allowlist holding end-to-end, in-page-fetch SSRF documented as an out-of-scope boundary, download-deny).

**Suite total: 559 tests across 22 files, 0 fail, 2406 expect() calls; src tsc 0; biome 0/0.**

## Adversarial-audit closeout (2026-06-01)

A focused adversarial re-audit (post real-chrome) tried to falsify the 7 core claims; the security spine (closed CDP allowlist + model-uncontrollable `sessionId`, the structural SSRF classifier, the snapshot↔`resolveJs` static-DOM index agreement) held. Two real defects surfaced and are now fixed structurally:

1. 🔴 **Stale refs survived navigation (cross-page mis-actuation).** `navigate` updated the URL but never invalidated the `RefMap`, so a ref minted on page A stayed live after navigating to page B — `browser_click(eN)` could silently actuate page B's node at the same child-index path (or no-op), with no error. Both adapters were affected; both audits + the ~334-case battery missed it because their "stale ref" cases used refs that *never existed* (`e999`) and the e2e always re-snapshots after navigate. **Fix:** `RefMap` gains `invalidate()` (clears both bind directions; the monotonic counter is deliberately NOT reset, so a stale ref number is never reused and a later page can never coincidentally rebind it). `navigate` calls it the instant navigation commits (real adapter: right after `Page.navigate` is accepted, before the load wait; stub: on page-found). A pre-snapshot ref now fails closed → `element-not-found`, forcing a fresh snapshot. Refs are now bound to the snapshot that minted them as a **code invariant**, matching strengthen #1's hard-gate-over-prose posture. Sealed by `HELL-SNAP-12/13/14` (pure + port-level, mutation-verified non-vacuous).
2. 🟡 **Real-chrome closeout fixes #2/#3 had zero chrome-free coverage.** The named-key virtual-key descriptors (`windowsVirtualKeyCode`/`code`/`text`) and the `el.focus()`-before-act calls were guarded ONLY by the chrome-gated e2e (both `skipIf(!CHROME_USABLE)`), so on a chrome-less CI a regression to `keyEventBase → {key}` or a dropped `el.focus()` would pass the entire deterministic suite. **Fix:** `browser-verbs-hellgate` now asserts the full key descriptor on `keyDown`+`keyUp` (Enter vk=13/code/`\r`, Tab vk=9/no-text, single-char text+`KeyX`) and that `click`/`fill`/`type` emit in-page JS containing `el.focus()` — all observable on the fake wire, no browser needed.

**Suite total: 566 browser/ssrf/wire tests across 22 files, 0 fail; src tsc 0; biome 0/0.** No production code mutated beyond the `RefMap` seam (one new method) and its two `navigate` call sites — default-OFF wiring untouched, registry still byte-identical.

## R3 deep-audit closeout (2026-06-01)

A 5-lens deep audit (concurrency-lifecycle / flat-session-protocol / dom-walk / security-wiring / test-mutation) targeting code added since R2 — 13 confirmed, all fixed:
- **flat-session protocol**: `routeEvent` now filters by `sessionId` (a foreign-target/browser-level event can no longer satisfy a page-scoped `waitForEvent`); `Target.detachedFromTarget`/`Target.targetCrashed` mark the session dead → in-flight + future calls fail fast instead of grinding to the timeout.
- **lifecycle**: the dispose-during-spawn close is now caught + awaited (no unhandled rejection, genuinely closed before dispose returns); `proc.kill()` is best-effort so a throwing kill never skips the profile `rmrf`.
- **security**: `classifyHost` trims whitespace (a leading/trailing space no longer bypasses SSRF); page-derived error detail (`cdp-error`/`cdp-method-denied`) routed through `guardPageText`.
- **keys**: `keyEventBase` emits a correct `code` for digits/symbols (not a bogus `Key<symbol>`).
- **tests**: +flat-session battery (sessionId stamping / event filter / detach-crash), navigate→`invalidate()` cross-navigation stale-ref coverage, all 5 bring-up error arms, and fail-loud real-chrome gates (a present-but-broken chrome is now a loud failure, not 17 silent skips).

**Suite total: 578 tests across 23 files, 0 fail, 2484 expect() calls; src tsc 0; biome 0/0.**

## Still deferred (honest): `browser_tabs` (multi-target CDP — its own slice); download-INTO-jail (currently denied, which is the safe default; allowing+jailing needs CDP download-event plumbing); DNS-rebind connection pinning (CDP cannot cleanly pin a resolved address into the connection); a real-chrome smoke run for `cdp/defaults.ts` (needs a chrome binary in CI).

**Deferred to Phase 2:** `browser_fill`/`select_option`/`scroll`/`press_key`/`drag`/`tabs`/`mouse_click_xy`; download-to-jail (strengthen #4); origin-allowlist layer on top of SSRF; richer collector fields (placeholder/options/level/nth — R1 [11]); DNS-rebind connection pinning; CLI composition-root population of `config.browser` ([9]/[13] operator step).
