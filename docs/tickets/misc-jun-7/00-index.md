# misc-jun-7 — ticket index + master status board

**Date:** 2026-06-07
**Purpose:** single board to drive "다 조지기" — every jun-7 gap → ticket → **src-verified** status, sequenced by ROI + dependency. Statuses are grep-verified at index time (re-verify before starting; the in-flight tree moves fast).

**Legend:** ✅ DONE (live + tested) · 🟡 PARTIAL (infra/some landed; finish) · 📐 DESIGN (ticket only, no impl) · 🔲 GAP (no ticket, no impl).

---

## Status board

| # | Ticket | Gap | Status (src-verified jun-07) | ROI |
|---|---|---|---|---|
| 01 | MCP protocol-version + nego | §1.1 P1 | ✅ **DONE** — `src/mcp/protocol-version.ts` `SUPPORTED_PROTOCOL_VERSIONS=[2025-11-25,2025-06-18]` + nego + downgrade-floor; `client.ts` consumes | 고 |
| 02 | Manifest codex-compat | §2.1/2.2 P2 | 🟡 **PARTIAL** — `plugin-manifest.ts` OUTER `.strict()`→`.strip()` + `skill-frontmatter.ts` kebab keys (ADR-0493). VERIFY: does a real codex `plugin.json`(string `skills`) / `SKILL.md`(blocklist `allowed-tools`) now `safeParse`? inner security blocks still strict (correct). | 고 |
| 03 | Guardian per-action assessor | §3.1 P3 | 🟡 **PARTIAL/VERIFY** — `reviewer-port.ts` matched `GuardianAssessment`; confirm it's the 6-variant typed assessor (Execve/NetworkAccess/ApplyPatch/Command/McpToolCall/RequestPermissions) + typed event, not just the opaque reviewer | 고(보안) |
| 04 | auto-mode rule-overlay + circumvention | §3.2 P4 | ✅ **DONE (verify depth)** — `src/permission/circumvention.ts` exists (tool-switch detection); confirm `soft_deny`/`hard_deny`/`$defaults` overlay also landed | 고(보안) |
| 05 | central config + per-project trust | §… P7 | 🟡 **PARTIAL (substantial)** — `src/config/` = loader/merge/trust-store + `knob-catalog`/`knob-inventory` (the knob-registry RFC infra). VERIFY: trust-gate live-wired into permission + settings.json load path | 중-고 |
| 06 | model-based fast-apply (Morph/Relace) | §5.1 | 📐 **DESIGN** — `Morph`/`Relace`/`FastApplyModel` grep 0; ticket only | 고/비용 고 |
| 07 | `summarize` verb wiring | §11.5 follow | 🔲 **GAP → ticket 07** — decided by `decideAction`, NO-OP in `control-poll` (like the now-fixed `resume`). Wire → mid-turn compaction | 중/비용 저 |
| 08 | steering UX residual (weave race + mid-turn visibility) | §11.5 follow | 🔲 **GAP → ticket 08** | 중(UX)/비용 weave-race 저·visibility 고 |
| 09 | MCP SSE resumption (Last-Event-ID) | §1.2 P10 | 🔲 **GAP → ticket 09** — `Last-Event-ID`/`lastEventId` grep 0 in `transports/` | 중 |
| 10 | cell-aware NotebookEdit | §16.5 P17 | 🔲 **GAP → ticket 10** — `notebook_edit` in tool-matchers only, no impl; read half done | 유저층 의존 |

### ✅ Landed this session (no ticket needed — done + tested)
- **§25.1 workflow engine** (`@/workflow`: node-tree + executor + JSON spec/compiler + adapter; `run_workflow` tool gate `QUANTA_WORKFLOW`; 57 test) — [[jun-07-workflow-engine-slice]]
- **§11.5 inbound 3-mode** (queue/weave/interrupt SSOT + `/inbound`; 42 test) — [[jun-07-inbound-mode-3way]]
- **§11.5 interrupt-restore** (`INTERRUPTED_TURN`: `interrupted-turn.ts` buffer + capture + `resume` verb live + `/resume-turn`; 15 test)
- **P11 ANSI-strip · P14 line-truncation · P15 UTF-16/BOM · §24 item-lifecycle · P6 image downsample** — verified DONE.

---

## Sequencing (recommended)

**Wave 1 — cheap + high-confidence, finish what's started:**
1. **07 summarize-verb** — last dead conversation-action verb; compaction engine exists; tiny. (continuity with resume/inbound)
2. **02 / 04 / 05 verify-and-close** — landed-but-confirm: prove codex artifact parses (02), soft/hard_deny overlay (04), trust-gate live-wire (05). Cheap audits that flip 🟡→✅.

**Wave 2 — confirmed gaps, bounded:**
3. **09 MCP SSE resumption** — interop, self-contained transport change.
4. **03 guardian** finish (if PARTIAL only has the mirror, build the 6-variant typed assessor).

**Wave 3 — bigger / lower-certainty ROI:**
5. **08 steering UX** (weave-race hardening first [저], mid-turn visibility later [TTY hot-path]).
6. **06 fast-apply** (external Morph/Relace model integration — biggest cost).
7. **10 NotebookEdit** (only if a notebook user-base exists).

**Skip unless platform demand:** P16 Windows shell (can't test on darwin).

---

## Discipline (all tickets)
- TDD red-first; hellgate scenarios incl. red-on-injection; e2e through real seams.
- default-OFF byte-identity for new slices/knobs; gate-vocab via `@/shared` `gateOn`.
- new LLM tool ⇒ manifest GATED entry (zero-unwired ratchet) + full composition wire.
- new slice ⇒ `tsconfig.base` path + slice-fence (`noRestrictedImports`); CLI-importing tests live in `src/apps/cli/__tests__/`.
- claim-100 ⇒ ≥3 adversarial review passes.
