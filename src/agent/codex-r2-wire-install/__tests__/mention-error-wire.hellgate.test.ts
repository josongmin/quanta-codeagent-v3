/**
 * Fix 4 WIRING (jul-2) — the mention resolver's per-mention `onError` sink is
 * actually delivered to `cfg.stream.emit`, not left inert. resolver.ts gained the
 * `onError` capability, but a failed `@`-mention only surfaces if the installer
 * threads a sink into `buildInjectionFragments`. This pins that end-to-end wire:
 * a throwing resolver ⇒ exactly one non-fatal `error` event on the stream.
 *
 * RED-on-inert: drop the `onError` arg at install.ts's buildMentionInjector call
 * and this asserts 0 error events → fails.
 */

import { describe, expect, test } from "bun:test"
import type { MentionResolverPort } from "@/agent/mention-injection"
import type { AgentConfig } from "@/agent/types"
import { installCodexR2Wires } from "../install"

const cfgWithStream = (events: unknown[]): AgentConfig =>
  ({ stream: { emit: (e: unknown) => events.push(e) } }) as unknown as AgentConfig

const isError = (e: unknown): e is { type: "error"; message: string } =>
  typeof e === "object" && e !== null && (e as { type?: unknown }).type === "error"

describe("Fix 4 wiring — failed @mention resolution emits a stream error (LIVE, not inert)", () => {
  test("a throwing resolver surfaces exactly one non-fatal error event", async () => {
    const throwingResolver: MentionResolverPort = {
      resolveSkill: async () => {
        throw new Error("boom skill resolve")
      },
      resolvePlugin: async () => null,
      resolveApp: async () => null,
    }
    const events: unknown[] = []
    const cfg = cfgWithStream(events)
    installCodexR2Wires(cfg, { mentionResolver: throwingResolver })
    expect(cfg.mentionInjector).toBeDefined()

    const msgs = (await cfg.mentionInjector?.("hey @demo please")) ?? []
    expect(msgs.length).toBe(0) // degrades clean
    const errs = events.filter(isError)
    expect(errs.length).toBe(1) // the failed resolution is NOT silently swallowed
    expect(errs[0]?.message).toContain("demo")
  })

  test("success path emits NO error event (byte-identical)", async () => {
    const okResolver: MentionResolverPort = {
      resolveSkill: async (t) => ({ bodyText: `skill:${t}` }),
      resolvePlugin: async () => null,
      resolveApp: async () => null,
    }
    const events: unknown[] = []
    const cfg = cfgWithStream(events)
    installCodexR2Wires(cfg, { mentionResolver: okResolver })
    await cfg.mentionInjector?.("hey @demo please")
    expect(events.filter(isError).length).toBe(0)
  })
})
