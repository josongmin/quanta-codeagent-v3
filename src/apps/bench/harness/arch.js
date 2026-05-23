/**
 * Host architecture detection for SWE-bench Docker image selection.
 *
 * Why this matters: SWE-bench's upstream default namespace (`swebench`) pulls
 * prebuilt x86_64 images. On Apple Silicon (arm64) those run under emulation —
 * a tiny django test that takes ~2-3s natively measured 20s under emulation in
 * our triage. Building locally (`--namespace none`) lets the harness build for
 * the host arch where the instance spec allows, avoiding the x86-pull-then-
 * emulate path.
 */
/** Detect the host arch from `process.arch`. */
export const hostArch = () => {
    if (process.arch === "arm64")
        return "arm64";
    if (process.arch === "x64")
        return "x64";
    return "other";
};
/**
 * Default SWE-bench image namespace — chosen per host arch:
 *
 *   - `arm64` ⇒ `"swebench"` (pull prebuilt x86_64 images from Docker Hub).
 *     SWE-bench base/env Dockerfiles pin `platform=linux/amd64` and the base
 *     image build requires a miniconda download that is slow + network-flaky
 *     when emulated. The PULL path runs the same image under x86 emulation
 *     (Rosetta on macOS, qemu on Linux) — slower per-test, but EVERY image
 *     is one network pull instead of a multi-step local build. This is the
 *     only reliable arm64 default; the empirical evidence is django-12419
 *     RESOLVED via pull, vs base-image-build stuck at `wget miniconda.sh`
 *     via local build.
 *
 *   - `x64` ⇒ `"none"` (build locally). Native amd64 host: local builds are
 *     native + cacheable, no emulation cost, and we don't depend on the
 *     prebuilt set being current.
 *
 * Operators can override either default via `QUANTA_SWEBENCH_NAMESPACE`.
 */
export const defaultNamespace = (arch = hostArch()) => arch === "arm64" ? "swebench" : "none";
