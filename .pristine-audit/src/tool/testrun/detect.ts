/**
 * Epic-2 — toolchain detector. Maps a project's marker files to {language,
 * test command, parser}. Pure: takes an injected existence probe (no real IO),
 * so it is trivially testable and slice-clean.
 *
 * Precedence is ordered (first match wins): a compiled-language marker
 * (Cargo.toml / go.mod) outranks package.json, since a Rust/Go project often
 * carries a JS sidecar but is tested via cargo/go.
 */
import type { Toolchain } from "./types"

export interface ExistsPort {
  /** True iff `name` exists directly under the project root. */
  fileExists(name: string): Promise<boolean>
  /** OPTIONAL probe: is a command runnable (exit 0)? Used to prefer pytest over
   *  unittest when it is installed. When ABSENT, detection uses conservative
   *  defaults (unittest), so the pure detector stays deterministic in tests. */
  canRun?(command: readonly string[]): Promise<boolean>
}

interface Marker {
  readonly file: string
  readonly toolchain: Toolchain
}

// `cargo test` default capture replays a failed test's panic into the
// `---- NAME stdout ----` block, where parseCargo reads file:line.
const RUST: Toolchain = { kind: "rust", command: ["cargo", "test"], parser: "cargo" }
// -json gives a structured event stream; ./... runs the whole module tree.
const GO: Toolchain = { kind: "go", command: ["go", "test", "-json", "./..."], parser: "go" }
// `npm test` output is parsed by the JS/TS runner parser (bun/jest/vitest/
// node:test/mocha all emit V8 stack frames it localizes from), so a JS failure
// gets a file+line → the typescript-language-server static enrichment kicks in.
const NODE: Toolchain = { kind: "node", command: ["npm", "test", "--silent"], parser: "node" }

// Python is detected by ANY of these markers, then the COMMAND is chosen by a
// pytest probe (below). These markers are unittest-CAPABLE (a unittest fallback
// is always valid), so preferring pytest when installed is strictly more capable
// — pytest also runs unittest.TestCase tests. NB: pytest-ONLY markers
// (conftest.py / pytest.ini) are deliberately NOT here: detecting them when
// pytest is absent would fall back to unittest and falsely "pass" a 0-tests run.
const PYTHON_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg"] as const
const UNITTEST: Toolchain = {
  kind: "python",
  command: ["python3", "-m", "unittest", "discover", "-v"],
  parser: "python-unittest",
}
const PYTEST: Toolchain = { kind: "python", command: ["python3", "-m", "pytest"], parser: "pytest" }

// Compiled-language markers outrank python/node (a Rust/Go repo often carries a
// JS sidecar or a pyproject for tooling but is tested via cargo/go).
// C++ (CMake): ctest runs the test executables; `--output-on-failure` surfaces
// the framework's failure (gtest `file:line: Failure`, or libc assert) which
// parseCtest localizes. Ranked above python/node like the other compiled langs.
const CPP: Toolchain = {
  kind: "cpp",
  command: ["ctest", "--output-on-failure", "--test-dir", "build"],
  parser: "ctest",
}

const MARKERS: readonly Marker[] = [
  { file: "Cargo.toml", toolchain: RUST },
  { file: "go.mod", toolchain: GO },
  { file: "CMakeLists.txt", toolchain: CPP },
]

/** Detect the project's toolchain, or `null` if no marker is present. Python
 *  prefers pytest when `fs.canRun` reports it installed (pytest supersedes
 *  unittest); without the probe it falls back to unittest. */
export const detectToolchain = async (_cwd: string, fs: ExistsPort): Promise<Toolchain | null> => {
  for (const m of MARKERS) {
    if (await fs.fileExists(m.file)) return m.toolchain
  }
  // Python: any marker ⇒ python, command chosen by the pytest probe.
  for (const f of PYTHON_MARKERS) {
    if (await fs.fileExists(f)) {
      const hasPytest = fs.canRun
        ? await fs.canRun(["python3", "-m", "pytest", "--version"]).catch(() => false)
        : false
      return hasPytest ? PYTEST : UNITTEST
    }
  }
  if (await fs.fileExists("package.json")) return NODE
  return null
}
