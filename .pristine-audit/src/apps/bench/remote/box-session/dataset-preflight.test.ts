import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertDatasetGradeableForFamily, RemoteDatasetPreflightError } from "./dataset-preflight"

const writeJsonl = (rows: Record<string, unknown>[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "pro-pf-"))
  const path = join(dir, "instances.jsonl")
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n"))
  return path
}

const validProRow = (id = "scale__demo-1") => ({
  instance_id: id,
  before_repo_set_cmd: "pip install -e .",
  selected_test_files_to_run: "['tests/test_x.py']",
  fail_to_pass: "['tests/test_x.py::test_y']",
})

describe("assertDatasetGradeableForFamily — Scale-harness column preflight (fail-closed)", () => {
  test("non-pro family ⇒ no-op (Verified/Live byte-identical, even on a Pro-shaped file)", () => {
    const path = writeJsonl([{ instance_id: "x" }]) // missing every Pro column
    expect(() =>
      assertDatasetGradeableForFamily({ datasetPath: path, surface: "t", family: "verified" }),
    ).not.toThrow()
    expect(() =>
      assertDatasetGradeableForFamily({ datasetPath: path, surface: "t", family: "live" }),
    ).not.toThrow()
  })

  test("pro + all required columns present ⇒ ok", () => {
    const path = writeJsonl([validProRow(), validProRow("scale__demo-2")])
    expect(() =>
      assertDatasetGradeableForFamily({ datasetPath: path, surface: "t", family: "pro" }),
    ).not.toThrow()
  })

  test("pro + a row missing before_repo_set_cmd ⇒ throws (would KeyError → all-infra)", () => {
    const bad = validProRow()
    delete (bad as Record<string, unknown>).before_repo_set_cmd
    const path = writeJsonl([validProRow("ok-1"), bad])
    expect(() =>
      assertDatasetGradeableForFamily({ datasetPath: path, surface: "full-remote", family: "pro" }),
    ).toThrow(RemoteDatasetPreflightError)
  })

  test("pro + a row missing selected_test_files_to_run ⇒ throws", () => {
    const bad = validProRow()
    delete (bad as Record<string, unknown>).selected_test_files_to_run
    const path = writeJsonl([bad])
    expect(() =>
      assertDatasetGradeableForFamily({ datasetPath: path, surface: "t", family: "pro" }),
    ).toThrow(/selected_test_files_to_run/)
  })

  test("pro + null fail_to_pass ⇒ throws (null decodes to the no-op grade selection)", () => {
    const bad = { ...validProRow(), fail_to_pass: null }
    const path = writeJsonl([bad])
    expect(() =>
      assertDatasetGradeableForFamily({ datasetPath: path, surface: "t", family: "pro" }),
    ).toThrow(/fail_to_pass/)
  })

  test("pro + malformed UNSELECTED row + valid SELECTED instance ⇒ passes (validate only selection)", () => {
    const bad = validProRow("scale__bad")
    delete (bad as Record<string, unknown>).before_repo_set_cmd
    const path = writeJsonl([validProRow("scale__good"), bad])
    expect(() =>
      assertDatasetGradeableForFamily({
        datasetPath: path,
        instanceIds: ["scale__good"],
        surface: "full-remote",
        family: "pro",
      }),
    ).not.toThrow()
  })

  test("pro + malformed SELECTED row ⇒ still throws (fail-closed on genuine selection)", () => {
    const bad = validProRow("scale__bad")
    delete (bad as Record<string, unknown>).before_repo_set_cmd
    const path = writeJsonl([validProRow("scale__good"), bad])
    expect(() =>
      assertDatasetGradeableForFamily({
        datasetPath: path,
        instanceIds: ["scale__bad"],
        surface: "full-remote",
        family: "pro",
      }),
    ).toThrow(RemoteDatasetPreflightError)
  })

  test("pro + uppercase-ONLY FAIL_TO_PASS ⇒ throws (Scale reads lowercase fail_to_pass only)", () => {
    // Scale's create_entryscript does `eval(raw_sample["fail_to_pass"])` (lowercase) — an
    // uppercase-only row would KeyError there → all-infra. The preflight must catch it.
    const row = {
      instance_id: "scale__u",
      before_repo_set_cmd: "x",
      selected_test_files_to_run: "['a']",
      FAIL_TO_PASS: "['a::b']", // uppercase only — Scale cannot read this
    }
    const path = writeJsonl([row])
    expect(() =>
      assertDatasetGradeableForFamily({ datasetPath: path, surface: "t", family: "pro" }),
    ).toThrow(/fail_to_pass/)
  })
})
