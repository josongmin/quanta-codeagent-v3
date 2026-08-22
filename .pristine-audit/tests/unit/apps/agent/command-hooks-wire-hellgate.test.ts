/**
 * ADR-0454 jun-02 wire hellgate — disk-configured command hooks are INSTALLED
 * onto the agent's HookBus at the composition root, not merely a library seam.
 *
 * The slice (gate / runner / sandbox-exec / installer) + its 25 hellgate cases
 * (injection-safety, exit≠0/timeout deny, verdict mapping) were landed but NO
 * root called `installCommandHooks` — the fc maturity was corrected L3→L2. This
 * proves the root wire that closes the seam, WITHOUT running any real shell (the
 * armed path only CONSTRUCTS the exec port; nothing spawns until a bus emit,
 * which the slice hellgate already covers with a fake exec):
 *
 *   HELL-CHW-01  QUANTA_COMMAND_HOOKS unset ⇒ helper no-op (no bus minted,
 *                base.hooks untouched; default-OFF byte-identical).
 *   HELL-CHW-02  enabled WITHOUT acknowledgedRisk ⇒ THROWS at startup
 *                (fail-fast — arming arbitrary shell without an audit-grade
 *                acknowledgement must never proceed).
 *   HELL-CHW-03  enabled + ack but ZERO bindings ⇒ disarmed ⇒ no-op (no bus
 *                minted) — an armed-but-empty config installs nothing.
 *   HELL-CHW-04  enabled + ack + a binding ⇒ ARMED ⇒ a bus is minted onto
 *                base.hooks (the install ran).
 *   HELL-CHW-05  enabled + ack + a binding + base ALREADY has a bus ⇒ the
 *                existing bus is REUSED (command hooks compose with the
 *                observability bus, not a second one).
 */
import { describe, expect, it } from "bun:test"
import { installCommandHooksIntoBase } from "@/../src/apps/agent/index"
import { HookBus } from "@/agent"
import {
  COMMAND_HOOKS_ENABLED_WITHOUT_ACK_MESSAGE,
  type CommandHookBinding,
} from "@/agent/command-hooks"

// Minimal base shape the helper touches (cwd + the writable hooks slot).
const makeBase = (hooks?: HookBus) =>
  ({ cwd: "/tmp/quanta-test", ...(hooks !== undefined ? { hooks } : {}) }) as unknown as Parameters<
    typeof installCommandHooksIntoBase
  >[0]

const BINDING: CommandHookBinding = { event: "PreToolUse", command: "true" }

describe("ADR-0454 wire — command hooks at the agent composition root", () => {
  it("HELL-CHW-01: knob unset ⇒ no-op (no bus minted, default-OFF)", () => {
    const base = makeBase()
    installCommandHooksIntoBase(base, {} as NodeJS.ProcessEnv, [BINDING])
    expect(base.hooks).toBeUndefined()
  })

  it("HELL-CHW-02: enabled WITHOUT ack ⇒ throws at startup (fail-fast)", () => {
    const base = makeBase()
    expect(() =>
      installCommandHooksIntoBase(base, { QUANTA_COMMAND_HOOKS: "1" } as NodeJS.ProcessEnv, [
        BINDING,
      ]),
    ).toThrow(COMMAND_HOOKS_ENABLED_WITHOUT_ACK_MESSAGE)
  })

  it("HELL-CHW-03: enabled + ack + ZERO bindings ⇒ disarmed ⇒ no-op", () => {
    const base = makeBase()
    installCommandHooksIntoBase(
      base,
      { QUANTA_COMMAND_HOOKS: "1", QUANTA_COMMAND_HOOKS_ACK: "I accept" } as NodeJS.ProcessEnv,
      [],
    )
    expect(base.hooks).toBeUndefined()
  })

  it("HELL-CHW-04: enabled + ack + a binding ⇒ armed ⇒ bus minted (install ran)", () => {
    const base = makeBase()
    installCommandHooksIntoBase(
      base,
      { QUANTA_COMMAND_HOOKS: "1", QUANTA_COMMAND_HOOKS_ACK: "I accept" } as NodeJS.ProcessEnv,
      [BINDING],
    )
    expect(base.hooks).toBeInstanceOf(HookBus)
  })

  it("HELL-CHW-05: armed + base already has a bus ⇒ reuses it (no second bus)", () => {
    const existing = new HookBus()
    const base = makeBase(existing)
    installCommandHooksIntoBase(
      base,
      { QUANTA_COMMAND_HOOKS: "1", QUANTA_COMMAND_HOOKS_ACK: "I accept" } as NodeJS.ProcessEnv,
      [BINDING],
    )
    expect(base.hooks).toBe(existing)
  })
})
