/**
 * The caller-wire ledger of `MUTATING_TOOL_TABLE` (`./mode.ts`): table rows whose tools no
 * drift-test fixture can build. Re-exported from `./mode.ts`; its own module so that file
 * stays under the god-module cap.
 */

/** SINGLE SOURCE OF TRUTH for the "caller-wire" tool-name allowlist.
 *
 *  A *caller-wire* tool is one whose `MUTATING_TOOL_TABLE` entry (in `./mode.ts`) is
 *  PERMANENT but whose registration is CONDITIONAL — it is minted only when a
 *  host wires the relevant `AgentConfig` slot or tier-1 block (gated default-OFF
 *  behind an env knob) AND no drift-test fixture can reach it. A tool behind a
 *  `DefaultToolPort` does NOT belong here: `tests/unit/_shared/wired-tool-ports.ts`
 *  wires every port through an exhaustive `Record<keyof DefaultToolPorts, …>`, so
 *  the detectors enumerate it and a vanished registration is reported as an orphan
 *  row instead of being vouched for by name.
 *
 *  The two drift detectors that cross-check the table against the registered
 *  universe — `tests/integration/plan-mode-dispatch-hell-e2e.test.ts` and
 *  `tests/unit/mode-mutating-table.test.ts` — must therefore augment the
 *  enumerable tools with this NAME list so the orphan-direction check
 *  ("every table key maps to a real tool") stays exact without forcing every
 *  caller-wire factory to be reachable.
 *
 *  This constant exists to ELIMINATE a 3-way hand-sync footgun: previously
 *  EACH of those two tests carried its own hand-maintained literal copy of
 *  this list, and `MUTATING_TOOL_TABLE` was a third. Adding a caller-wire tool
 *  to the table but forgetting one of the two copies produced a confusing
 *  orphan/missing-direction failure (it bit poll_deferred,
 *  subagent_force_background, appshot_verify, and silently drifted
 *  read_image_url between the two copies). Now BOTH tests import THIS constant,
 *  so adding a caller-wire tool is TWO adjacent edits (the table entry in `./mode.ts`
 *  and this list, split into its own module when `mode.ts` reached the 1000-line
 *  god-module cap) and the two tests cannot diverge.
 *
 *  Invariant preserved: this list does NOT weaken the drift detectors. They
 *  still fail if a table key matches neither an enumerable tool NOR a name
 *  here (true orphan), and still fail if an enumerable tool is missing from
 *  the table (true missing). The SSOT only removes the DUPLICATE copies. The
 *  `caller-wire-ssot` test additionally pins that no name here is already
 *  enumerable from the BROADLY-WIRED fixture (it used to compare against the bare
 *  `defaultTools`, which let 30 port-gated names sit here and mask stale rows) and
 *  that every name here has a table entry. */
export const CALLER_WIRE_TOOL_NAMES = Object.freeze([
  // EXACTLY the table rows no drift-test fixture can build — measured, not curated.
  //
  // sep-13: every catalogued tool gained a row (table and manifest are now the same 203
  // names), and both drift detectors enumerate the ASSEMBLED universe
  // (`tests/unit/_shared/assembled-tool-universe.ts`, 156 names from ten real builders)
  // instead of a hand-picked set. This list is what is left: 46 names whose builders (47 until `shadow_verify` got its real manifest slot and became assemblable)
  // need a live resource at construction. It is also the runtime-parity gate's
  // not-yet-assembled ledger — one list, not two — and it may only shrink: a name the
  // universe starts building must leave (both detectors and the parity gate assert it).
  //
  // Browser tools — `@/agent/tier1/browser` needs a CDP endpoint.
  "browser_cdp",
  "browser_click",
  "browser_console",
  "browser_drag",
  "browser_element_bounds",
  "browser_fill",
  "browser_highlight",
  "browser_mouse_click_xy",
  "browser_navigate",
  "browser_network",
  "browser_press_key",
  "browser_read",
  "browser_screenshot",
  "browser_scroll",
  "browser_select_option",
  "browser_snapshot",
  "browser_tab_close",
  "browser_tab_list",
  "browser_tab_new",
  "browser_tab_switch",
  "browser_type",
  "browser_wait",
  // MCP task control — needs a server that advertises Tasks.
  "cancel_mcp_task",
  "get_mcp_task",
  "list_mcp_tasks",
  // Memory — needs a live store.
  "memory_search",
  "memory_update",
  "memory_write",
  // Background subagents — need the background runner and admission queue.
  "subagent_await",
  "subagent_force_background",
  "subagent_fork",
  "subagent_poll",
  "poll_deferred",
  // Per-child or composition-root bindings the fixture does not model.
  "report_agent_job_result",
  "delegate",
  "followup_task",
  "fork_session",
  "skill_create",
  "update_working_state",
  // Retrieval, search and bench-driver wiring.
  "search_codebase",
  "web_search",
  "find_references",
  "ast_grep",
  "check_secrets",
  // Built and tested, registered by NO production path (catalogued `unwired`).
  "git_push",
  "git_stage",
] as const)
