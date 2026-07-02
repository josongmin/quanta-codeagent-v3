---
task: portfolio-optimization
category: optimization
difficulty: medium
tags: [c-programming, python-extension, optimization]
expert_min: 120
junior_min: 480
skill_class: NUMERIC-SCI
terminal_native: med
docker_image: alexgshaw/portfolio-optimization:20251031
---

# portfolio-optimization

**Goal** — Complete skeleton files `portfolio_optimized.c` and `portfolio_optimized.py` to build a CPython C extension computing portfolio risk `sqrt(xᵀSx)` and return `xᵀr`, matching the Python baseline within 1e-10 and ≥1.2× faster on portfolios of 5000–8000 assets.

**Solution shape** — Bash writes both files then `python3 setup.py build_ext --inplace` + `python3 benchmark.py`. The C file (~90 lines) is a standard NumPy C-API extension: `PyArg_ParseTuple("O!O!")`, `PyArray_DATA` pointers, a naive `O(n²)` S·x matrix-vector loop then a dot product for risk, a single dot loop for return, packaged with `PyMethodDef`/`PyModuleDef`/`PyInit_` and `import_array()`. The `.py` wrapper `np.ascontiguousarray(dtype=float64)` and dispatches to the compiled module. Straightforward C-extension authoring.

**Verifier** — pytest: a compiled extension (`.so`/`.pyd`, not `.py`) exists exposing both functions; baseline sanity; correctness vs protected baseline within 1e-10 at N=100 and N∈{5000,6000,8000}; and speedup ≥1.2× (min-of-3 timing) at each large N.

**Difficulty drivers** — Requires CPython C-API + NumPy buffer-protocol fluency and correct `setup.py` build; float64 contiguity for exact 1e-10 match; and a perf floor (naive C over interpreted Python loops clears 1.2× comfortably, so perf is the easy part — correctness + a working build is the real bar). Env/build setup (numpy headers, compiler) matters.

**quanta attack points** — `container_exec` for write→build_ext→benchmark→pytest, all exit-code driven; no interactivity. Main risk: build/link failures (missing numpy include, ABI) or dtype/stride bugs breaking the 1e-10 tolerance. The iterate-until-pass loop is strong: compile errors and the tolerance/speedup asserts give precise, fast feedback to converge.
