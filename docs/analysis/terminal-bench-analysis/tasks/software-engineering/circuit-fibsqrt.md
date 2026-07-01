---
task: circuit-fibsqrt
category: software-engineering
difficulty: hard
tags: [software-engineering]
expert_min: 960
junior_min: 2400
skill_class: CODE-AUTHOR
terminal_native: low
docker_image: alexgshaw/circuit-fibsqrt:20251031
---

# circuit-fibsqrt

**Goal** — `/app/sim.c` is a logic-gate simulator: `gates.txt` defines gates (`outX = outY/0/1/~/&/|/^`), the first 32 lines are seeded from stdin's binary, and after 32000 steps the last 32 lines are read out as the 32-bit output. Author a `gates.txt` (<32,000 lines) so that `/app/sim N` outputs `fib(isqrt(N)) mod 2^32`.

**Solution shape** — Bash emits a large (~13 KB, ~400-line) Python HDL library `soln.py` and runs it to generate `gates.txt`. The Python builds a gate-graph DSL (a `Signal` class with VAR/`~`/`&`/`|`/`^` nodes, clocks, registers, ROM) and synthesizes a sequential circuit — integer sqrt plus an iterative Fibonacci accumulator over the 32000-cycle budget — then `export_gates()` flattens the netlist into the `outX = ...` gate lines. Essentially building a tiny hardware-description compiler and a Fibonacci/isqrt datapath in pure boolean gates.

**Verifier** — pytest: `gates.txt` exists and has <32,000 lines; compiles the reference `sim.c`; runs `/app/sim N` on ~28 test N (including k², k²±1 around several k) and asserts each output equals `fib(isqrt(n)) % 2^32`.

**Difficulty drivers** — Digital-logic design from scratch: expressing arithmetic (isqrt, add, modular Fibonacci, sequencing/registers) purely as combinational+sequential gates within a fixed step budget and line limit. Requires either handwriting a netlist or, as the solution does, building a gate-level synthesis framework. Expert est. 16h. Terminal is just the runtime — this is a pure authoring/algorithm problem.

**quanta attack points** — `container_exec` for generate→compile sim.c→run across N; no TUI. Main risk: gate-graph timing/step-budget bugs and off-by-one at the isqrt/perfect-square boundaries (the test hammers k²±1). The iterate-until-pass loop helps moderately — the test enumerates many N so a failing boundary is visible — but the core work is designing the circuit, which the test can't guide.
