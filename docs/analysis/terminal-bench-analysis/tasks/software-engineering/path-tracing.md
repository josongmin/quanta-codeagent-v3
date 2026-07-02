---
task: path-tracing
category: software-engineering
difficulty: hard
tags: [images]
expert_min: 360
junior_min: 2400
skill_class: NUMERIC-SCI
terminal_native: low
docker_image: alexgshaw/path-tracing:20251031
---

# path-tracing

**Goal** — Reverse-engineer a programmatically-rendered reference image (`/app/image.ppm`) and write a self-contained C program `image.c` that regenerates it into `reconstructed.ppm` with ≥0.99 normalized-L2 (cosine) similarity — without reading the reference and with compressed source <2KB.

**Solution shape** — Pure code authoring. `solve.sh` `cat`s a ~230-line C ray tracer: vec3 struct + ops, ray-sphere and ray-plane intersection, a single red sphere on a checkerboard floor, sky gradient background, a directional light with hard shadows and ambient term, rendered at 2400×1800 (800×600 × 3 supersample), written as ASCII PPM (P3). No libraries beyond libm. One `.c` file.

**Verifier** — pytest: `image.c` exists; compiles `gcc -static ... -lm`; compressed source <2100 bytes; `gcc -H` shows no `/app/` includes (no data-embedding via headers); runs inside a chroot jail (so it can't read the moved reference) and produces `reconstructed.ppm`; and cosine similarity to `image.ppm` ≥0.99. Binary 0/1.

**Difficulty drivers** — Must *infer the whole scene and shading model from a single image*: geometry, camera, colors, light direction, checkerboard, shadow/ambient constants — then reimplement it compactly. The <2KB-compressed constraint forbids embedding pixels, forcing a genuine algorithmic reconstruction. 3D graphics/rendering domain knowledge; 0.99 similarity is tight.

**quanta attack points** — Code-authoring; `container_exec` to compile and run, but the agent **cannot see the target** (chroot/moved reference), so it can't directly compute similarity while iterating unless it renders and eyeballs its own PPM. No TUI. Main risk: matching camera/scene params closely enough for 0.99 cosine. The exit-code loop verifies compile/size/run but gives no similarity gradient — the hard part is visual/geometric inference, not shell iteration.
