/**
 * ★ CONTRACT — strip env-applied dependency-pin contamination from captured patch.
 *
 * jun-28 root: the env setup (box bootstrap / swebench install) pins a repo's
 * manifest (`setup.py` `install_requires`: `'docutils>=0.12'` → `'docutils>=0.12,<0.18'`,
 * `'Jinja2>=2.3'` → `'Jinja2>=2.3,<3.1'` …) so the old version installs under a
 * modern resolver. That mutation lands in the agent's working tree, so the
 * `git diff --cached` candidate capture sweeps it into the model_patch. At grade
 * time the base image ALREADY has these pins → `patch` sees them as
 * already-applied/reversed → "Patch Apply Failed" → a false ERROR that masked
 * REAL solves (sphinx-8721, -9711 flipped resolved once stripped).
 *
 * `stripEnvManifestPins` drops a manifest file-section IFF every changed line is a
 * dependency-requirement string AND it's a pure constraint-rewording of the SAME
 * packages (env signature) — never a code change, an added/removed package, or a
 * non-manifest file. Verified safe: NONE of the 5 affected instances' gold
 * patches touch a manifest, so a constraint-only manifest section is never the fix.
 */

import { describe, expect, test } from "bun:test"
import { stripEnvManifestPins } from "../../src/runner/batch/eval/strip-env-manifest-pins"

const SETUP_PIN_SECTION = `diff --git a/setup.py b/setup.py
index a404f1fa5..ac65afcaa 100644
--- a/setup.py
+++ b/setup.py
@@ -15,10 +15,10 @@ if sys.version_info < (3, 5):
 install_requires = [
-    'sphinxcontrib-applehelp',
+    'sphinxcontrib-applehelp<1.0.8',
     'sphinxcontrib-jsmath',
-    'Jinja2>=2.3',
+    'Jinja2>=2.3,<3.1',
-    'docutils>=0.12',
+    'docutils>=0.12,<0.18',
 ]
`

const REAL_FIX_SECTION = `diff --git a/sphinx/ext/viewcode.py b/sphinx/ext/viewcode.py
index 111..222 100644
--- a/sphinx/ext/viewcode.py
+++ b/sphinx/ext/viewcode.py
@@ -10,7 +10,7 @@ def foo():
-    return None
+    return result
`

describe("stripEnvManifestPins", () => {
  test("drops a setup.py section that is PURE constraint-tightening of the same packages", () => {
    const out = stripEnvManifestPins(SETUP_PIN_SECTION + REAL_FIX_SECTION)
    expect(out).not.toContain("setup.py")
    expect(out).not.toContain("sphinxcontrib-applehelp")
    // the real fix survives untouched
    expect(out).toContain("sphinx/ext/viewcode.py")
    expect(out).toContain("+    return result")
  })

  test("a manifest-only contaminated patch becomes EMPTY (the real fix was elsewhere / none)", () => {
    expect(stripEnvManifestPins(SETUP_PIN_SECTION).trim()).toBe("")
  })

  test("PRESERVES a manifest section that changes code, not just deps", () => {
    const codeInSetup = `diff --git a/setup.py b/setup.py
index 1..2 100644
--- a/setup.py
+++ b/setup.py
@@ -1,4 +1,4 @@
-version = "1.0"
+version = "1.1"
 install_requires = ['x']
`
    expect(stripEnvManifestPins(codeInSetup)).toContain("setup.py")
    expect(stripEnvManifestPins(codeInSetup)).toContain('+version = "1.1"')
  })

  test("PRESERVES a manifest section that ADDS a new package (could be the real fix)", () => {
    const addsDep = `diff --git a/setup.py b/setup.py
index 1..2 100644
--- a/setup.py
+++ b/setup.py
@@ -1,3 +1,4 @@
 install_requires = [
+    'newdep>=1.0',
     'existing',
 ]
`
    // removed set {} != added set {newdep} ⇒ not a pure rewording ⇒ keep
    expect(stripEnvManifestPins(addsDep)).toContain("setup.py")
    expect(stripEnvManifestPins(addsDep)).toContain("newdep")
  })

  test("PRESERVES a manifest section that REMOVES a package", () => {
    const removesDep = `diff --git a/setup.py b/setup.py
index 1..2 100644
--- a/setup.py
+++ b/setup.py
@@ -1,4 +1,3 @@
 install_requires = [
-    'gone>=1.0',
     'existing',
 ]
`
    expect(stripEnvManifestPins(removesDep)).toContain("gone")
  })

  test("NEVER touches a non-manifest file even if it looks dep-ish", () => {
    const code = `diff --git a/requirements_helper.py b/requirements_helper.py
index 1..2 100644
--- a/requirements_helper.py
+++ b/requirements_helper.py
@@ -1,2 +1,2 @@
-    'docutils>=0.12',
+    'docutils>=0.12,<0.18',
`
    // .py source file (not a manifest) — must be preserved verbatim
    expect(stripEnvManifestPins(code)).toContain("requirements_helper.py")
    expect(stripEnvManifestPins(code)).toContain("docutils")
  })

  test("no manifest section ⇒ returns the patch byte-identical", () => {
    expect(stripEnvManifestPins(REAL_FIX_SECTION)).toBe(REAL_FIX_SECTION)
  })

  test("empty / whitespace input ⇒ no throw, returns as-is", () => {
    expect(stripEnvManifestPins("")).toBe("")
    expect(stripEnvManifestPins("   \n")).toBe("   \n")
  })

  // ── audit hardening: false-strip guards (Cat 1/2/3) ──────────────────────

  test("Cat-1: a TEST-FIXTURE setup.py (non-root path) is PRESERVED", () => {
    const fixture = `diff --git a/tests/roots/test-ext/setup.py b/tests/roots/test-ext/setup.py
index 1..2 100644
--- a/tests/roots/test-ext/setup.py
+++ b/tests/roots/test-ext/setup.py
@@ -1,2 +1,2 @@
-    'docutils>=0.12',
+    'docutils>=0.12,<0.18',
`
    // only the REPO-ROOT manifest is env-pinned; a fixture's dep edit can be the fix
    expect(stripEnvManifestPins(fixture)).toContain("tests/roots/test-ext/setup.py")
    expect(stripEnvManifestPins(fixture)).toContain("docutils")
  })

  test("Cat-3: a same-package constraint change with NO upper bound is PRESERVED (real fix)", () => {
    const tighten = `diff --git a/setup.py b/setup.py
index 1..2 100644
--- a/setup.py
+++ b/setup.py
@@ -1,2 +1,2 @@
-    'requests>=2.0',
+    'requests>=2.20',
`
    // tightening a lower bound (no `<`) is NOT the env signature → keep
    expect(stripEnvManifestPins(tighten)).toContain("requests")
  })

  test("Cat-3: LOOSENING a bound (dropping the upper cap) is PRESERVED", () => {
    const loosen = `diff --git a/setup.py b/setup.py
index 1..2 100644
--- a/setup.py
+++ b/setup.py
@@ -1,2 +1,2 @@
-    'docutils>=0.12,<0.18',
+    'docutils>=0.14',
`
    expect(stripEnvManifestPins(loosen)).toContain("docutils")
  })

  test("Cat-2: a packages/data-files bare-string list reorder is PRESERVED", () => {
    const reorder = `diff --git a/setup.py b/setup.py
index 1..2 100644
--- a/setup.py
+++ b/setup.py
@@ -1,4 +1,4 @@
 packages = [
-    'alpha',
+    'beta',
-    'beta',
+    'alpha',
 ]
`
    // bare strings, no added upper bound ⇒ not env-pin ⇒ keep
    expect(stripEnvManifestPins(reorder)).toContain("setup.py")
  })

  test("Cat-1: a NESTED pyproject.toml (non-root) is PRESERVED", () => {
    const nested = `diff --git a/sub/pkg/pyproject.toml b/sub/pkg/pyproject.toml
index 1..2 100644
--- a/sub/pkg/pyproject.toml
+++ b/sub/pkg/pyproject.toml
@@ -1,2 +1,2 @@
-    "numpy>=1.0",
+    "numpy>=1.0,<2.0",
`
    expect(stripEnvManifestPins(nested)).toContain("sub/pkg/pyproject.toml")
  })

  test("multi-hunk root setup.py that is all env-pins ⇒ fully stripped", () => {
    const multi = `diff --git a/setup.py b/setup.py
index 1..2 100644
--- a/setup.py
+++ b/setup.py
@@ -10,2 +10,2 @@
-    'docutils>=0.12',
+    'docutils>=0.12,<0.18',
@@ -40,2 +40,2 @@
-    'Jinja2>=2.3',
+    'Jinja2>=2.3,<3.1',
`
    expect(stripEnvManifestPins(multi).trim()).toBe("")
  })

  test("preamble before the first diff --git is preserved", () => {
    const withPreamble = `From abc123 Mon Sep 17\nSubject: x\n---\n${REAL_FIX_SECTION}`
    expect(stripEnvManifestPins(withPreamble)).toContain("From abc123")
    expect(stripEnvManifestPins(withPreamble)).toContain("sphinx/ext/viewcode.py")
  })

  test("handles pyproject.toml + setup.cfg manifests too", () => {
    const pyproj = `diff --git a/pyproject.toml b/pyproject.toml
index 1..2 100644
--- a/pyproject.toml
+++ b/pyproject.toml
@@ -1,3 +1,3 @@
 dependencies = [
-    "numpy>=1.0",
+    "numpy>=1.0,<2.0",
 ]
`
    expect(stripEnvManifestPins(pyproj).trim()).toBe("")
  })
})
