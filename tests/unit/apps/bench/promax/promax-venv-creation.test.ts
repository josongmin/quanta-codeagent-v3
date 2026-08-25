/**
 * PMX-04 — THE DEDICATED INTERPRETER MUST ACTUALLY BE CREATABLE ON THE BOX.
 *
 * MEASURED on a real box, at the first grader phase that ever opened:
 *
 *   promax bootstrap step "python-env" FAILED (exit 1):
 *     'python3' '-m' 'venv' '/opt/quanta/promax/venv'
 *     The virtual environment was not created successfully because ensurepip is
 *     not available. On Debian/Ubuntu systems, you need to install the
 *     python3-venv package…
 *
 * Ubuntu ships `python3` without `ensurepip`, so `python3 -m venv` cannot work
 * there — on any box, every time.
 *
 * `uv` is the answer, and it is already on the box: cloud-init installs bun+uv,
 * so this adds no provisioning. `uv venv` builds the environment without
 * ensurepip, and `--python 3.11` PINS an interpreter above the evaluator's PEP
 * 604 floor rather than inheriting whatever `python3` happens to be — which is
 * the remedy the floor's own refusal message already recommends.
 *
 * The venv needs no packages: the pinned evaluator imports only stdlib
 * (os, json, uuid, tempfile, subprocess, re, argparse, shlex, concurrent.futures).
 * So a bare interpreter is the whole requirement, and nothing here installs.
 */
import { describe, expect, test } from "bun:test"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"

const commands = () => {
  const b = familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))
  return b?.commands ?? []
}
const venvStep = () => commands().find((c) => c.step === "python-env")

describe("the evaluator's venv is created by something that works on the box", () => {
  test("🔴 it does NOT use `python3 -m venv`, which needs ensurepip", () => {
    const argv = venvStep()?.argv.join(" ") ?? ""
    expect(argv).not.toMatch(/python3?\s+-m\s+venv/)
  })

  test("🔴 it uses `uv venv`, which cloud-init already provisions", () => {
    expect(venvStep()?.argv.join(" ") ?? "").toMatch(/uv venv/)
  })

  test("🔴 the interpreter is PINNED above the PEP 604 floor, not inherited", () => {
    const argv = venvStep()?.argv.join(" ") ?? ""
    expect(argv).toMatch(/--python\s+3\.(1[1-9]|[2-9]\d)/)
  })

  test("it still targets the declared venv root", () => {
    expect(venvStep()?.argv.join(" ") ?? "").toContain("/opt/quanta/promax/venv")
  })

  test("PAIRED CONTROL: it installs NOTHING — the evaluator is stdlib-only", () => {
    const argv = venvStep()?.argv.join(" ") ?? ""
    expect(argv).not.toMatch(/pip install|uv pip|uv add/)
  })

  test("PAIRED CONTROL: still a grader-phase step, and not gold-bearing", () => {
    expect(venvStep()?.phase).toBe("grader")
    expect(venvStep()?.goldBearing).toBe(false)
  })
})
