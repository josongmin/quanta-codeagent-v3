---
task: modernize-scientific-stack
category: scientific-computing
difficulty: medium
tags: [python-migration, scientific-computing, legacy-modernization, climate-science, data-processing]
expert_min: 120
junior_min: 240
skill_class: DEBUG-FIX
terminal_native: low
docker_image: alexgshaw/modernize-scientific-stack:20251031
---

# modernize-scientific-stack

**Goal** — A legacy Python 2.7 climate script (`/app/climate_analyzer/analyze_climate.py`, do-not-modify) is broken on Py3. Write a modern `/app/analyze_climate_modern.py` plus a `requirements.txt`/`pyproject.toml`, reading the CSV with pandas, using pathlib/configparser, and printing per-station mean temperatures in an exact format.

**Solution shape** — ~50-line bash with two heredocs. One writes `requirements.txt` (numpy/pandas/matplotlib/scipy with `>=` constraints). The other writes `analyze_climate_modern.py`: pandas `read_csv` (UTF-8), pathlib `Path`, optional configparser read, then loops over `df['station_id'].unique()` printing `f"Station {id} mean temperature: {mean:.1f}°C"`. Effectively re-authoring the script fresh against the spec rather than porting line-by-line.

**Verifier** — pytest: `analyze_climate_modern.py` exists and runs (returncode 0); stdout contains "Station 101" and "Station 102" and "mean temperature"; regex-extracted means must be ~-15.5°C (station 101) and ~30.3°C (station 102) within 0.1; and a dependency file (requirements.txt or pyproject.toml) must exist. reward binary 0/1.

**Difficulty drivers** — Low-to-medium: it's a straightforward Py2→Py3 rewrite with a strict output format (the `{:.1f}°C` string and station labels must match the regex) and two numeric checks. Knowing pandas/pathlib/configparser idioms and matching the exact print format is the main gate; the "modernization" framing is mostly about producing clean, deprecation-free Py3 code.

**quanta attack points** — `container_exec` to write both files and run the script; no interactivity. Main failure risk: output-format drift (wrong label casing, missing °C, wrong precision) breaking the regex, or reading the CSV such that station means come out slightly off. The exit-code loop is a good fit — the agent can run the script and see stdout, iterating quickly toward the exact expected lines and numeric values.
