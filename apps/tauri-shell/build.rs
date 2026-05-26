// Tauri 2.x build script — invokes `tauri-build` to:
//   * generate the resource context from `tauri.conf.json`,
//   * stitch capability files under `capabilities/` into the
//     compile-time ACL the runtime enforces,
//   * compile resource bundles (icons, sidecar binary references).
//
// Per ADR-0317, this file is intentionally minimal. All configuration lives
// in `tauri.conf.json` so the source of truth stays declarative.

fn main() {
    tauri_build::build();
}
