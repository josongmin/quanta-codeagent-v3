---
task: hf-model-inference
category: data-science
difficulty: medium
tags: [api, coding, data-processing, data-science]
expert_min: 20
junior_min: 120
skill_class: ML-TRAIN
terminal_native: med
docker_image: alexgshaw/hf-model-inference:20251031
---

# hf-model-inference

**Goal** — Download the HF `distilbert-base-uncased-finetuned-sst-2-english` sentiment model to `/app/model_cache/sentiment_model`, then stand up a Flask API at `POST /sentiment` (port 5000, host 0.0.0.0) that returns positive/negative + per-class confidence, running in the background.

**Solution shape** — `solve.sh` does 3 things: (1) `python3 -c` snippet that `from_pretrained` downloads model+tokenizer and `save_pretrained`s them to the cache dir; (2) heredoc-writes `app.py` (Flask app: loads local model, softmaxes logits, returns JSON, 400 on missing `text`); (3) launches `nohup python app.py &`, sleeps 5, runs a small `test_api.py`. ~3 files, mostly boilerplate; the real work is knowing the transformers API and running a background service.

**Verifier** — pytest: model dir loads via `AutoModel/AutoTokenizer`; API reachable on `0.0.0.0:5000`; 6 fixed sentences classify correctly with the right confidence ordering and float types; missing-field request returns 400 with `error`. Binary 0/1.

**Difficulty drivers** — Not algorithmically hard; the friction is env/service: correct transformers download, a live long-running Flask process bound to 0.0.0.0:5000 that must still be up at grade time, plus exact JSON schema + 400 handling. Model must actually classify all 6 texts right (incl. a couple mildly adversarial ones).

**quanta attack points** — Mostly `container_exec` for install/download/write-file steps. Key risk: the API is a persistent background process — a naive exit-code loop can mark "done" while the server has died or was never backgrounded; must verify port 5000 is live (curl) as its own step. No interactive TUI, so no `pty_*` needed. The iterate-until-tests-pass loop helps for schema/400 correctness but not for the "keep it running" trap.
