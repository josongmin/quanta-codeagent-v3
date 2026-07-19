/**
 * CLI-03 — Surface-only slash-command registry (ADR-0306).
 *
 * This file owns slash commands whose entire blast radius is the CLI
 * surface: preferences, panels, skills inventory, env-knob diagnostics. They
 * do NOT need the live LLM, the agent loop, or the runner — and the slice
 * fence (biome `noRestrictedImports` against `@/agent`, `@/llm`, `@/runner`,
 * `@/host`) enforces it.
 *
 * Some commands here (`/snapshot`, `/queue`, `/fork-checkpoint`, `/cost`,
 * `/plan`, etc.) live in this layer even though their `*-cmd.ts` module
 * imports from `@/agent` / `@/storage` for types only — the cmd object
 * surface is purely a "read-only render via a ctx slot" body, and the
 * dispatch never invokes an LLM. The registry-level fence applies to direct
 * imports from `registry-surface.ts`, which is satisfied: each cmd is
 * brought in as an opaque `SlashCommand` object.
 *
 * Composition: `slash-commands.ts` concatenates
 * `[...SURFACE_SLASH_COMMANDS, ...SESSION_SLASH_COMMANDS,
 *   ...APP_SLASH_COMMANDS]` into the historic `BUILTINS`.
 */

import {
  createActivityStore,
  fleetToActivity,
  pumpFleetRowsToItemStream,
  renderActivity,
  seedStoreFromSnapshot,
} from "@/activity"
import { errMessage, logger, runtimeConfig } from "@/shared"
import { renderAgentFleet, renderAgentInspect } from "../agents-fleet-panel"
import { backgroundCmd } from "../background-cmd"
import { formatBranchesPanel } from "../branch-search-progress"
import { editMessageCmd } from "../edit-message-cmd"
import { editPlanCmd } from "../edit-plan-cmd"
import { forkCheckpointCmd } from "../fork-checkpoint-cmd"
import { runHelpRender } from "../help-render"
import { historyCmd } from "../history-cmd"
import { parseSnoozeDuration } from "../idle-monitor"
import { buildInitCmd, isInitSlashEnabled } from "../init-scaffold"
import { inspectCmd } from "../inspect-cmd"
import { loginCmd } from "../login-cmd"
import { buildLogoutCmd } from "../logout-cmd"
import { pasteCmd } from "../paste-cmd"
import { PLAN_PANEL_NOT_WIRED, writePlanPanel } from "../plan-panel"
import { queueCmd } from "../queue-cmd"
import { renderItemSection } from "../repl/item-store"
import { replayCmd } from "../replay-cmd"
import { rulesCmd } from "../rules-cmd"
import { sessionCmd } from "../session-cmd"
import type { SlashCommand, SlashContext } from "../slash-contract"
import { snapshotCmd } from "../snapshot-cmd"
import { statusCmd } from "../status-cmd"
import { runVoiceCmd } from "../voice-cmd"
import { runVoiceLiveCmd } from "../voice-live-cmd"
import { webCmd } from "../web-cmd"
import { renderSkillScopePanel, renderWorkingStatePanel } from "../working-state-panel"
import { browserNetCmd } from "./browser-net-cmd"
import { cronCmd, inboxCmd, scheduleCmd } from "./cron-cmd"
import { kbCmd } from "./kb-cmd"
import { mcpResourcesCmd } from "./mcp-resources-cmd"
import { modelCmd } from "./model-cmd"
import { onboardCmd } from "./onboard-cmd"
import {
  identityCmd,
  modeCmd,
  profileCmd,
  stickyModelCmd,
} from "./registry-surface/config-posture-cmds"
import { briefCmd, effortCmd, focusChainCmd } from "./registry-surface/focus-effort-brief"
import {
  colorCmd,
  contextCmd,
  navigateCmd,
  usageCmd,
  waitCmd,
} from "./registry-surface/preferences-cmds"
import { runSkillsRender } from "./render-helpers"

const skillsCmd: SlashCommand = {
  name: "/skills",
  describe: "List discovered skills (name + description + paths)",
  run: (args, ctx) => runSkillsRender("/skills", args, ctx, "skills:"),
}

const reloadSkillsCmd: SlashCommand = {
  name: "/reload-skills",
  describe: "Re-discover skills from disk and print the result",
  run: (args, ctx) => runSkillsRender("/reload-skills", args, ctx, "reloaded:"),
}

/** `/snooze [duration]` — suspend new turn entry for `duration` (default 5m).
 *  Accepts `30s`, `5m`, `10m`, `1h`, or a bare millisecond integer; rejects
 *  zero / negative / unparseable tokens with exit 1. Absent monitor (one-shot
 *  surfaces) ⇒ prints "not wired" and exits 0 — symmetric with `/skills`. */
const snoozeCmd: SlashCommand = {
  name: "/snooze",
  describe: "Suspend new turns for a duration (default 5m). e.g. /snooze 10m",
  async run(args, ctx) {
    if (ctx.idle === undefined) {
      ctx.out("/snooze: not wired in this surface\n")
      return 0
    }
    if (args.length > 1) {
      ctx.err("/snooze: expected at most one argument (duration like 5m, 1h)\n")
      return 1
    }
    if (args.length === 0) {
      ctx.idle.snooze()
      ctx.out("snoozed (default duration). Use /resume to wake.\n")
      return 0
    }
    const arg = args[0] as string
    const ms = parseSnoozeDuration(arg)
    if (ms === null) {
      ctx.err(`/snooze: invalid duration: ${arg} (use 30s | 5m | 1h | bare ms)\n`)
      return 1
    }
    ctx.idle.snooze(ms)
    ctx.out(`snoozed for ${arg}. Use /resume to wake.\n`)
    return 0
  },
}

/** `/resume` — cancel an active snooze AND mark the REPL active (clear the
 *  idle clock). Idempotent — calling it when not snoozed is a no-op and
 *  prints a friendly message. */
const resumeCmd: SlashCommand = {
  name: "/resume",
  describe: "Cancel an active snooze and resume new turns",
  async run(args, ctx) {
    if (ctx.idle === undefined) {
      ctx.out("/resume: not wired in this surface\n")
      return 0
    }
    if (args.length > 0) {
      ctx.err("/resume: takes no arguments\n")
      return 1
    }
    const wasSnoozed = ctx.idle.isSnoozed()
    ctx.idle.unsnooze()
    ctx.idle.markActive()
    ctx.out(wasSnoozed ? "resumed.\n" : "(was not snoozed) ready.\n")
    return 0
  },
}

// R10 panel slash commands — bodies inline so the layered registry is the
// single source of truth for surface-only slots. Each command returns exit 0
// with "not wired in this surface" when its ctx field is absent (parity with
// /skills/snooze/side — default-OFF safety).

const costCmd: SlashCommand = {
  name: "/cost",
  describe: "Show cumulative session cost panel (tokens, duration, $)",
  category: "session",
  async run(args, ctx) {
    if (args.length > 0) {
      ctx.err("/cost: takes no arguments\n")
      return 1
    }
    if (ctx.cost === undefined) {
      ctx.out("/cost: not wired in this surface\n")
      return 0
    }
    const body = ctx.cost()
    if (body === "") {
      ctx.out("/cost: panel disabled (QUANTA_COST_PANEL=0 or non-TTY)\n")
      return 0
    }
    ctx.out(`${body}\n`)
    return 0
  },
}

const planCmd: SlashCommand = {
  name: "/plan",
  describe: "Show the current plan (current step + queue + completed)",
  category: "session",
  async run(args, ctx) {
    if (ctx.planSnapshot === undefined) {
      ctx.out(`${PLAN_PANEL_NOT_WIRED}\n`)
      return 0
    }
    if (args.length > 1) {
      ctx.err("/plan: expected at most one argument (use `/plan` or `/plan show`)\n")
      return 1
    }
    const sub = args[0]
    if (sub !== undefined && sub !== "show") {
      ctx.err(`/plan: unknown subcommand: ${sub} (use \`/plan\` or \`/plan show\`)\n`)
      return 1
    }
    let plan: ReturnType<NonNullable<SlashContext["planSnapshot"]>>
    try {
      plan = ctx.planSnapshot()
    } catch (e) {
      const msg = errMessage(e)
      ctx.err(`/plan: snapshot failed: ${msg}\n`)
      return 1
    }
    writePlanPanel(plan, ctx.out)
    return 0
  },
}

const stateCmd: SlashCommand = {
  name: "/state",
  describe: "Show current working state (posture, blockers, next steps, owners)",
  category: "session",
  async run(args, ctx) {
    if (args.length > 0) {
      ctx.err(`/state: takes no arguments; got ${args.length}\n`)
      return 1
    }
    if (ctx.workingState === undefined) {
      ctx.out("/state: not wired in this surface\n")
      return 0
    }
    const snap = ctx.workingState()
    ctx.out(`${renderWorkingStatePanel(snap)}\n`)
    // ADR-0512 P3 — append the active skill's tool-availability scope when the
    // surface wired the getter AND a skill is actively scoping (v2 ON + armed).
    // `renderSkillScopePanel` returns "" for absent/null views, so an
    // unscoped/v2-OFF `/state` stays byte-identical.
    const scopeView = ctx.skillScope?.()
    const scopePanel = renderSkillScopePanel(scopeView)
    if (scopePanel !== "") ctx.out(`${scopePanel}\n`)
    return 0
  },
}

/** `/working-state` — long-form alias for `/state`. Same body so both names
 *  surface in `/help` (the renderer iterates the registry verbatim). */
const workingStateCmd: SlashCommand = {
  name: "/working-state",
  describe: "Alias for /state",
  category: "session",
  run: stateCmd.run,
}

const branchesCmd: SlashCommand = {
  name: "/branches",
  describe: "Show last branch-search N-best leaderboard",
  category: "loop",
  async run(args, ctx) {
    if (args.length > 0) {
      ctx.err("/branches: takes no arguments\n")
      return 1
    }
    if (ctx.branchSearch === undefined) {
      ctx.out("/branches: not wired in this surface\n")
      return 0
    }
    const state = ctx.branchSearch()
    ctx.out(`${formatBranchesPanel(state)}\n`)
    return 0
  },
}

/** `/agents` (Ticket 17, §11.2) — live subagent fleet view. Reads the session
 *  TaskRegistry (via `ctx.agents`, threaded from `setup.lifecycleTaskRegistry`)
 *  and renders an ID/Status/Type/Age/Result table — running-first, then settled
 *  by recency. `--format table|json|tree` and `--all` (don't collapse settled).
 *  Pure render (`renderAgentFleet`); the clock is injected via `ctx.now` so the
 *  output is deterministic under test. Absent slot ⇒ "not wired" + exit 0
 *  (default-OFF byte-identical). Closes the agent-state observability north-star
 *  for the fleet of background subagents. */
/** `/activity` (jun-15 P0-b) — the unified Activity tree (Agent Activity Spine).
 *  Builds a spine snapshot from the live in-process fleet (`ctx.agents`) and
 *  renders the zoomable L0→L2 tree with glyphs + inline why-stuck. Today this
 *  surfaces the subagent fleet; workflow runs + side-agent daemons feed the
 *  SAME spine once their producers are wired (P0-b cont.), so this view scales
 *  to all agent kinds without a new surface. Absent slot ⇒ "not wired" + exit 0. */
const activityCmd: SlashCommand = {
  name: "/activity",
  describe: "Unified activity tree (agents/workflows/daemons) with inline why-stuck",
  category: "loop",
  async run(_args, ctx) {
    if (
      ctx.agents === undefined &&
      ctx.activityStore === undefined &&
      ctx.activityItems === undefined
    ) {
      ctx.out("/activity: not wired in this surface\n")
      return 0
    }
    // Build a TRANSIENT view: seed from the durable session spine (live
    // `run_workflow` runs + daemons) WITHOUT mutating it, then overlay the
    // current in-process subagent fleet. Pulling the fleet into the shared
    // store would leak LRU-evicted subagents forever; seeding a fresh view each
    // call keeps the durable store pristine and the fleet current.
    const view =
      ctx.activityStore !== undefined
        ? seedStoreFromSnapshot(ctx.activityStore.snapshot())
        : createActivityStore()
    if (ctx.agents !== undefined) {
      const rows = ctx.agents()
      view.emitAll(fleetToActivity(rows))
      // S2 unified-observability (jul-03) — the SAME fleet snapshot that paints
      // the `/activity` tree is ALSO pumped onto the item-stream sink so the
      // subagent lifecycle folds into the ONE item taxonomy the wire planes
      // carry (join key `item-subagent-<id>`, matching the projector's
      // `subagent_cancel` arm). The sink is threaded by surface-compose ONLY
      // when `QUANTA_ITEM_STREAM` is on (presence-gate at the composition root),
      // so an absent slot ⇒ NO pump ⇒ byte-identical render + wire.
      pumpFleetRowsToItemStream(rows, ctx.itemStreamSink)
    }
    const now = ctx.now?.() ?? Date.now()
    ctx.out(`${renderActivity(view.snapshot(), { now }).join("\n")}\n`)
    // S2 unified-observability (jul-03) — append the bounded ItemStore rows so
    // `QUANTA_ITEM_STREAM` produces VISIBLE `/activity` output (the fleet snapshot
    // is ALSO pumped onto the SAME store via `pumpFleetRowsToItemStream` above).
    // Empty store / absent slot ⇒ "" ⇒ nothing appended (byte-identical).
    const itemSection =
      ctx.activityItems !== undefined ? renderItemSection(ctx.activityItems()) : ""
    if (itemSection !== "") ctx.out(`${itemSection}\n`)
    return 0
  },
}

const agentsCmd: SlashCommand = {
  name: "/agents",
  describe:
    "Live subagent fleet. Flags: --format table|json|tree, --all, --depth N; `inspect <id>` drills in",
  category: "loop",
  async run(args, ctx) {
    if (ctx.agents === undefined) {
      ctx.out("/agents: not wired in this surface\n")
      return 0
    }
    let format: "table" | "json" | "tree" = "table"
    let all = false
    let maxDepth: number | undefined
    let inspectId: string | undefined
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === "--all") {
        all = true
      } else if (a === "--format") {
        const v = args[i + 1]
        i += 1
        if (v !== "table" && v !== "json" && v !== "tree") {
          ctx.err(`/agents: --format must be table|json|tree (got ${v ?? "<nothing>"})\n`)
          return 1
        }
        format = v
      } else if (a === "--depth") {
        const v = args[i + 1]
        i += 1
        const n = Number(v)
        if (v === undefined || !Number.isInteger(n) || n < 0) {
          ctx.err(`/agents: --depth must be a non-negative integer (got ${v ?? "<nothing>"})\n`)
          return 1
        }
        maxDepth = n
        // `--depth` is a tree-only filter; default to the tree view for it.
        if (format === "table") format = "tree"
      } else if (a === "inspect") {
        inspectId = args[i + 1]
        i += 1
      } else if (a !== undefined && !a.startsWith("--")) {
        // Bare `/agents <id>` — drill into a single task.
        inspectId = a
      } else {
        ctx.err(
          `/agents: unknown argument '${a}' (try --format <table|json|tree>, --all, --depth <N>, or inspect <id>)\n`,
        )
        return 1
      }
    }
    const now = ctx.now?.() ?? Date.now()
    if (inspectId !== undefined) {
      ctx.out(`${renderAgentInspect(ctx.agents(), inspectId, { now })}\n`)
      return 0
    }
    ctx.out(
      `${renderAgentFleet(ctx.agents(), { format, now, all, ...(maxDepth !== undefined ? { maxDepth } : {}) })}\n`,
    )
    return 0
  },
}

/** `/radar` (ADR-0231) — the radar proposal-queue operator surface. Lists the
 *  active cards the producer hook has deposited and lets the operator
 *  adopt/dismiss/engage/prune them, sharing the SAME `RadarStore` instance the
 *  agent loop's producer hook writes to (`ctx.radar`, threaded from
 *  surface-compose's gated `buildRadarStore`). Subcommands:
 *    - `list` (default) — render every `"active"` card (id/kind/title).
 *    - `adopt <id>`     — `setStatus(id,"adopted")` (drops from listActive).
 *    - `dismiss <id>`   — `setStatus(id,"dismissed")` (drops from listActive).
 *    - `engage <id>`    — `recordEngagement(id)` (++count; stays active).
 *    - `prune`          — expire cards older than `QUANTA_RADAR_PRUNE_MS`
 *                         (default 24h) by `createdAtMs`.
 *  Absent slot ⇒ "not wired in this surface" + exit 0 (default-OFF
 *  byte-identical, parity with `/agents`). */
export const radarCmd: SlashCommand = {
  name: "/radar",
  describe:
    "Radar proposal queue (list/adopt <id>/dismiss <id>/engage <id>/prune). Opt-in: QUANTA_RADAR=1",
  category: "loop",
  async run(args, ctx) {
    const radar = ctx.radar
    if (radar === undefined) {
      ctx.out("/radar: not wired in this surface\n")
      return 0
    }
    const sub = args[0] ?? "list"
    if (sub === "list") {
      const active = radar.listActive()
      if (active.length === 0) {
        ctx.out("/radar: no active cards\n")
        return 0
      }
      const lines = active.map(
        (c) => `  [${c.id}] (${c.kind}) ${c.title} — engaged ${c.engagementCount}×`,
      )
      ctx.out(`Radar — ${active.length} active card(s):\n${lines.join("\n")}\n`)
      return 0
    }
    if (sub === "adopt" || sub === "dismiss") {
      const id = args[1]
      if (id === undefined) {
        ctx.err(`/radar: ${sub} requires a card id (try '/radar list')\n`)
        return 1
      }
      const status = sub === "adopt" ? "adopted" : "dismissed"
      const r = radar.setStatus(id, status)
      if (!r.ok) {
        ctx.err(`/radar: ${sub} failed for '${id}': ${r.error}\n`)
        return 1
      }
      ctx.out(`/radar: card '${id}' ${status}\n`)
      return 0
    }
    if (sub === "engage") {
      const id = args[1]
      if (id === undefined) {
        ctx.err(`/radar: engage requires a card id (try '/radar list')\n`)
        return 1
      }
      const r = radar.recordEngagement(id)
      if (!r.ok) {
        ctx.err(`/radar: engage failed for '${id}': ${r.error}\n`)
        return 1
      }
      ctx.out(`/radar: card '${id}' engaged (count ${r.value.engagementCount})\n`)
      return 0
    }
    if (sub === "prune") {
      const now = ctx.now?.() ?? Date.now()
      const pruned = radar.prune(ctx.radarPruneOlderThanMs ?? 24 * 60 * 60 * 1000, now)
      ctx.out(`/radar: pruned ${pruned} expired card(s)\n`)
      return 0
    }
    ctx.err(
      `/radar: unknown subcommand '${sub}' (try list | adopt <id> | dismiss <id> | engage <id> | prune)\n`,
    )
    return 1
  },
}

/** `/voice-live` (ADR-0442) — live bidirectional spoken dialog. The surface
 *  populates `ctx.voiceLive` ONLY when the opt-in gate (`QUANTA_VOICE_LIVE`)
 *  is set AND the host is a TTY; that builder constructs the live
 *  `RealtimeVoiceSessionPort` (Bun-WS transport + platform mic recorder +
 *  playback + injected clock/pump) with the bearer resolved at the composition
 *  root and threaded in as a value. The slash itself never reaches into
 *  `@/realtime` / `@/voice` / `@/auth` — it only sees the constructed
 *  `VoiceLiveCtx`.
 *
 *  Default-OFF (byte-identical when the knob is unset):
 *    - slot absent ⇒ "realtime voice not wired in this surface" + exit 0,
 *    - builder resolves `undefined` (gate off / non-TTY) ⇒ same decline,
 *    - never auto-launches a live mic session without an interactive key
 *      reader (the cmd's own headless guard handles that). */
const voiceLiveCmd: SlashCommand = {
  name: "/voice-live",
  describe: "Live spoken dialog (mic up + transcript/audio down). Opt-in: QUANTA_VOICE_LIVE=1",
  category: "other",
  async run(_args, ctx) {
    if (ctx.voiceLive === undefined) {
      ctx.out("/voice-live: realtime voice not wired in this surface\n")
      return 0
    }
    let built: Awaited<ReturnType<NonNullable<SlashContext["voiceLive"]>>>
    try {
      built = await ctx.voiceLive()
    } catch (e) {
      ctx.err(`/voice-live: failed to construct session: ${errMessage(e)}\n`)
      return 1
    }
    if (built === undefined) {
      // Gate off (QUANTA_VOICE_LIVE unset) or non-TTY host ⇒ decline cleanly.
      ctx.out("/voice-live: realtime voice not enabled (set QUANTA_VOICE_LIVE=1 in a terminal)\n")
      return 0
    }
    // Reconstruct the full line so the cmd's own subcommand parser sees the
    // verb (`status` etc.). `_args` is the post-name token slice.
    const line = ["/voice-live", ..._args].join(" ")
    return runVoiceLiveCmd(line, built)
  },
}

/** `/voice` (ADR-0208, registered under plan D-9 / UUX-2-05 + UUX-1-10) —
 *  push-to-talk record → transcribe → plan-queue follow-up. The handler
 *  shipped with ZERO registry entries (only `/voice-live` was reachable);
 *  D-9's decision is register-with-degrade, not delete.
 *
 *  Register-or-degrade honesty (pinned by voice-slash-registry-hellgate):
 *    - `ctx.voice` absent (no surface composes the recorder today) ⇒ the
 *      handler's own presence gates fire: exit 1 + `hint:` line;
 *    - recorder wired but NO transcriber ⇒ refused BEFORE any audio is
 *      captured (exit 1 + hint) — never capture-then-exit-0 (UUX-6-27);
 *    - `/voice cancel` stays a working no-op that says what it actually does;
 *    - `/voice status` reports the wire state either way. */
const voiceCmd: SlashCommand = {
  name: "/voice",
  describe: "Record speech → queue the transcript as a follow-up (needs a wired transcriber)",
  category: "other",
  async run(_args, ctx) {
    // Reconstruct the full line so the cmd's own subcommand parser sees the
    // verb (`status` / `cancel`) — same pattern as `/voice-live` above.
    const line = ["/voice", ..._args].join(" ")
    return runVoiceCmd(line, { out: ctx.out, err: ctx.err, ...(ctx.voice ?? {}) })
  },
}

/** `/help` — unified menu (slash inventory + keybinds + ENV knobs). The
 *  rendered list is whatever `SURFACE_SLASH_COMMANDS` is concatenated with at
 *  composition time — the assembly in `slash-commands.ts` passes the live
 *  full registry so `/help` reflects all three layers. */
const makeHelpCmd = (lookupBuiltins: () => readonly SlashCommand[]): SlashCommand => ({
  name: "/help",
  describe: "Show all slash commands, keybinds, and ENV knobs",
  category: "help",
  run: (args, ctx) => runHelpRender(lookupBuiltins(), args, ctx),
})

/** Build the surface-layer registry. `helpRegistryLookup` is supplied by
 *  `slash-commands.ts` so `/help` reflects the LIVE concatenated registry
 *  (all three layers + any later spreads). The function form keeps the
 *  helpCmd capture lazy — there is no circular-import hazard because the
 *  closure runs only when a user types `/help`, long after module init.
 *
 *  The slot order matches the spec layered ordering: surface commands
 *  appear in the original BUILTINS order (minus the session/app cmds which
 *  hop layers), so `/help` continues to surface the same names. */
export const buildSurfaceSlashCommands = (
  helpRegistryLookup: () => readonly SlashCommand[],
): readonly SlashCommand[] => [
  makeHelpCmd(helpRegistryLookup),
  contextCmd,
  usageCmd,
  colorCmd,
  navigateCmd,
  waitCmd,
  skillsCmd,
  reloadSkillsCmd,
  loginCmd,
  // jun-6 RFC — thread the `QUANTA_OAUTH_REVOKE_ON_LOGOUT` knob + a real
  // fetchPort + logger into the logout command deps. Default-OFF ⇒
  // `revokeOnLogout` false ⇒ byte-identical local-delete-only logout (no
  // revoke endpoint constructed, no network call). When ON, logout best-effort
  // revokes the refresh token (RFC 7009) before the local delete (NO-THROW).
  buildLogoutCmd({
    revokeOnLogout: runtimeConfig().oauthRevokeOnLogout,
    fetchPort: (input, init) => fetch(input, init),
    logger: { warn: (msg, ctx) => logger.warn(msg, ctx) },
  }),
  statusCmd,
  snoozeCmd,
  resumeCmd,
  snapshotCmd,
  rulesCmd,
  costCmd,
  planCmd,
  stateCmd,
  workingStateCmd,
  historyCmd,
  branchesCmd,
  activityCmd,
  agentsCmd,
  // ADR-0231 — `/radar` proposal queue. Always in the registry; the command
  // itself prints "not wired" + exit 0 when `ctx.radar` is absent (default-OFF
  // byte-identical, parity with /agents).
  radarCmd,
  // Ticket 18 (V1) — `/background` manages turns moved to the background (Ctrl+B).
  // Always in the registry; the command itself prints "not wired" + exit 0 when
  // `ctx.background` is absent (default-OFF byte-identical, parity with /agents).
  backgroundCmd,
  // #21 — `/init` scaffolds AGENTS.md/CLAUDE.md from the repo. CLI-surface
  // DEFAULT-ON, opt-OUT: present UNLESS `QUANTA_INIT_SLASH` is explicitly
  // disabled (`isInitSlashEnabled`, the rewind/dream idiom). Registration ≠
  // execution — `/init` only WRITES on explicit invocation, so a visible verb is
  // safe (matches Claude Code). R3 fix: the prior `readCliKnob(...) ?? false`
  // was read at module-eval BEFORE index.ts's seed loop ran AND defaulted to the
  // inventory `false`, so the command was unreachable; a default-ON env read is
  // immune to that timing. Non-CLI surfaces never import this registry ⇒ absent
  // there (the inventory keeps `default:false` as the runtime-config baseline).
  ...(isInitSlashEnabled() ? [buildInitCmd()] : []),
  forkCheckpointCmd,
  queueCmd,
  webCmd,
  voiceLiveCmd,
  // D-9 — `/voice` register-or-degrade (honest transcriber-presence gate in
  // the handler; never capture-then-exit-0).
  voiceCmd,
  pasteCmd,
  editPlanCmd,
  editMessageCmd,
  profileCmd,
  identityCmd,
  stickyModelCmd,
  modelCmd,
  focusChainCmd,
  effortCmd,
  briefCmd,
  // #13 — `/mode` interactive posture switch (sibling of /effort + /brief).
  modeCmd,
  inspectCmd,
  replayCmd,
  sessionCmd,
  // jul-03 CLI-surfacing of landed features. Each command reads live surface
  // state and prints "not wired" + exit 0 when its ctx slot is absent (default-OFF
  // byte-identical, parity with /agents / /radar).
  //   A3 — Projects knowledge-base accounting.
  kbCmd,
  //   B4 — fetched MCP resource dirs + blob-to-disk paths.
  mcpResourcesCmd,
  //   S1 — last browser network-capture + locator summary.
  browserNetCmd,
  //   B2 — automation schedules (+ /schedule alias) + the /inbox the banner refs.
  cronCmd,
  scheduleCmd,
  inboxCmd,
  //   B1 — onboarding identity reachability (the launch-flag `--identity-mode
  //   onboarding` now has a slash counterpart).
  onboardCmd,
]

/** Static slot order — surface entries appended in the layered concatenation
 *  `[...SURFACE_SLASH_COMMANDS, ...SESSION_SLASH_COMMANDS,
 *    ...APP_SLASH_COMMANDS]`. `/help` is wired through the live builtins
 *  closure in {@link buildSurfaceSlashCommands}; the standalone form here is
 *  for tests that import the layer in isolation and want a stable shape.
 *  Tests of the FULL registry should use the assembled `BUILTINS` import. */
export const SURFACE_SLASH_COMMANDS: readonly SlashCommand[] = buildSurfaceSlashCommands(
  () => SURFACE_SLASH_COMMANDS,
)
