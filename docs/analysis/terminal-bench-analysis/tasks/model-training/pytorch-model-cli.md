---
task: pytorch-model-cli
category: model-training
difficulty: medium
tags: [coding, C, pytorch]
expert_min: 30
junior_min: 120
skill_class: CODE-AUTHOR
terminal_native: med
docker_image: alexgshaw/pytorch-model-cli:20251031
---

# pytorch-model-cli

**Goal** — Build a standalone C binary `cli_tool` that runs MNIST inference: `./cli_tool weights.json image.png` prints the predicted digit. Produce `cli_tool`, `weights.json` (converted from the given `model.pth`), and `prediction.txt` in `/app`.

**Solution shape** — Two languages: a short Python step (`pip install torch cpu`) peeks the `.pth` state_dict, then converts the 3-layer MLP (784→16→16→10) weights/biases to a flat `weights.json`. Then authors `cli_tool.c` implementing linear layers + ReLU + argmax, loading weights via the provided `cJSON.c` and decoding the PNG via provided `lodepng` (renamed .cpp→.c). Compiles with `gcc ... cJSON.c lodepng.c -lm`, runs on `image.png` into `prediction.txt`. ~1 C file (~230 lines) + 2 tiny Python scripts.

**Verifier** — pytest: `weights.json`/`cli_tool`/`prediction.txt` exist; `prediction.txt` == "2"; running the binary on `image.png` prints "2"; and — the real check — it downloads the first 50 MNIST test images, runs the binary on each, and asserts every prediction matches a hard-coded label list. Binary 0/1.

**Difficulty drivers** — Cross-language reimplementation: must read the PyTorch model architecture, serialize weights in the exact layout the C code expects, and replicate the forward pass (including PNG→grayscale normalization to /255) bit-faithfully so all 50 predictions match. Env setup (torch CPU, build-essential) is moderate; the 50-image exact-match is the hard gate.

**quanta attack points** — `container_exec` for pip/gcc/run steps (clean exit codes for compile + inference). No interactive component. Main risk: weight-layout / preprocessing mismatch causing wrong argmax on some of the 50 images. The exit-code loop helps a lot — the agent can locally reproduce the 50-image check and iterate until all match.
