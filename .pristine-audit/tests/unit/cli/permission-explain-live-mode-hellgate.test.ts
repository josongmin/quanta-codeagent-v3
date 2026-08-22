import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { permissionCmd } from "../../../src/apps/cli/permission-explain"
import type { SlashContext } from "../../../src/apps/cli/slash-commands"
import type {
  DenialRecord,
  HostAgentMode,
  ThreadPermission,
} from "../../../src/permission/permission-store"
import { setColorPolicy } from "../../../src/ui/ui-helpers"

/**
 * UUX-4-04 hellgate — `/permission` must stop lying about the live posture.
 *
 * Before this fix `permission-explain.ts` hardcoded `DEFAULT_MODE="default"`
 * and ignored BOTH the live permission mode (the `SlashContext.mode` wire the
 * shift+tab cycle / `/mode` mutate) AND the persistent `PermissionStore`
 * (thread grants / host modes / post-denial overrides). An operator in
 * `bypass` saw an inspector confidently describing `default`.
 *
 * Cases:
 *   - live mode on the ctx ⇒ summary + explain pipeline reflect it (RED)
 *   - rung keys map through the mode-cycle projection ("plan" ⇒ permission
 *     mode "default"; "bypass" ⇒ "bypass")
 *   - a throwing / absent mode getter degrades to "default" (old ctx shapes)
 *   - a store grant on the ctx ⇒ the explanation includes it (RED)
 *   - no store slot ⇒ no store section (byte-compatible degrade)
 */

interface Captured {
  readonly ctx: SlashContext
  readonly out: () => string
  readonly err: () => string
}

const buildCtx = (extra: Record<string, unknown> = {}): Captured => {
  const cap = { out: "", err: "" }
  const ctx = {
    out: (s: string) => {
      cap.out += s
    },
    err: (s: string) => {
      cap.err += s
    },
    cwd: "/tmp/work",
    ...extra,
  } as SlashContext
  return { ctx, out: () => cap.out, err: () => cap.err }
}

const modeWire = (key: string) => ({
  get: () => key,
  set: () => "ok" as const,
  list: () => ["default", "acceptEdits", "plan", "bypass"],
})

/** Narrow store-view fake (the slot is a read-only structural view, so tests
 *  never have to fabricate the full PermissionStore surface). */
const storeView = (opts: {
  thread?: ThreadPermission
  threads?: ReadonlyMap<string, ThreadPermission>
  hosts?: ReadonlyMap<string, HostAgentMode>
  denials?: readonly DenialRecord[]
}) => ({
  getThread: (_id: string) => opts.thread,
  listThreads: () => opts.threads ?? new Map<string, ThreadPermission>(),
  listHosts: () => opts.hosts ?? new Map<string, HostAgentMode>(),
  listThreadDenials: (_id: string) => opts.denials ?? [],
})

beforeEach(() => {
  setColorPolicy("off")
})
afterEach(() => {
  setColorPolicy(null)
})

describe("/permission live mode (UUX-4-04)", () => {
  test("RED-CORE: summary reflects a non-default live mode from ctx.mode", async () => {
    const cap = buildCtx({ mode: modeWire("acceptEdits") })
    const code = await permissionCmd.run([], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out()).toContain("acceptEdits")
    // Whole-word honesty: the Mode line must not still claim "default".
    expect(cap.out()).toContain("Mode:")
    const modeLine = cap
      .out()
      .split("\n")
      .find((l) => l.includes("Mode:"))
    expect(modeLine).toContain("acceptEdits")
  })

  test("RED-CORE: explain pipeline runs against the live mode (bypass)", async () => {
    const cap = buildCtx({ mode: modeWire("bypass") })
    const code = await permissionCmd.run(["explain", "bash"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out()).toContain("current mode: bypass")
    expect(cap.out()).toContain("Mode 'bypass'")
  })

  test("rung 'plan' projects onto permission mode 'default' (mode-cycle SSOT)", async () => {
    const cap = buildCtx({ mode: modeWire("plan") })
    const code = await permissionCmd.run(["explain", "bash"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out()).toContain("current mode: default")
  })

  test("adversarial: unknown rung key degrades to 'default' (never crashes)", async () => {
    const cap = buildCtx({ mode: modeWire("frobnicate") })
    const code = await permissionCmd.run(["explain", "bash"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out()).toContain("current mode: default")
  })

  test("adversarial: throwing mode getter degrades to 'default' (never crashes)", async () => {
    const cap = buildCtx({
      mode: {
        get: () => {
          throw new Error("wire died")
        },
        set: () => "ok" as const,
        list: () => [],
      },
    })
    const code = await permissionCmd.run([], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out()).toContain("default")
  })

  test("paired control: absent mode slot (old ctx shape) ⇒ 'default' as before", async () => {
    const cap = buildCtx()
    const code = await permissionCmd.run(["explain", "bash"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out()).toContain("current mode: default")
  })
})

describe("/permission store awareness (UUX-4-04)", () => {
  const grant: ThreadPermission = {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "danger-full-access" },
  }

  test("RED-CORE: a thread grant in the store surfaces in the explanation", async () => {
    const cap = buildCtx({
      permissionInspect: {
        store: storeView({ thread: grant, threads: new Map([["sess-1", grant]]) }),
        threadId: "sess-1",
      },
    })
    const code = await permissionCmd.run(["explain", "bash"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out()).toContain("danger-full-access")
    expect(cap.out()).toContain("never")
  })

  test("host modes + post-denial overrides surface too", async () => {
    const denial: DenialRecord = {
      threadId: "sess-1",
      actionSignature: "sigsig",
      deniedAt: 1,
      deniedReason: "nope",
      seenRiskAt: 2,
      userOverrideAt: 3,
    }
    const cap = buildCtx({
      permissionInspect: {
        store: storeView({
          hosts: new Map<string, HostAgentMode>([["host-a", "read-only"]]),
          denials: [denial],
        }),
        threadId: "sess-1",
      },
    })
    const code = await permissionCmd.run(["explain", "bash"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out()).toContain("host-a")
    expect(cap.out()).toContain("read-only")
    expect(cap.out()).toContain("override")
  })

  test("adversarial: a throwing store read never crashes the inspector", async () => {
    const cap = buildCtx({
      permissionInspect: {
        store: {
          getThread: () => {
            throw new Error("store io died")
          },
          listThreads: () => {
            throw new Error("store io died")
          },
          listHosts: () => {
            throw new Error("store io died")
          },
          listThreadDenials: () => {
            throw new Error("store io died")
          },
        },
        threadId: "sess-1",
      },
    })
    const code = await permissionCmd.run(["explain", "bash"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out()).toContain("Permission · bash")
  })

  test("paired control: no store slot ⇒ no store section, explain unchanged", async () => {
    const cap = buildCtx()
    const code = await permissionCmd.run(["explain", "bash"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out()).not.toContain("Store grants")
    expect(cap.out()).toContain("Permission · bash")
  })

  test("empty store ⇒ explicit empty note (not silently identical to unwired)", async () => {
    const cap = buildCtx({
      permissionInspect: { store: storeView({}), threadId: "sess-1" },
    })
    const code = await permissionCmd.run(["explain", "bash"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out()).toContain("no persistent grants")
  })
})
