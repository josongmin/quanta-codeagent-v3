/**
 * Surface config-posture cluster — `/profile`, `/identity`, `/sticky-model`,
 * `/mode` (extracted from `registry-surface.ts` to keep that module under the
 * god-module ceiling).
 *
 * These are the session-posture config switches (tool profile, identity mode,
 * per-mode sticky model, permission posture). They are pure `ctx`-slot renders
 * — each prints "not wired in this surface" + exit 0 when its slot is absent —
 * and share no state, only the `SlashCommand` shape. None are part of the
 * surface public API; the assembler in `registry-surface.ts` imports them by
 * name into `buildSurfaceSlashCommands`. Sibling of the `/focus-chain`,
 * `/effort`, `/brief` config cluster in `focus-effort-brief.ts`. Pure code
 * motion: bodies are byte-identical to the pre-split file.
 */

import type { SlashCommand } from "../../slash-contract"

export const profileCmd: SlashCommand = {
  name: "/profile",
  describe: "Show or switch the active tool profile (ADR-0213)",
  category: "config",
  async run(args, ctx) {
    if (ctx.profile === undefined) {
      ctx.out("/profile: not wired in this surface\n")
      return 0
    }
    if (args.length === 0) {
      const current = ctx.profile.get()
      const list = ctx.profile.list().join(", ")
      ctx.out(`/profile: current = ${current}\n`)
      ctx.out(`/profile: available = ${list}\n`)
      return 0
    }
    if (args.length > 1) {
      ctx.err(`/profile: takes at most one argument; got ${args.length}\n`)
      return 1
    }
    const name = args[0] as string
    const res = ctx.profile.set(name)
    if (res === "ok") {
      ctx.out(`/profile: set to '${name}'\n`)
      return 0
    }
    ctx.err(`/profile: unknown profile '${name}'; known = ${res.known.join(", ")}\n`)
    return 1
  },
}

export const identityCmd: SlashCommand = {
  name: "/identity",
  describe: "Show or switch the active identity mode (ADR-0211)",
  category: "config",
  async run(args, ctx) {
    if (ctx.identity === undefined) {
      ctx.out("/identity: not wired in this surface\n")
      return 0
    }
    if (args.length === 0) {
      const current = ctx.identity.get()
      const list = ctx.identity.list().join(", ")
      ctx.out(`/identity: current = ${current}\n`)
      ctx.out(`/identity: available = ${list}\n`)
      return 0
    }
    if (args.length > 1) {
      ctx.err(`/identity: takes at most one argument; got ${args.length}\n`)
      return 1
    }
    const mode = args[0] as string
    const res = ctx.identity.set(mode)
    if (res === "ok") {
      ctx.out(`/identity: set to '${mode}'\n`)
      return 0
    }
    ctx.err(`/identity: unknown mode '${mode}'; known = ${res.known.join(", ")}\n`)
    return 1
  },
}

export const stickyModelCmd: SlashCommand = {
  name: "/sticky-model",
  describe: "Show or set the per-mode sticky model (ADR-0462)",
  category: "config",
  async run(args, ctx) {
    if (ctx.stickyModel === undefined) {
      ctx.out("/sticky-model: not wired in this surface\n")
      return 0
    }
    if (args.length === 0) {
      const snapshot = await ctx.stickyModel.list()
      const entries = Object.entries(snapshot)
      if (entries.length === 0) ctx.out("/sticky-model: no per-mode models set\n")
      else for (const [mode, modelId] of entries) ctx.out(`/sticky-model: ${mode} = ${modelId}\n`)
      ctx.out(`/sticky-model: modes = ${ctx.stickyModel.modes().join(", ")}\n`)
      ctx.out("/sticky-model: usage = /sticky-model <mode> <modelId>\n")
      return 0
    }
    if (args.length !== 2) {
      ctx.err(`/sticky-model: usage = /sticky-model <mode> <modelId> (got ${args.length} arg(s))\n`)
      return 1
    }
    const mode = args[0] as string
    const modelId = args[1] as string
    const res = await ctx.stickyModel.set(mode, modelId)
    if (res === "ok") {
      ctx.out(`/sticky-model: ${mode} → ${modelId}\n`)
      return 0
    }
    if (res.kind === "invalid-mode") {
      ctx.err(`/sticky-model: unknown mode '${mode}'; known = ${res.known.join(", ")}\n`)
      return 1
    }
    ctx.err(`/sticky-model: write failed — ${res.message}\n`)
    return 1
  },
  complete: (args, partial, ctx) => {
    if (ctx.stickyModel === undefined) return []
    const seed = partial.toLowerCase()
    // arg 0 = <mode>; arg 1 = <modelId>. `args` excludes the partial token, so
    // length 0 ⇒ completing the mode, length 1 ⇒ completing the modelId.
    if (args.length === 0) {
      return ctx.stickyModel
        .modes()
        .filter((m) => m.toLowerCase().startsWith(seed))
        .map((m) => ({ value: m, kind: "argument" as const }))
    }
    if (args.length === 1) {
      return ctx.stickyModel
        .candidates()
        .filter((id) => id.toLowerCase().startsWith(seed))
        .map((id) => ({ value: id, kind: "argument" as const }))
    }
    return []
  },
}

/** #13 — `/mode` interactive permission-posture switch (RFC-08 mode-cycle, the
 *  non-keyboard counterpart to shift+tab). No args ⇒ show the active rung + the
 *  selectable list; one named arg ⇒ jump to it. The wire mutates the SAME
 *  `ModeCycleStore` the session loop projects into `permissionModeState` before
 *  each turn, so the new posture applies on the NEXT submitted prompt. `bypass`
 *  is reachable without a second confirm — parity with shift+tab's 4-rung cycle,
 *  whose bypass rung the user already opted into unconfirmed. */
export const modeCmd: SlashCommand = {
  name: "/mode",
  describe: "Show or switch permission posture (default|acceptEdits|plan|bypass)",
  category: "config",
  async run(args, ctx) {
    if (ctx.mode === undefined) {
      ctx.out("/mode: not wired in this surface\n")
      return 0
    }
    const { get, set, list } = ctx.mode
    if (args.length === 0) {
      const cur = get()
      ctx.out(`🔐 permission mode: ${cur}\n`)
      for (const key of list()) ctx.out(` ${key === cur ? "*" : " "} ${key}\n`)
      ctx.out("use: /mode <name>\n")
      return 0
    }
    if (args.length > 1) {
      ctx.err(`/mode: takes at most one argument; got ${args.length}\n`)
      return 1
    }
    const arg = (args[0] as string).trim()
    const result = set(arg)
    if (result !== "ok") {
      ctx.err(`/mode: unknown posture '${arg}'; known = ${result.known.join(", ")}\n`)
      return 1
    }
    ctx.out(`🔐 permission mode: ${get()}\n`)
    return 0
  },
  complete: (args, partial, ctx) => {
    if (ctx.mode === undefined || args.length >= 1) return []
    const seed = partial.toLowerCase()
    return ctx.mode
      .list()
      .filter((k) => k.toLowerCase().startsWith(seed))
      .map((k) => ({ value: k, kind: "argument" as const }))
  },
}
