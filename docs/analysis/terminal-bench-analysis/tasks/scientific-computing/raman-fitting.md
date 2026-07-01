---
task: raman-fitting
category: scientific-computing
difficulty: medium
tags: [coding, fitting, analysis, physics]
expert_min: 5
junior_min: 30
skill_class: NUMERIC-SCI
terminal_native: med
docker_image: alexgshaw/raman-fitting:20251031
---

# raman-fitting

**Goal** — Given a Raman spectrometer output file (`/app/graphene.dat`) for a graphene sample, fit Lorentzian peaks to the **G** peak (~1580 cm⁻¹) and **2D** peak (~2700 cm⁻¹) and write `x0, gamma, amplitude, offset` for each to `/app/results.json`.

**Solution shape** — Bash: inspect file, `pip install scipy==1.16.0 numpy==2.3.1`. A `convert.py` reparses the raw `.dat` (comma decimal → dot, tab → comma delimiter). A `fit.py` loads the two-column data, converts the x-axis from wavelength (nm) to wavenumber (`x = 1e7 / x` cm⁻¹), crops to the G window (1500-1700) and 2D window (2500-2900), and runs `scipy.optimize.curve_fit` of a Lorentzian `A·γ²/((x−x0)²+γ²)+offset` with physically-seeded initial guesses. Dumps both parameter sets to JSON. Two helper scripts + one JSON output.

**Verifier** — pytest checks each peak's fitted params against hard-coded expected values with tolerances: x0 within ±5 (G) / 5% (2D), gamma within ±1, amplitude within 5%, offset within 10%. reward binary 0/1.

**Difficulty drivers** — Domain knowledge is the gate: recognizing the raw format needs cleaning, that the axis must be converted nm→cm⁻¹, knowing graphene G/2D peak locations to window and seed the fit, and choosing the right lineshape (Lorentzian). Given those, `curve_fit` is quick — hence the very low 5-min expert estimate. Failure modes are silent bad fits (wrong window/seed → converges to garbage within tolerance-miss).

**quanta attack points** — `container_exec` iterate: write fit, run, inspect JSON, adjust windows/guesses. Exit-code loop helps somewhat, but the expected values are hidden, so the agent must apply the physics correctly rather than fit to the check. Main risk is the format conversion and axis transform — miss either and every fitted param is off. No interactivity.
