//! Boot loader selection: pick between `VZLinuxBootLoader` and
//! `VZMacOSBootLoader` from the policy + image path.
//!
//! **Phase 3.3 scaffold** — all bodies are `unimplemented!()`. Phase 3.4
//! fills the real boot-loader construction.
//!
//! ## Selection rule (Phase 3.4)
//!
//! 1. If `policy.boot_image_path` ends in `.dmg` or `.ipsw` → macOS guest
//!    (`VZMacOSBootLoader` — Apple Silicon hosts only; Intel rejects).
//! 2. Otherwise → Linux guest (`VZLinuxBootLoader` with kernel + initrd
//!    from a sidecar manifest at `<image>.manifest.json`).
//! 3. Missing `boot_image_path` → typed error; the registry should have
//!    fallen through to Lima before reaching here.
//!
//! ## Linux boot loader requirements
//!
//! `VZLinuxBootLoader` needs:
//!   - `kernelURL` — path to a Linux kernel (bzImage / vmlinuz)
//!   - `initialRamdiskURL?` — optional initrd
//!   - `commandLine?` — kernel command line (`console=hvc0 root=/dev/vda` etc.)
//!
//! The simplest deployment is a curated `quanta-skybridge.dmg` image with
//! the kernel + rootfs bundled; Phase 3.4 may add an external registry
//! (Lima-style) but the binding itself only consumes paths.
//!
//! ## macOS guest support
//!
//! Out of scope for Skybridge (MCP servers are Linux-native). Documented
//! here for completeness but Phase 3.4 will reject `.ipsw`/`.dmg` boot
//! with `"macos-guest-not-supported-for-mcp"` — opening that door later is
//! a separate ADR.

#![cfg(target_os = "macos")]

use crate::NapiMcpVmPolicy;

/// Selected boot loader kind. Phase 3.3 enum surface — Phase 3.4 wraps a
/// real `objc2::Retained<dyn VZBootLoader>` per arm.
#[allow(dead_code)]
#[derive(Debug)]
pub enum BootLoaderKind {
    /// Linux guest (`VZLinuxBootLoader`). Only supported kind for MCP
    /// workloads in Phase 3.4.
    Linux,
    /// macOS guest (`VZMacOSBootLoader`). Reserved — Phase 3.4 rejects.
    MacOs,
}

/// Pick a boot loader for the given policy. Phase 3.3 returns the typed
/// enum kind only (no real handle). Phase 3.4 returns a real boxed loader
/// for consumption by `vm_config::compile_configuration`.
#[allow(dead_code)]
pub fn select(policy: &NapiMcpVmPolicy) -> Result<BootLoaderKind, String> {
    let path = policy.boot_image_path.as_deref().ok_or_else(|| {
        String::from(
            "boot_loader: policy.boot_image_path is required (Phase 3.4 may add a curated default registry)",
        )
    })?;

    // Phase 3.3: classify by extension only — Phase 3.4 will sniff the
    // image header (DMG magic, ELF header, etc.) for robustness.
    let path_lower = path.to_lowercase();
    if path_lower.ends_with(".dmg") || path_lower.ends_with(".ipsw") {
        return Err(String::from(
            "boot_loader: macOS guest boot not supported for MCP workloads (scope: Linux only)",
        ));
    }
    if path_lower.ends_with(".img")
        || path_lower.ends_with(".raw")
        || path_lower.ends_with("vmlinuz")
        || path_lower.contains("kernel")
    {
        return Ok(BootLoaderKind::Linux);
    }

    // Unknown extension — Phase 3.4 may probe; scaffold rejects.
    Err(format!(
        "boot_loader: cannot classify boot image {path} (expected Linux kernel / .img / .raw)",
    ))
}
