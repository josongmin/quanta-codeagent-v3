---
task: train-fasttext
category: model-training
difficulty: hard
tags: [data-processing, data-science]
expert_min: 30
junior_min: 90
skill_class: ML-TRAIN
terminal_native: med
docker_image: alexgshaw/train-fasttext:20251031
---

# train-fasttext

**Goal** — Train a fastText classifier on Yelp review data in `data/`, saved as `/app/model.bin`, that stays under 150MB while reaching >=0.62 accuracy on a held-out private test set from the same distribution.

**Solution shape** — ~15-line bash. `apt-get` build-essential/git, `git clone` facebookresearch/fastText and `make` the CLI. A tiny generated `convert_data.py` reads the parquet train split with pandas and writes fastText's `__label__{label} {text}` format to `train.txt`. Then `fasttext supervised -input train.txt -output model -wordNgrams 2 -dim 5` — the low `dim 5` is the key trick to keep the model well under 150MB while bigrams carry enough signal for >0.62.

**Verifier** — pytest (run under Python 3.11 with `fasttext-wheel`): unpacks `private_test.txt` from a tarball, loads `/app/model.bin`, predicts each line, and asserts sklearn `accuracy > 0.62`; separately asserts `getsize(model.bin) < 150MB`. reward binary 0/1. Both gates must hold simultaneously — the size/accuracy trade-off is the whole challenge.

**Difficulty drivers** — Not conceptually hard but requires knowing fastText's data format, the supervised CLI, and the hyperparameter levers (ngrams vs dim) that trade model size against accuracy. Building fastText from source and getting the parquet→txt conversion right are real setup steps. The dual constraint (size AND accuracy on an unseen test set) means naive high-dim training blows the size cap while too-small dim misses the accuracy bar.

**quanta attack points** — `container_exec` throughout (build, convert, train); no interactivity. Main failure risk: model exceeds 150MB (default dim too large) or under-fits below 0.62, or the label/text conversion format is malformed so predictions are garbage. The exit-code loop helps moderately — the agent can re-train and re-check size locally, but the accuracy gate is on a *private* test set it can't see, so it must generalize rather than tune to the visible data.
