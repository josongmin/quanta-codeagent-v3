import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTINS,
  isSlashCommand,
  runSlashCommand
} from "../../src/apps/cli/slash-commands";
const buildCtx = (cwd, prefsPath, sleepImpl) => {
  const captured = {
    out: "",
    err: "",
    prefsPath,
    ctx: {
      out: (s) => {
        captured.out += s;
      },
      err: (s) => {
        captured.err += s;
      },
      cwd,
      prefsPath,
      prefsHome: cwd,
      sleep: sleepImpl
    }
  };
  return captured;
};
let tmp;
let originalPrefsHome;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "slash-"));
  originalPrefsHome = process.env.QUANTA_PREFS_HOME;
  process.env.QUANTA_PREFS_HOME = tmp;
});
afterEach(() => {
  if (originalPrefsHome === undefined)
    delete process.env.QUANTA_PREFS_HOME;
  else
    process.env.QUANTA_PREFS_HOME = originalPrefsHome;
  rmSync(tmp, { recursive: true, force: true });
});
describe("BUILTINS table", () => {
  test("registers the documented builtins in order (/help + 5 surface + /retry-with + /skills + /reload-skills + /login + /logout + /status)", () => {
    expect(BUILTINS.map((c) => c.name)).toEqual([
      "/help",
      "/context",
      "/usage",
      "/color",
      "/navigate",
      "/wait",
      "/retry-with",
      "/skills",
      "/reload-skills",
      "/login",
      "/logout",
      "/status"
    ]);
  });
});
describe("slashCompleter (Tab autocompletion)", () => {
  const importCompleter = async () => (await import("../../src/apps/cli/slash-commands")).slashCompleter;
  test("empty input \u2192 no candidates (don't pollute the agent prompt)", async () => {
    const c = await importCompleter();
    expect(c("")).toEqual([[], ""]);
  });
  test("non-slash input \u2192 no candidates", async () => {
    const c = await importCompleter();
    expect(c("hello")).toEqual([[], "hello"]);
  });
  test("bare `/` \u2192 every builtin + /exit + /quit", async () => {
    const c = await importCompleter();
    const [candidates, partial] = c("/");
    expect(partial).toBe("/");
    expect(candidates).toContain("/login");
    expect(candidates).toContain("/logout");
    expect(candidates).toContain("/status");
    expect(candidates).toContain("/exit");
    expect(candidates).toContain("/quit");
    const sorted = [...candidates].sort();
    expect(candidates).toEqual(sorted);
  });
  test("`/lo` \u2192 /login + /logout only", async () => {
    const c = await importCompleter();
    const [candidates] = c("/lo");
    expect(candidates).toEqual(["/login", "/logout"]);
  });
  test("`/login` \u2192 unique match (Tab completes to this exact string)", async () => {
    const c = await importCompleter();
    const [candidates, partial] = c("/login");
    expect(candidates).toEqual(["/login"]);
    expect(partial).toBe("/login");
  });
  test("unknown slash prefix \u2192 empty list", async () => {
    const c = await importCompleter();
    const [candidates] = c("/zzz-no-such");
    expect(candidates).toEqual([]);
  });
});
describe("isSlashCommand", () => {
  test("/<letter> \u21D2 true", () => {
    expect(isSlashCommand("/context")).toBe(true);
    expect(isSlashCommand("/wait")).toBe(true);
  });
  test("filesystem path (`/path/to/file`) \u21D2 false", () => {
    expect(isSlashCommand("/path/to/file")).toBe(false);
    expect(isSlashCommand("/usr/local")).toBe(false);
  });
  test("non-slash and bare slash \u21D2 false", () => {
    expect(isSlashCommand("hello")).toBe(false);
    expect(isSlashCommand("/")).toBe(false);
    expect(isSlashCommand("/1foo")).toBe(false);
  });
});
describe("runSlashCommand", () => {
  test("unknown command \u21D2 exit 1 + 'unknown'", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"));
    const code = await runSlashCommand("/nope", c.ctx);
    expect(code).toBe(1);
    expect(c.err).toContain("unknown");
  });
  test("empty line \u21D2 exit 1", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"));
    expect(await runSlashCommand("   ", c.ctx)).toBe(1);
  });
});
describe("/context", () => {
  test("exit 0 + emits placeholder", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"));
    expect(await runSlashCommand("/context", c.ctx)).toBe(0);
    expect(c.out).toContain("context:");
  });
});
describe("/usage", () => {
  test("no usage.jsonl \u21D2 exit 0 + '(no usage recorded yet)'", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"));
    expect(await runSlashCommand("/usage", c.ctx)).toBe(0);
    expect(c.out).toContain("no usage recorded");
  });
  test("seeded usage.jsonl \u21D2 correct tally", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(tmp, ".quanta"), { recursive: true });
    writeFileSync(join(tmp, ".quanta", "usage.jsonl"), [
      JSON.stringify({ input_tokens: 100, output_tokens: 20 }),
      JSON.stringify({ input_tokens: 50, output_tokens: 10 }),
      "garbage line",
      ""
    ].join(`
`));
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"));
    expect(await runSlashCommand("/usage", c.ctx)).toBe(0);
    expect(c.out).toContain("input_tokens:  150");
    expect(c.out).toContain("output_tokens: 30");
    expect(c.out).toContain("total_tokens:  180");
    expect(c.out).toContain("2 record");
  });
});
describe("/color", () => {
  test("no args + no file \u21D2 prints 'auto'", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"));
    expect(await runSlashCommand("/color", c.ctx)).toBe(0);
    expect(c.out.trim()).toBe("auto");
  });
  test("set valid theme persists to prefs file", async () => {
    const prefs = join(tmp, ".quanta", "preferences.json");
    const c = buildCtx(tmp, prefs);
    expect(await runSlashCommand("/color dark", c.ctx)).toBe(0);
    const stored = JSON.parse(readFileSync(prefs, "utf8"));
    expect(stored.theme).toBe("dark");
  });
  test("invalid theme \u21D2 exit 1 + err", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"));
    expect(await runSlashCommand("/color blue", c.ctx)).toBe(1);
    expect(c.err).toContain("invalid theme");
  });
});
describe("/navigate", () => {
  test("existing path \u21D2 persists", async () => {
    const prefs = join(tmp, ".quanta", "preferences.json");
    const c = buildCtx(tmp, prefs);
    expect(await runSlashCommand(`/navigate ${tmp}`, c.ctx)).toBe(0);
    const stored = JSON.parse(readFileSync(prefs, "utf8"));
    expect(stored.preferredCwd).toBe(tmp);
  });
  test("missing path \u21D2 exit 1", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"));
    expect(await runSlashCommand("/navigate /no/such/dir/here/maybe", c.ctx)).toBe(1);
    expect(c.err).toContain("does not exist");
  });
  test("`-` clears preferredCwd", async () => {
    const prefs = join(tmp, ".quanta", "preferences.json");
    const c1 = buildCtx(tmp, prefs);
    await runSlashCommand(`/navigate ${tmp}`, c1.ctx);
    const c2 = buildCtx(tmp, prefs);
    expect(await runSlashCommand("/navigate -", c2.ctx)).toBe(0);
    const stored = JSON.parse(readFileSync(prefs, "utf8"));
    expect(stored.preferredCwd).toBeUndefined();
  });
  test("wrong arg count \u21D2 exit 1", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"));
    expect(await runSlashCommand("/navigate", c.ctx)).toBe(1);
  });
});
describe("/wait", () => {
  test("positive seconds \u21D2 exit 0 (sleep injected)", async () => {
    let called = 0;
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"), async (ms) => {
      called = ms;
    });
    expect(await runSlashCommand("/wait 0.1", c.ctx)).toBe(0);
    expect(called).toBe(100);
  });
  test("non-numeric \u21D2 exit 1", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"));
    expect(await runSlashCommand("/wait abc", c.ctx)).toBe(1);
  });
  test("non-positive \u21D2 exit 1", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"));
    expect(await runSlashCommand("/wait -5", c.ctx)).toBe(1);
    expect(await runSlashCommand("/wait 0", c.ctx)).toBe(1);
  });
  test("above 3600 cap \u21D2 exit 1", async () => {
    const c = buildCtx(tmp, join(tmp, ".quanta", "preferences.json"));
    expect(await runSlashCommand("/wait 4000", c.ctx)).toBe(1);
  });
});
test("prefs writes mkdir -p the .quanta dir", async () => {
  const prefs = join(tmp, "nested", "deep", "preferences.json");
  const c = buildCtx(tmp, prefs);
  await runSlashCommand("/color dark", c.ctx);
  expect(existsSync(prefs)).toBe(true);
});
