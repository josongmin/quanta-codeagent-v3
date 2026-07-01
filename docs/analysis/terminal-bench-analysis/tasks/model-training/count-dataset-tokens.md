---
task: count-dataset-tokens
category: model-training
difficulty: medium
tags: [machine-learning, data, datasets, tokenization, huggingface]
expert_min: 30
junior_min: 120
skill_class: ML-TRAIN
terminal_native: med
docker_image: alexgshaw/count-dataset-tokens:20251031
---

# count-dataset-tokens

**Goal** — Determine how many DeepSeek tokens exist in the "science" domain of the HuggingFace dataset `ryanmarten/OpenThoughts-1k-sample`, tokenized with the `Qwen/Qwen2.5-1.5B-Instruct` tokenizer, and write the integer to `/app/answer.txt`. The dataset README defines what "science" means and how to load it.

**Solution shape** — `solve.sh` `pip install`s pinned `datasets`/`transformers`/`jinja2`, then heredocs `count_tokens.py`: loads the Qwen2.5 tokenizer, loads the `"metadata"` config split, filters `domain ∈ {chemistry, biology, physics}` (the README's definition of "science"), and for each row tokenizes `deepseek_reasoning` + `deepseek_solution`, summing lengths across `os.cpu_count()` procs. Prints the sum → `/app/answer.txt`. One ~15-line script.

**Verifier** — pytest asserts the string `"79586"` appears in `/app/answer.txt`. reward 0/1 (exact expected count).

**Difficulty drivers** — Mostly comprehension/spec-reading: knowing "science" = chemistry+biology+physics (from README, not obvious), picking the right dataset config (`metadata`), the right columns to tokenize, and the right tokenizer. The exact expected integer means any deviation in field selection or tokenizer config fails. Modest env setup (HF download + tokenizer). Not much algorithmic depth.

**quanta attack points** — `container_exec`: pip install, read the HF README (network), run the tokenize script. No interactivity. The exit-code loop is weak — the target count is hidden, so the agent can't tell a wrong-column answer from a right one; correctness hinges on correctly reading the README spec. Main risk: HF download/network flakiness and mis-identifying which fields/domains constitute the counted set.
