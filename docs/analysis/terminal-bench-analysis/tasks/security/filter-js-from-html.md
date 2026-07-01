---
task: filter-js-from-html
category: security
difficulty: medium
tags: [security]
expert_min: 45
junior_min: 480
skill_class: ADVERSARIAL-SEC
terminal_native: low
docker_image: alexgshaw/filter-js-from-html:20251031
---

# filter-js-from-html

**Goal** — Write `/app/filter.py` that takes an HTML file (argv[1]) and edits it **in place** to strip all JavaScript / XSS vectors while preserving legitimate HTML (formatting, tables, headers, safe attributes). Output must be functionally identical to input minus the harmful substrings.

**Solution shape** — `solve.sh` heredoc-writes a compact `filter.py` using BeautifulSoup: `decompose()` all `<script>` and `frame/iframe/object/embed` tags, delete every `on*` event-handler attribute, then string-replace `javascript:` → `""` and neutralize stray `<script` → `&lt;script`. Read file, filter, write back in place. One small file (~40 lines); the difficulty is coverage of attack vectors, not code volume.

**Verifier** — pytest downloads the davidwagner/html-sanitizer-testbed XSS corpus **plus** ~20 embedded vectors (event handlers, `javascript:` URLs, base64 data-URIs in iframe/object/embed, SVG onload, meta-refresh, malformed/`<<script>`, entity-encoded, case/tab/null-byte variants, template-tag smuggling, form/button `formaction`). Runs each through `filter.py`, batches results into HTML files, and loads them in **headless Chrome via Selenium** — the test fails if *any* `alert()` fires. A second test asserts clean HTML files are returned byte-unchanged. Binary 0/1.

**Difficulty drivers** — Adversarial breadth: must anticipate a wide, evasive XSS vector set (encodings, malformed tags, data-URIs, less-obvious sinks like `formaction`/meta-refresh) — missing one live vector fails the whole test since a real browser executes it. Simultaneously the filter must be conservative enough to leave benign HTML untouched. Real-browser grading means the agent can't rely on regex intuition; it must actually neutralize execution.

**quanta attack points** — `container_exec` to write/run the filter; the grader itself drives headless Chrome, so the agent doesn't need `pty_*`. Low terminal-native (a coding task). Main risk: the exit-code loop is only as good as the agent's local vector set — without pulling the real testbed corpus and a browser check, it can pass its own tests but still let a vector through the Selenium grader. Adversarial completeness is the failure mode.
