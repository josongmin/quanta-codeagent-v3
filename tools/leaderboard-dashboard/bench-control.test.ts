import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ActionError } from "./bench-actions"
import { BenchControl, type SpawnFn } from "./bench-control"

const PRESETS = new Set(["agentless-v1", "baseline"])

/** Minimal fake ChildProcess: records the spawn call + lets the test push stdout/close. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4242
  unref() {}
}
const makeControl = (onSpawn?: (cmd: string, argv: string[], opts: unknown) => FakeChild) => {
  const calls: { cmd: string; argv: string[]; opts: unknown }[] = []
  const children: FakeChild[] = []
  const spawn: SpawnFn = (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts })
    const c = onSpawn ? onSpawn(cmd, argv, opts) : new FakeChild()
    children.push(c)
    return c as unknown as ReturnType<SpawnFn>
  }
  const runDir = mkdtempSync(join(tmpdir(), "bench-control-"))
  let t = 1000
  const ctrl = new BenchControl({
    repoDir: "/repo",
    runDir,
    spawn,
    now: () => ++t,
    validPresets: () => PRESETS,
  })
  return { ctrl, calls, children }
}

describe("BenchControl.launch — validate-then-spawn", () => {
  test("valid spec ⇒ spawns bun grade with family env + cwd=repo, registers running", () => {
    const { ctrl, calls } = makeControl()
    const info = ctrl.launch({
      family: "pro",
      dataset: "/d/pro-5.jsonl",
      preset: "agentless-v1",
      model: "gpt-5.5",
      onDemand: true,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.cmd).toBe("bun")
    expect(calls[0]!.argv).toContain("--dataset-family")
    expect(calls[0]!.argv).toContain("pro")
    const opts = calls[0]!.opts as { cwd: string; env: Record<string, string>; detached?: boolean }
    expect(opts.cwd).toBe("/repo")
    expect(opts.env.QUANTA_SWEBENCH_DATASET_FAMILY).toBe("pro")
    expect(opts.env.QUANTA_FULL_REMOTE_ONDEMAND).toBe("1")
    expect(opts.detached).toBe(true)
    expect(info.status).toBe("running")
    expect(info.family).toBe("pro")
    expect(ctrl.listLaunches()).toHaveLength(1)
  })

  test("bad preset ⇒ ActionError, NO spawn (validate before spawn)", () => {
    const { ctrl, calls } = makeControl()
    expect(() =>
      ctrl.launch({ family: "pro", dataset: "/d/x.jsonl", preset: "evil-v9", model: "gpt-5.5" }),
    ).toThrow(ActionError)
    expect(calls).toHaveLength(0) // never spawned
  })

  test("injection dataset ⇒ ActionError, NO spawn", () => {
    const { ctrl, calls } = makeControl()
    expect(() =>
      ctrl.launch({
        family: "pro",
        dataset: "x.jsonl; rm -rf ~",
        preset: "agentless-v1",
        model: "gpt-5.5",
      }),
    ).toThrow(ActionError)
    expect(calls).toHaveLength(0)
  })

  test("registry reflects child exit", () => {
    const { ctrl, children } = makeControl()
    ctrl.launch({
      family: "live",
      dataset: "/d/live-5.jsonl",
      preset: "baseline",
      model: "gpt-5.5",
    })
    children[0]!.emit("close", 0)
    expect(ctrl.listLaunches()[0]!.status).toBe("exited")
    expect(ctrl.listLaunches()[0]!.exitCode).toBe(0)
  })

  test("the launched child's stdout is appended to the launch log (tailable)", () => {
    const { ctrl, children } = makeControl()
    const info = ctrl.launch({
      family: "pro",
      dataset: "/d/p.jsonl",
      preset: "agentless-v1",
      model: "gpt-5.5",
    })
    children[0]!.stdout.emit("data", "hello-from-grade\n")
    expect(ctrl.readLaunchLog(info.launchId)).toContain("hello-from-grade")
  })
})

describe("BenchControl cost/disk guards (audit C2/H2)", () => {
  // Fake children use a LIVE pid (the test's own) so isAlive()==true ⇒ they count as running.
  const aliveChild = () => {
    const c = new FakeChild()
    c.pid = process.pid
    return c
  }
  const spec = (family: "pro" | "live" = "pro") => ({
    family,
    dataset: "/d/x.jsonl",
    preset: "agentless-v1",
    model: "gpt-5.5",
  })

  test("C2: concurrent-launch cap (default 2) ⇒ 3rd launch throws ActionError, no 3rd spawn", () => {
    const { ctrl, calls } = makeControl(() => aliveChild())
    ctrl.launch(spec())
    ctrl.launch(spec())
    expect(() => ctrl.launch(spec())).toThrow(/too many concurrent/)
    expect(calls).toHaveLength(2) // 3rd never spawned
  })

  test("C2: an EXITED launch frees a slot", () => {
    const { ctrl, children, calls } = makeControl(() => aliveChild())
    ctrl.launch(spec())
    ctrl.launch(spec())
    children[0]!.emit("close", 0) // first exits ⇒ slot frees
    expect(() => ctrl.launch(spec())).not.toThrow()
    expect(calls).toHaveLength(3)
  })

  test("H2: per-launch log is byte-capped (no disk exhaustion)", () => {
    const calls: unknown[] = []
    const children: FakeChild[] = []
    const spawn: SpawnFn = (cmd, argv, opts) => {
      calls.push({ cmd, argv, opts })
      const c = new FakeChild()
      c.pid = process.pid
      children.push(c)
      return c as unknown as ReturnType<SpawnFn>
    }
    const runDir = mkdtempSync(join(tmpdir(), "bench-control-cap-"))
    let t = 0
    const ctrl = new BenchControl({
      repoDir: "/repo",
      runDir,
      spawn,
      now: () => ++t,
      validPresets: () => PRESETS,
      maxLogBytes: 20, // tiny cap
    })
    const info = ctrl.launch(spec())
    children[0]!.stdout.emit("data", "x".repeat(100)) // far exceeds cap
    children[0]!.stdout.emit("data", "more")
    const log = ctrl.readLaunchLog(info.launchId)
    expect(log.length).toBeLessThan(60) // capped (~20 + the "capped" notice), not 104
    expect(log).toContain("log capped")
  })
})

describe("BenchControl round-3 hardening (audit #2/#3)", () => {
  const aliveChild = () => {
    const c = new FakeChild()
    c.pid = process.pid
    return c
  }
  const spec = () => ({
    family: "pro" as const,
    dataset: "/d/x.jsonl",
    preset: "agentless-v1",
    model: "gpt-5.5",
  })

  test("#2 readLaunchLog returns only the TAIL window, not the whole file", () => {
    const { ctrl, children } = makeControl(() => aliveChild())
    const info = ctrl.launch(spec())
    // write 5000 bytes; ask for a 100-byte tail
    children[0]!.stdout.emit("data", `${"A".repeat(2500)}${"B".repeat(2500)}`)
    const tail = ctrl.readLaunchLog(info.launchId, 100)
    expect(tail.length).toBe(100)
    expect(tail).toBe("B".repeat(100)) // last 100 bytes, all B
    expect(tail).not.toContain("A")
  })

  test("#3 registry evicts oldest EXITED launches past the cap (no unbounded growth)", () => {
    const { ctrl, children } = makeControl(() => aliveChild())
    // 55 launches all exited ⇒ capped to 50 (MAX). maxConcurrent default 2 counts only RUNNING,
    // and these exit immediately, so the cap check passes each time.
    for (let i = 0; i < 55; i++) {
      const info = ctrl.launch(spec())
      // exit it right away so the next launch isn't blocked by maxConcurrent + it's evictable
      const child = children[children.length - 1]!
      child.emit("close", 0)
      void info
    }
    expect(ctrl.listLaunches().length).toBeLessThanOrEqual(50)
  })
})

describe("BenchControl box ops", () => {
  test("listBoxes parses JSON stdout from box ls --json", async () => {
    const { ctrl, children } = makeControl()
    const p = ctrl.listBoxes()
    // emit the JSON then close
    queueMicrotask(() => {
      children[0]!.stdout.emit("data", JSON.stringify([{ iid: "i-0abc", state: "running" }]))
      children[0]!.emit("close", 0)
    })
    expect(await p).toEqual([{ iid: "i-0abc", state: "running" }])
  })

  test("stopBox rejects non-iid BEFORE spawn (no fleet wipe)", async () => {
    const { ctrl, calls } = makeControl()
    await expect(ctrl.stopBox("all")).rejects.toThrow(ActionError)
    expect(calls).toHaveLength(0)
  })

  test("stopBox valid iid ⇒ spawns box rm <iid>", async () => {
    const { ctrl, calls, children } = makeControl()
    const p = ctrl.stopBox("i-0abc1234def")
    queueMicrotask(() => children[0]!.emit("close", 0))
    const r = await p
    expect(r.ok).toBe(true)
    expect(calls[0]!.argv).toEqual(["run", "src/apps/bench/cli.ts", "box", "rm", "i-0abc1234def"])
  })
})
