import { beforeEach, describe, expect, test } from "bun:test";
import { checkDispatchAllowed } from "@/agent/dispatch-seam-guard";
import {
  applyDeveloperModeTransition,
  assertNotMutatingInPlanMode,
  InvalidModeTransitionError,
  isMutatingTool,
  PlanModeMutatingBlockedError,
  planModeMutatingTable,
  UnknownToolError
} from "@/agent/mode";
import { __resetRuntimeConfig } from "@/shared";
import {
  createUpdateWorkingStateTool,
  defaultTools,
  gitTools,
  lspNavTools,
  nullLspNavProvider,
  requestUserInputTool
} from "@/tool";
const QUANTA_ENV_KEYS = Object.keys(process.env).filter((k) => k.startsWith("QUANTA_"));
const QUANTA_ENV_BASELINE = Object.fromEntries(QUANTA_ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("QUANTA_") && !(k in QUANTA_ENV_BASELINE))
      delete process.env[k];
  }
  for (const [k, v] of Object.entries(QUANTA_ENV_BASELINE)) {
    if (v === undefined)
      delete process.env[k];
    else
      process.env[k] = v;
  }
  __resetRuntimeConfig();
});
const ALL_REGISTERED_TOOL_NAMES = (() => {
  const names = new Set;
  for (const t of defaultTools)
    names.add(t.name);
  for (const t of gitTools())
    names.add(t.name);
  for (const t of lspNavTools(nullLspNavProvider))
    names.add(t.name);
  names.add(createUpdateWorkingStateTool(undefined).name);
  names.add(requestUserInputTool().name);
  return [...names].sort();
})();
const PLAN = "plan";
const DEFAULT = "default";
describe("Scenario 1 \u2014 tool-registry exhaustiveness drift detector", () => {
  test("every registered tool has an entry in MUTATING_TOOL_TABLE", () => {
    const table = planModeMutatingTable();
    const missing = [];
    for (const name of ALL_REGISTERED_TOOL_NAMES) {
      if (!(name in table))
        missing.push(name);
    }
    if (missing.length > 0) {
      throw new Error(`tool(s) missing from MUTATING_TOOL_TABLE: ${missing.join(", ")} \u2014 ` + `every registered tool must classify its mutating kind in src/agent/mode.ts so plan mode cannot silently allow new tools.`);
    }
    expect(missing).toEqual([]);
  });
  test("isMutatingTool returns a strict boolean for every registered tool (never throws)", () => {
    for (const name of ALL_REGISTERED_TOOL_NAMES) {
      const v = isMutatingTool(name);
      expect(typeof v).toBe("boolean");
      expect(v === true || v === false).toBe(true);
    }
  });
  test("MUTATING_TOOL_TABLE has no orphan entries (every key maps to a real tool)", () => {
    const table = planModeMutatingTable();
    const known = new Set(ALL_REGISTERED_TOOL_NAMES);
    const orphans = Object.keys(table).filter((k) => !known.has(k));
    expect(orphans).toEqual([]);
  });
  test("MUTATING_TOOL_TABLE is frozen (cannot be mutated at runtime)", () => {
    const table = planModeMutatingTable();
    expect(Object.isFrozen(table)).toBe(true);
  });
});
describe("Scenario 2 \u2014 plan-mode block matrix (every tool \xD7 every mode)", () => {
  const table = planModeMutatingTable();
  const mutating = Object.entries(table).filter(([, k]) => k !== null).map(([n]) => n);
  const readOnly = Object.entries(table).filter(([, k]) => k === null).map(([n]) => n);
  test("baseline sanity \u2014 both buckets populated", () => {
    expect(mutating.length).toBeGreaterThanOrEqual(5);
    expect(readOnly.length).toBeGreaterThanOrEqual(8);
  });
  for (const name of mutating) {
    test(`plan + mutating "${name}" throws PlanModeMutatingBlockedError carrying tool name`, () => {
      let caught;
      try {
        assertNotMutatingInPlanMode(PLAN, name);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PlanModeMutatingBlockedError);
      const err = caught;
      expect(err.toolName).toBe(name);
      expect(err.message).toContain(`"${name}"`);
      expect(err.message).toContain("plan collaboration mode");
      expect(err.code).toBe("plan_mode_mutating_blocked");
    });
    test(`default + mutating "${name}" does not throw`, () => {
      expect(() => assertNotMutatingInPlanMode(DEFAULT, name)).not.toThrow();
    });
    test(`dispatch guard: plan + mutating "${name}" \u2192 ok:false with typed reason`, () => {
      const r = checkDispatchAllowed({ collaborationMode: PLAN }, { name });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBeInstanceOf(PlanModeMutatingBlockedError);
        expect(r.reason.toolName).toBe(name);
      }
    });
    test(`dispatch guard: default + mutating "${name}" \u2192 ok:true`, () => {
      const r = checkDispatchAllowed({ collaborationMode: DEFAULT }, { name });
      expect(r.ok).toBe(true);
    });
  }
  for (const name of readOnly) {
    test(`plan + read-only "${name}" does not throw`, () => {
      expect(() => assertNotMutatingInPlanMode(PLAN, name)).not.toThrow();
    });
    test(`default + read-only "${name}" does not throw`, () => {
      expect(() => assertNotMutatingInPlanMode(DEFAULT, name)).not.toThrow();
    });
    test(`dispatch guard: plan + read-only "${name}" \u2192 ok:true`, () => {
      const r = checkDispatchAllowed({ collaborationMode: PLAN }, { name });
      expect(r.ok).toBe(true);
    });
  }
});
describe("Scenario 3 \u2014 applyDeveloperModeTransition state machine", () => {
  test("default + mode=plan \u2192 plan", () => {
    expect(applyDeveloperModeTransition("default", "mode=plan")).toBe("plan");
  });
  test("plan + mode=default \u2192 default", () => {
    expect(applyDeveloperModeTransition("plan", "mode=default")).toBe("default");
  });
  test("default + mode=default \u2192 default (no-op)", () => {
    expect(applyDeveloperModeTransition("default", "mode=default")).toBe("default");
  });
  test("plan + mode=plan \u2192 plan (no-op)", () => {
    expect(applyDeveloperModeTransition("plan", "mode=plan")).toBe("plan");
  });
  const INVALID_THROW = [
    { form: "mode=audit", attempted: "audit" },
    { form: "mode=review", attempted: "review" },
    { form: "mode=bypass", attempted: "bypass" },
    { form: "mode=foo_bar", attempted: "foo_bar" },
    { form: "  mode = audit  ", attempted: "audit" },
    { form: "mode=admin", attempted: "admin" }
  ];
  for (const { form, attempted } of INVALID_THROW) {
    test(`invalid directive "${form}" from default \u2192 throws InvalidModeTransitionError(attempted="${attempted}")`, () => {
      let caught;
      try {
        applyDeveloperModeTransition("default", form);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidModeTransitionError);
      expect(caught.attempted).toBe(attempted);
    });
    test(`invalid directive "${form}" from plan \u2192 throws and does not silently transition`, () => {
      expect(() => applyDeveloperModeTransition("plan", form)).toThrow(InvalidModeTransitionError);
    });
  }
  const NON_DIRECTIVE = [
    "MODE=PLAN",
    "Mode=Plan",
    "plan",
    "",
    `mode=plan
mode=default`,
    "mode=plan extra",
    "prefix mode=plan",
    "mode==plan",
    "mode:plan",
    "MODE = plan"
  ];
  for (const form of NON_DIRECTIVE) {
    test(`non-directive form ${JSON.stringify(form)} from default \u2192 no transition`, () => {
      expect(applyDeveloperModeTransition("default", form)).toBe("default");
    });
    test(`non-directive form ${JSON.stringify(form)} from plan \u2192 no transition`, () => {
      expect(applyDeveloperModeTransition("plan", form)).toBe("plan");
    });
  }
  test("whitespace-only `  mode = plan  ` (single-line) is a VALID directive", () => {
    expect(applyDeveloperModeTransition("default", "  mode = plan  ")).toBe("plan");
  });
});
describe("Scenario 4 \u2014 sticky transition under 50 interleaved dispatch calls", () => {
  test("checkDispatchAllowed never mutates the turnState mode", () => {
    const turnState = { collaborationMode: "plan" };
    const toolNames = ["read", "grep", "write", "edit", "bash"];
    for (let i = 0;i < 50; i++) {
      const name = toolNames[i % toolNames.length] ?? "read";
      checkDispatchAllowed(turnState, { name });
      expect(turnState.collaborationMode).toBe("plan");
    }
  });
  test("only developer-channel directive transitions; user/tool messages do not", () => {
    let mode = "default";
    mode = applyDeveloperModeTransition(mode, "mode=plan");
    expect(mode).toBe("plan");
    const noise = [
      "hello",
      "tool result: file written",
      "user said please continue",
      "the patch applied cleanly",
      "anything not matching the directive regex"
    ];
    for (let i = 0;i < 50; i++) {
      const msg = noise[i % noise.length] ?? "";
      mode = applyDeveloperModeTransition(mode, msg);
      expect(mode).toBe("plan");
    }
    mode = applyDeveloperModeTransition(mode, "mode=default");
    expect(mode).toBe("default");
  });
});
describe("Scenario 5 \u2014 100-way Promise.all dispatch under mixed modes", () => {
  test("each call returns the correct per-turnState decision (no shared state)", async () => {
    const cases = Array.from({ length: 100 }, (_, i) => {
      const mode = i % 2 === 0 ? "plan" : "default";
      const toolPool = ["read", "grep", "write", "edit", "bash", "update_working_state", "glob"];
      const name = toolPool[i % toolPool.length] ?? "read";
      return { mode, name, idx: i };
    });
    const results = await Promise.all(cases.map((c) => Promise.resolve(checkDispatchAllowed({ collaborationMode: c.mode }, { name: c.name })).then((r) => ({ ...c, r }))));
    for (const { mode, name, r } of results) {
      const blockedExpected = mode === "plan" && isMutatingTool(name);
      if (blockedExpected) {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.reason).toBeInstanceOf(PlanModeMutatingBlockedError);
          expect(r.reason.toolName).toBe(name);
        }
      } else {
        expect(r.ok).toBe(true);
      }
    }
  });
});
describe("Scenario 6 \u2014 UnknownToolError specificity", () => {
  test("isMutatingTool throws UnknownToolError carrying exact tool name", () => {
    let caught;
    try {
      isMutatingTool("nonexistent-tool");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownToolError);
    const err = caught;
    expect(err.toolName).toBe("nonexistent-tool");
    expect(err.message).toContain("nonexistent-tool");
    expect(err.code).toBe("unknown_tool");
  });
  test("assertNotMutatingInPlanMode('plan', unknown) THROWS \u2014 fail-loud", () => {
    let caught;
    try {
      assertNotMutatingInPlanMode("plan", "nonexistent-tool");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownToolError);
    expect(caught.toolName).toBe("nonexistent-tool");
  });
  test("assertNotMutatingInPlanMode('default', unknown) is silent (short-circuit)", () => {
    expect(() => assertNotMutatingInPlanMode("default", "nonexistent-tool")).not.toThrow();
  });
  test("checkDispatchAllowed surfaces UnknownToolError as ok:false reason in plan mode", () => {
    const r = checkDispatchAllowed({ collaborationMode: "plan" }, { name: "nonexistent-tool" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBeInstanceOf(UnknownToolError);
      expect(r.reason.toolName).toBe("nonexistent-tool");
    }
  });
  test("checkDispatchAllowed in default mode returns ok:true even for unknown tool", () => {
    const r = checkDispatchAllowed({ collaborationMode: "default" }, { name: "nonexistent-tool" });
    expect(r.ok).toBe(true);
  });
});
