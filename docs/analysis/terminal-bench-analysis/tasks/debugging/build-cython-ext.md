---
task: build-cython-ext
category: debugging
difficulty: medium
tags: [coding, dependency, compilation]
expert_min: 60
junior_min: 180
skill_class: DEBUG-FIX
terminal_native: high
docker_image: alexgshaw/build-cython-ext:20251031
---

# build-cython-ext

**Goal** — Clone `pyknotid` 0.5.3, fix its NumPy-2.0 incompatibilities, compile its Cython extensions (chelpers, ccomplexity, cinvariants), and install it into the global Python env so it works with the existing NumPy 2.3.0 — without downgrading NumPy.

**Solution shape** — ~20-line bash. `git clone --depth 1 --branch 0.5.3` into `/app/pyknotid`, then a series of targeted `sed` edits fixing removed NumPy 2 aliases (`n.float`→`n.float64`, `n.complex`→`n.complex128`, `n.int(`→`int(`, `np.int`→`np.int64`) across several `.py` and a `.pyx` file, plus `from fractions import gcd`→`from math import gcd`. Then `pip install setuptools cython` (pinned), `python setup.py build_ext --inplace`, and `pip install -e .`. Pure diagnose-and-patch of deprecated APIs guided by build/import errors.

**Verifier** — pytest: NumPy stays exactly 2.3.0; repo cloned with `.git`; pyknotid importable as a source module; each of chelpers/ccomplexity/cinvariants importable specifically as compiled `ExtensionFileLoader` modules (not Python fallbacks); numeric behavior checks (cross_product, writhe, vassiliev cython==python, alexander_polynomial==7, determinant==5); and the upstream repo test suite (minus two excluded files) must pass. reward binary 0/1.

**Difficulty drivers** — Requires reading compiler/import tracebacks and mapping them to NumPy-2 API removals across multiple files including a `.pyx`; the extensions must load as real compiled modules (a Python-only monkeypatch fails the ExtensionFileLoader assertions); build toolchain (setuptools/cython pins) matters; must NOT clobber NumPy.

**quanta attack points** — `container_exec` for clone, sed/edits, build, pip, and running pytest; no interactivity. Main failure risk: an incomplete sed sweep leaves one deprecated alias, or the extension silently falls back to Python (passing imports but failing the ExtensionFileLoader check). The exit-code "iterate until tests pass" loop is a strong fit here — this is fundamentally error-driven debugging where each build/import error points at the next fix.
