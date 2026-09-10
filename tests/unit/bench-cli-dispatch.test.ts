/**
 * Hellgate: quanta-bench CLI arg routing (ADR-0536). Guards the flag-value-skip
 * bug (a `--preset x` value leaking into positional report paths) + backend-spec
 * parsing. The substantive logic lives in remote/ + analyze/ (separately tested);
 * this pins the thin dispatch glue.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { buildBackend } from "../../src/apps/bench/commands/grade"
import {
  argValue,
  modelNameFromPredictions,
  positionals,
} from "../../src/apps/bench/commands/shared"
import { otelUiPort, traceViewerUrl as traceUrl } from "../../src/apps/bench/otel"

let savedArgv: string[]
beforeEach(() => {
  savedArgv = process.argv
})
afterEach(() => {
  process.argv = savedArgv
})
const setArgv = (...rest: string[]): void => {
  process.argv = ["bun", "cli.ts", ...rest]
}

const CLI_SOURCE = readFileSync(new URL("../../src/apps/bench/cli.ts", import.meta.url), "utf8")

describe("bench CLI dispatch", () => {
  test("direct CLI startup lazy-loads command handlers", () => {
    const dynamicHandlerLoads = [
      ...CLI_SOURCE.matchAll(/await import\("\.\/commands\/[a-z-]+"\)/gu),
    ]
    expect(dynamicHandlerLoads.length).toBeGreaterThanOrEqual(16)
    expect(CLI_SOURCE.match(/^import .* from "\.\/commands\/[a-z-]+"$/gmu) ?? []).toEqual([])
    expect(CLI_SOURCE.match(/^export .* from "\.\/commands\/[a-z-]+"$/gmu) ?? []).toEqual([])
  })

  test("positionals skips flags AND their value tokens", () => {
    // `leaderboard a.json b.json --preset agentless-v1 --title T`
    setArgv("leaderboard", "a.json", "b.json", "--preset", "agentless-v1", "--title", "T")
    expect(positionals()).toEqual(["a.json", "b.json"]) // NOT agentless-v1 / T
  })

  test("positionals: boolean flag (--keep) consumes no value", () => {
    setArgv("grade", "r.json", "--keep", "--backend", "ec2")
    expect(positionals()).toEqual(["r.json"]) // ec2 is --backend's value, skipped
  })

  test("positionals: --run takes a value (trace <run-id> deep-link)", () => {
    // `trace box-3 --run other --port 4319` — both --run and --port are value
    // flags, so only the bare run-id positional survives.
    setArgv("trace", "box-3", "--run", "other", "--port", "4319")
    expect(positionals()).toEqual(["box-3"])
  })

  test("traceUrl: deep-links to one run and URL-encodes the run id", () => {
    // no run id ⇒ bare UI url (launch-fresh path)
    expect(traceUrl(4318)).toBe("http://127.0.0.1:4318/")
    // run id ⇒ ?run= filter; the port is honored
    expect(traceUrl(4319, "ab-A2")).toBe("http://127.0.0.1:4319/?run=ab-A2")
    // a run id with shell/url-unsafe chars is encoded, not injected raw
    expect(traceUrl(4318, "wave3 s0/A&B")).toBe("http://127.0.0.1:4318/?run=wave3%20s0%2FA%26B")
  })

  test("otelUiPort: parses the endpoint's port so the printed link matches the sink", () => {
    // the boot-wire link must point at the SAME port the sink listens on
    expect(otelUiPort({ QUANTA_OTEL_ENDPOINT: "http://127.0.0.1:4319" })).toBe(4319)
    // unset / unparseable / portless ⇒ OTLP/HTTP default 4318
    expect(otelUiPort({})).toBe(4318)
    expect(otelUiPort({ QUANTA_OTEL_ENDPOINT: "not a url" })).toBe(4318)
    expect(otelUiPort({ QUANTA_OTEL_ENDPOINT: "http://example.com" })).toBe(4318)
  })

  test("positionals: empty when only flags", () => {
    setArgv("diff", "--dataset", "x")
    expect(positionals()).toEqual([])
  })

  test("positionals: --model value does NOT leak as a positional report path", () => {
    // BUG: --model was missing from VALUE_FLAGS, so `gpt-5.4` was treated as a
    // second report file ⇒ leaderboard crashed with ENOENT on "gpt-5.4".
    setArgv("leaderboard", "report.json", "--model", "gpt-5.4")
    expect(positionals()).toEqual(["report.json"])
  })

  test("argValue reads both `--flag value` AND `--flag=value` forms", () => {
    setArgv("grade", "--preset", "agentless-v1", "--region=ap-northeast-2")
    expect(argValue("--preset")).toBe("agentless-v1") // space form (back-compat)
    // BUG: indexOf(flag) never matched the `=`-form ⇒ silently undefined.
    expect(argValue("--region")).toBe("ap-northeast-2")
    expect(argValue("--missing")).toBeUndefined()
  })

  test("buildBackend ssh:host → ssh backend", () => {
    setArgv("grade")
    expect(buildBackend("ssh:ubuntu@1.2.3.4", undefined).name).toContain("ssh")
  })

  test("buildBackend ec2 → ec2 backend", () => {
    setArgv("grade")
    expect(buildBackend("ec2", "gpt-5.4").name).toBe("ec2")
  })

  test("buildBackend rejects unknown spec", () => {
    setArgv("grade")
    expect(() => buildBackend("nope", undefined)).toThrow(/unknown --backend/)
  })

  test("modelNameFromPredictions reads model_name_or_path from first row", () => {
    const p = `/tmp/cli-test-preds-${process.pid}.jsonl`
    writeFileSync(
      p,
      `${JSON.stringify({ instance_id: "x", model_name_or_path: "gpt-5.4", model_patch: "d" })}\n`,
    )
    expect(modelNameFromPredictions(p)).toBe("gpt-5.4")
  })

  test("modelNameFromPredictions returns undefined on missing/garbage", () => {
    expect(modelNameFromPredictions("/tmp/does-not-exist-xyz.jsonl")).toBeUndefined()
  })
})
