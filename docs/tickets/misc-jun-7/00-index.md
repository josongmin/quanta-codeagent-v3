# misc-jun-7 — ticket index + master status board

**Date:** 2026-06-07
**Purpose:** single board to drive "다 조지기" — every jun-7 gap → ticket → **src-verified** status, sequenced by ROI + dependency. Statuses are grep-verified at index time (re-verify before starting; the in-flight tree moves fast).

**Legend:** ✅ DONE (live + tested) · 🟡 PARTIAL (infra/some landed; finish) · 📐 DESIGN (ticket only, no impl) · 🔲 GAP (no ticket, no impl).

> **STATUS (parallel adversarial audit, jun-07):** 8 read-only agents verified each ticket's real impl vs source. **Major correction: 01/02/03/06 are fully DONE** (the in-flight tree implemented them with ADRs+tests); 04/05 PARTIAL with specific residuals; 07/08/09/10 confirmed GAP. Details below.

## Status board

| # | Ticket | Gap | Status (audit-verified jun-07) | ROI |
|---|---|---|---|---|
| 01 | MCP protocol-version + nego | §1.1 P1 | ✅ **DONE** — `protocol-version.ts` `SUPPORTED_PROTOCOL_VERSIONS=[2025-11-25,2025-06-18]`+nego+downgrade-floor | 고 |
| 02 | Manifest codex-compat | §2.1/2.2 P2 | ✅ **DONE** — ADR-0493, gate `QUANTA_MANIFEST_COMPAT`. Real codex `plugin.json`(string `skills`+`repository`) + `SKILL.md`(kebab `allowed-tools` blocklist, optional `user-invocable`) parse; inner security blocks stay strict; default-OFF byte-identical; fixtures+e2e tests | 고 |
| 03 | Guardian per-action assessor | §3.1 P3 | ✅ **DONE** — ADR-0497, gate `QUANTA_GUARDIAN_ASSESSOR`. **7-variant typed `ActionAssessment`**(allow/allow_for_session/allow_with_edit/ask/deny/deny_and_steer/escalate)+conservative collapse+fail-closed adapter+e2e. (defer: sticky session-grant, sandbox auto-amend) | 고(보안) |
| 04 | auto-mode rule-overlay + circumvention | §3.2 P4 | 🟡 **PARTIAL** — (B) **overlay DONE**(soft/hard_deny+`$defaults`+untrusted fence, gate `QUANTA_AUTO_MODE_RULES`, wired). (A) **circumvention code complete+wired into policy/gate BUT `CircumventionTracker` never instantiated in src/ = DEAD** (comp-root missing) | 고(보안) |
| 05 | central config + per-project trust | P7 | 🟡 **PARTIAL** — loader/merge/trust-store LIVE-wired for command-hooks surface(`QUANTA_CENTRAL_CONFIG`+`QUANTA_COMMAND_HOOKS`); untrusted repo's hooks genuinely dropped. **Missing: ① 신뢰 prompt(`setTrusted` 호출처 없음 — env-only) ② dropped-settings 로깅(empty warn) ③ managed-layer(hardcoded undefined)** | 중-고 |
| 06 | model-based fast-apply | §5.1 | ✅ **DONE** — ADR-0500, gate `QUANTA_FAST_APPLY_MERGE`+`QUANTA_FAST_APPLY_MODEL`. **MERGE 방향**(원본+elided sketch→full rewrite) edit-ladder rung(exact→fuzzy→**merge**→V4A→mismatch); quanta provider seam(role "apply", NOT Morph/Relace dep); 2-layer verify; e2e. (티켓06 본문은 stale — "Morph/Relace" 표현은 메커니즘만 차용) | 고 |
| 07 | `summarize` verb wiring | §11.5 follow | ✅ **DONE (jun-07)** — `compactIfNeeded` `force` bypass + `compactNowOnDemand` (compaction-wire) + control-poll `summarize`→outcome + turn-iteration consumer. `/summarize-now` now actually compacts. default-OFF(no compaction config⇒no-op). 5 hellgate(force/no_boundary/control-poll/on-demand/default-off); 1371 regression pass | 중/비용 저 |
| 08 | steering UX residual | §11.5 follow | 🔲 **GAP (mine)** — 08a weave-race(reject→drop, re-queue 필요) + 08b mid-turn 가시성(TTY) | 중·저+고 |
| 09 | MCP SSE resumption (Last-Event-ID) | §1.2 P10 | ✅ **DONE (jun-08)** — `sseDataFromBlock`→{data,id} parse + `lastEventId` cursor + `resumeFromEventId` seed + `Last-Event-ID` on GET + `getLastEventId()` passthrough(client) + **supervisor carries cursor across restart**(types/buildTransport/port/supervisor). 11 hellgate(transport 8 + supervisor-carry 3); 249 MCP regression pass; default-OFF byte-identical. defer: explicit unknown-id reset (server-advisory, low-risk) | 중 |
| 10 | cell-aware NotebookEdit | §16.5 P17 | 🔲 **GAP (확정)** — `tool-matchers.ts:26` 이름만, write tool/manifest entry 전무; read half만 | 유저층 의존 |

### ✅ Landed this session (no ticket needed — done + tested)
- **§25.1 workflow engine** (`@/workflow`: node-tree + executor + JSON spec/compiler + adapter; `run_workflow` tool gate `QUANTA_WORKFLOW`; 57 test) — [[jun-07-workflow-engine-slice]]
- **§11.5 inbound 3-mode** (queue/weave/interrupt SSOT + `/inbound`; 42 test) — [[jun-07-inbound-mode-3way]]
- **§11.5 interrupt-restore** (`INTERRUPTED_TURN`: `interrupted-turn.ts` buffer + capture + `resume` verb live + `/resume-turn`; 15 test)
- **P11 ANSI-strip · P14 line-truncation · P15 UTF-16/BOM · §24 item-lifecycle · P6 image downsample** — verified DONE.

---

## Sequencing (recommended — post-audit, only genuine residuals)

**Wave 1 — cheapest wins (finish-the-last-mile):**
1. **04a circumvention tracker instantiation** — code is COMPLETE + wired into policy/gate, just never instantiated in the composition root → it's DEAD. Mint `CircumventionTracker` where the permission decider is assembled + thread it (gate `QUANTA_CIRCUMVENT_DETECT`). **Tiny, flips a fully-built security feature from dead→live.**
2. **07 summarize-verb** — last dead conversation-action verb (resume already fixed). Add: public on-demand seam in `compaction.ts` + `summarize` branch in `control-poll` + consumer in `turn-iteration`.

**Wave 2 — bounded confirmed gaps:**
3. **05 trust last-mile** — add the trust PROMPT (`setTrusted` interactive call) + dropped-settings WARN (replace empty sink) so the gate is usable interactively, not env-only. (managed-OS-layer = separate, lower ROI.)
4. **09 MCP SSE resumption** — `id:` parse + cursor + `Last-Event-ID` on reconnect + unknown-id fallback. Self-contained transport change.

**Wave 3 — bigger / lower-certainty:**
5. **08 steering UX** — 08a weave-race re-queue (저, quick) → 08b mid-turn input visibility (TTY hot-path, 고).
6. **10 NotebookEdit** — only if a notebook user-base is confirmed.

**Already DONE (audit-verified):** 01, 02, 03, 06 (+ this-session: workflow / inbound-3mode / interrupt-restore / P6 / §24 / P11 / P14 / P15) — no work.
**Skip unless platform demand:** P16 Windows shell (can't test on darwin).

---

## Discipline (all tickets)
- TDD red-first; hellgate scenarios incl. red-on-injection; e2e through real seams.
- default-OFF byte-identity for new slices/knobs; gate-vocab via `@/shared` `gateOn`.
- new LLM tool ⇒ manifest GATED entry (zero-unwired ratchet) + full composition wire.
- new slice ⇒ `tsconfig.base` path + slice-fence (`noRestrictedImports`); CLI-importing tests live in `src/apps/cli/__tests__/`.
- claim-100 ⇒ ≥3 adversarial review passes.
