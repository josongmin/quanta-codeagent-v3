# Jul-9 UI/UX Bug Bash (6-pass audit)

**Date:** 2026-07-09  
**Scope:** Operator-facing UX — CLI REPL, web frontend/daemon, Tauri shell, attach, approvals, slash commands, status chrome, session ops, automation, multimodal.  
**Method:** Six parallel explore passes; each pass targeted under-covered axes and excluded prior-pass primaries. High-severity items were cross-checked against live source (`file:line`).

**2026-07-10 verification audit:** 11 parallel agents re-verified all P0/Crit/High + all P2 against HEAD. Result: 6 findings WRONG (removed), ~10 already FIXED by the jul-9/10 ALBB waves, 4 closed as documented-intentional, ~9 narrowed. Everything left in [05-fix-queue.md](./05-fix-queue.md) is confirmed real with current file:line anchors. P3 rows remain unverified backlog. Details: [04-corrections.md](./04-corrections.md).

**Related (different scope):** [../plans/draft/jul-9-bugbash/](../../plans/draft/jul-9-bugbash/) — agent-loop correctness (ALBB-*). This folder is **UI/UX / wiring / false-success / annoying affordances**.

## Result summary

| Band | Approx count | Dominant themes |
|------|--------------|-----------------|
| **P0 / Critical** | ~12 | False-success destructive ops, silent data drop, HITL policy split, hang paths |
| **P1 / High** | ~45 | Advertising-only keybinds, web slash Enter no-op, approval optimistic dismiss, terminal layout fights |
| **P2 / Medium** | ~90 | Parity gaps, stale chrome, gate-hidden features, opaque errors |
| **P3 / Low** | ~40 | Locale mix, a11y polish, catalog drift, exit-0 “not wired” |

Exact line items live in the inventory docs below. Counts are approximate because some findings span multiple surfaces.

## Documents

| Doc | Contents |
|-----|----------|
| [00-inventory.md](./00-inventory.md) | Full finding index by pass + ID |
| [01-critical-high.md](./01-critical-high.md) | P0 / Critical / High — start here |
| [02-medium.md](./02-medium.md) | P2 medium |
| [03-low-polish.md](./03-low-polish.md) | P3 low / polish / doc drift |
| [04-corrections.md](./04-corrections.md) | Pass-to-pass corrections (e.g. ALBB-06 already fixed) |
| [05-fix-queue.md](./05-fix-queue.md) | Recommended Top-20 execution order |

## Pass map

| Pass | Axes |
|------|------|
| **1** | CLI surface map, permission/HITL, streaming/status, feature-catalog UI claims |
| **2** | Web frontend deep-dive, slash/help/keybinds, bugbash ticket cross-check |
| **3** | Attach / mid-turn / background portal, notify/Tauri, documented UX gaps |
| **4** | Session ops / auth / MCP / doctor, automation/SDK/error recovery, false-success prefs |
| **5** | Memory/skills/plan/compaction, paint/DECSTBM/first-run, empty-state/a11y/catalog |
| **6** | Subagent/diff/checkpoint/knobs, shell/LSP/i18n, residual landmines |

## Dominant failure classes

1. **False success** — prints “updated/rewound/applied/fired” while no-op or wrong target (`/edit-plan`, `/snapshot <N>`, `/color`, `/navigate`, heartbeat, web prefill Enter, `/knobs save`).
2. **Advertising-only** — `/help` or keybind map promises chords/commands that are unwired or inverted (Esc↔Ctrl+C, Ctrl+D, Ctrl+B, `/compact`).
3. **Half-wired surfaces** — gate OFF → `"not wired"` (often exit 0); web palette shows CLI commands that never execute.
4. **Terminal layout fights** — DECSTBM on stdout+stderr, SCO vs DEC cursor save, unwired resize.
5. **Approval / HITL split-brain** — CLI vs web `hitl.enabled`, inline vs deferred verbs, attach y/N-only, optimistic dismiss.
6. **Silent degrade** — MCP load fail, persist fail, hydrate fail, tee degrade, spinner-stall — no operator signal.

## How to use

1. Read [01-critical-high.md](./01-critical-high.md).
2. Execute via the structural plan [docs/plans/jul-10-uiux-structural-fixes.md](../../plans/jul-10-uiux-structural-fixes.md) (8 root-cause workstreams, kernels-first); [05-fix-queue.md](./05-fix-queue.md) is the item checklist.
3. Prefer fail-closed or honest messaging over growing the allowlist of “not wired” exit 0.
4. When fixing, update this folder’s status notes or strike through the inventory ID.
