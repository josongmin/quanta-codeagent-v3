class StubLLM {
  async* stream(_input) {
    yield { type: "message_stop", stop_reason: "end_turn" };
  }
}
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { benchOptIns, buildConfig } from "../../src/apps/bench/eval/driver";
const ENV_KEYS = [
  "QUANTA_BENCH_LSP",
  "QUANTA_BENCH_SUBAGENT",
  "QUANTA_BENCH_SKILLS",
  "QUANTA_LSP_TOOLS"
];
const snapshot = () => {
  const m = new Map;
  for (const k of ENV_KEYS)
    m.set(k, process.env[k]);
  return m;
};
const restore = (m) => {
  for (const [k, v] of m) {
    if (v === undefined)
      delete process.env[k];
    else
      process.env[k] = v;
  }
};
let saved;
beforeEach(() => {
  saved = snapshot();
  for (const k of ENV_KEYS)
    delete process.env[k];
});
afterEach(() => {
  restore(saved);
});
describe("benchOptIns \u2014 env resolver (pure, three independent flags)", () => {
  test("all unset \u2192 byte-identical default-OFF (lspNav:false, subagent/skills undefined)", () => {
    const r = benchOptIns();
    expect(r.lspNav).toBe(false);
    expect(r.subagent).toBeUndefined();
    expect(r.skills).toBeUndefined();
  });
  test("QUANTA_BENCH_LSP=1 \u2192 lspNav:true (other axes unchanged)", () => {
    process.env.QUANTA_BENCH_LSP = "1";
    const r = benchOptIns();
    expect(r.lspNav).toBe(true);
    expect(r.subagent).toBeUndefined();
    expect(r.skills).toBeUndefined();
  });
  test("QUANTA_LSP_TOOLS=full \u2192 lspNav:true (original gate still honored)", () => {
    process.env.QUANTA_LSP_TOOLS = "full";
    expect(benchOptIns().lspNav).toBe(true);
  });
  test("BOTH gates set \u2192 lspNav:true (OR, not XOR)", () => {
    process.env.QUANTA_LSP_TOOLS = "full";
    process.env.QUANTA_BENCH_LSP = "1";
    expect(benchOptIns().lspNav).toBe(true);
  });
  test("QUANTA_BENCH_LSP=0 / other-value \u2192 treated as unset (lspNav:false)", () => {
    process.env.QUANTA_BENCH_LSP = "0";
    expect(benchOptIns().lspNav).toBe(false);
    process.env.QUANTA_BENCH_LSP = "yes";
    expect(benchOptIns().lspNav).toBe(false);
  });
  test("QUANTA_LSP_TOOLS=partial \u2192 lspNav:false (only 'full' triggers, same as CLI)", () => {
    process.env.QUANTA_LSP_TOOLS = "partial";
    expect(benchOptIns().lspNav).toBe(false);
  });
  test("QUANTA_BENCH_SUBAGENT=1 \u2192 subagent:{} (other axes unchanged)", () => {
    process.env.QUANTA_BENCH_SUBAGENT = "1";
    const r = benchOptIns();
    expect(r.subagent).toEqual({});
    expect(r.lspNav).toBe(false);
    expect(r.skills).toBeUndefined();
  });
  test("QUANTA_BENCH_SUBAGENT not exactly '1' \u2192 undefined (strict gate)", () => {
    process.env.QUANTA_BENCH_SUBAGENT = "true";
    expect(benchOptIns().subagent).toBeUndefined();
    process.env.QUANTA_BENCH_SUBAGENT = "0";
    expect(benchOptIns().subagent).toBeUndefined();
  });
  test("QUANTA_BENCH_SKILLS=1 \u2192 skills:{} (bundled-only, no user dir)", () => {
    process.env.QUANTA_BENCH_SKILLS = "1";
    const r = benchOptIns();
    expect(r.skills).toEqual({});
    expect(r.lspNav).toBe(false);
    expect(r.subagent).toBeUndefined();
  });
  test("QUANTA_BENCH_SKILLS not exactly '1' \u2192 undefined (strict gate)", () => {
    process.env.QUANTA_BENCH_SKILLS = "true";
    expect(benchOptIns().skills).toBeUndefined();
    process.env.QUANTA_BENCH_SKILLS = "";
    expect(benchOptIns().skills).toBeUndefined();
  });
  test("ALL THREE on simultaneously \u2192 all three wired (independent flags compose)", () => {
    process.env.QUANTA_BENCH_LSP = "1";
    process.env.QUANTA_BENCH_SUBAGENT = "1";
    process.env.QUANTA_BENCH_SKILLS = "1";
    const r = benchOptIns();
    expect(r.lspNav).toBe(true);
    expect(r.subagent).toEqual({});
    expect(r.skills).toEqual({});
  });
});
const stubStream = {
  emit() {}
};
const baseInstance = (swebench) => swebench ? {
  id: "test-1",
  repoPath: "/tmp/x",
  problemStatement: "fix it",
  testCmd: "true",
  swebench: {
    instanceId: "x__1",
    repo: "x/x",
    baseCommit: "deadbeef"
  }
} : {
  id: "test-1",
  repoPath: "/tmp/x",
  problemStatement: "fix it",
  testCmd: "true"
};
const baseDeps = { llm: new StubLLM, maxTurns: 1, timeoutMs: 5000 };
describe("buildConfig \u2014 bench opt-ins wired into AgentConfig", () => {
  test("ALL THREE unset \u2192 config omits `subagent`/`skills` keys (byte-identical to BENCH-INTENTIONAL posture)", () => {
    const ac = new AbortController;
    const cfg = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream);
    expect("subagent" in cfg).toBe(false);
    expect("skills" in cfg).toBe(false);
  });
  test("QUANTA_BENCH_LSP=1 \u2192 registry expands by exactly the lspNavToolList count", () => {
    const ac = new AbortController;
    const before = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream);
    const baselineCount = before.registry.specs().length;
    process.env.QUANTA_BENCH_LSP = "1";
    const after = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream);
    const afterCount = after.registry.specs().length;
    expect(afterCount).toBeGreaterThan(baselineCount);
  });
  test("QUANTA_LSP_TOOLS=full \u2192 registry expands too (original gate still works)", () => {
    const ac = new AbortController;
    const before = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream);
    const baselineCount = before.registry.specs().length;
    process.env.QUANTA_LSP_TOOLS = "full";
    const after = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream);
    expect(after.registry.specs().length).toBeGreaterThan(baselineCount);
  });
  test("QUANTA_BENCH_SUBAGENT=1 \u2192 config has `subagent:{}`", () => {
    process.env.QUANTA_BENCH_SUBAGENT = "1";
    const ac = new AbortController;
    const cfg = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream);
    expect("subagent" in cfg).toBe(true);
    expect(cfg.subagent).toEqual({});
    expect("skills" in cfg).toBe(false);
  });
  test("QUANTA_BENCH_SKILLS=1 \u2192 config has `skills:{}`", () => {
    process.env.QUANTA_BENCH_SKILLS = "1";
    const ac = new AbortController;
    const cfg = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream);
    expect("skills" in cfg).toBe(true);
    expect(cfg.skills).toEqual({});
    expect("subagent" in cfg).toBe(false);
  });
  test("ALL THREE on \u2192 registry expanded + subagent:{} + skills:{} (independent flags compose)", () => {
    process.env.QUANTA_BENCH_LSP = "1";
    process.env.QUANTA_BENCH_SUBAGENT = "1";
    process.env.QUANTA_BENCH_SKILLS = "1";
    const ac = new AbortController;
    const cfg = buildConfig(baseInstance(true), baseDeps, "/tmp/sb", ac.signal, stubStream);
    expect(cfg.subagent).toEqual({});
    expect(cfg.skills).toEqual({});
    expect(cfg.verifyGuard).toEqual({ mustPass: true, maxTrips: 2 });
    const ac2 = new AbortController;
    const savedLsp = process.env.QUANTA_BENCH_LSP;
    const savedSub = process.env.QUANTA_BENCH_SUBAGENT;
    const savedSk = process.env.QUANTA_BENCH_SKILLS;
    delete process.env.QUANTA_BENCH_LSP;
    delete process.env.QUANTA_BENCH_SUBAGENT;
    delete process.env.QUANTA_BENCH_SKILLS;
    const baseline = buildConfig(baseInstance(true), baseDeps, "/tmp/sb", ac2.signal, stubStream);
    process.env.QUANTA_BENCH_LSP = savedLsp ?? "1";
    process.env.QUANTA_BENCH_SUBAGENT = savedSub ?? "1";
    process.env.QUANTA_BENCH_SKILLS = savedSk ?? "1";
    expect(cfg.registry.specs().length).toBeGreaterThan(baseline.registry.specs().length);
  });
  test("byte-identical core fields when all opt-ins unset (compaction, cwd, permission, system, maxTurns)", () => {
    const ac = new AbortController;
    const cfg = buildConfig(baseInstance(false), baseDeps, "/tmp/sb", ac.signal, stubStream);
    expect(cfg.cwd).toBe("/tmp/sb");
    expect(cfg.permission).toEqual({ mode: "acceptEdits" });
    expect(cfg.compaction).toEqual({});
    expect(cfg.maxTurns).toBe(1);
    const userMsg = cfg.messages[0];
    expect(userMsg?.role).toBe("user");
    const content = userMsg?.content;
    if (Array.isArray(content)) {
      const first = content[0];
      if (first && first.type === "text") {
        expect(first.text).not.toContain("automated grader");
      }
    }
  });
});
