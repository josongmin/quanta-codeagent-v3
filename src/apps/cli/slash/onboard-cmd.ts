/**
 * B1 (jul-03) — `/onboard` surface.
 *
 * `onboarding` is a first-session-priming IDENTITY mode (explicit, asks before
 * mutating). Until now it was reachable ONLY via the `--identity-mode onboarding`
 * LAUNCH flag — there was no in-session path to enter it. `/onboard` (and
 * `/identity onboarding`) close that gap.
 *
 * `/onboard` targets the SAME `ctx.identity` wire `/identity` uses, calling
 * `set("onboarding")`. The identity adapter routes the onboarding virtual mode
 * through its dedicated `onOnboarding` hook (it is NOT a `ModeVariantKey`, so it
 * cannot ride the mode-variant registry — see `identity-mode-adapter.ts`). Absent
 * identity wire OR an adapter without the onboarding hook ⇒ `/onboard` prints a
 * clean "not wired" / rejects — default-OFF byte-identical.
 */

import type { SlashCommand, SlashContext } from "../slash-contract"

/** `/onboard` — switch the session into the onboarding identity mode. */
export const onboardCmd: SlashCommand = {
  name: "/onboard",
  describe: "Enter onboarding identity mode (first-session priming; also /identity onboarding)",
  category: "config",
  async run(args: readonly string[], ctx: SlashContext): Promise<number> {
    if (ctx.identity === undefined) {
      ctx.out("/onboard: not wired in this surface\n")
      return 0
    }
    if (args.length > 0) {
      ctx.err("/onboard: takes no arguments\n")
      return 1
    }
    const res = ctx.identity.set("onboarding")
    if (res === "ok") {
      ctx.out("/onboard: identity set to 'onboarding'\n")
      return 0
    }
    // The adapter rejects onboarding when its hook is not wired (byte-identical to
    // the pre-B1 behavior). Surface the known targets so the user sees the options.
    ctx.err(`/onboard: onboarding not available here; known = ${res.known.join(", ")}\n`)
    return 1
  },
}
