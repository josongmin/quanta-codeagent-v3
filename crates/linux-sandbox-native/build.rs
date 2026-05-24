// Build script. napi-rs runs ABI symbol generation here. Kept minimal —
// the crate has no other build-time concerns (no proto codegen, no C link).
extern crate napi_build;

fn main() {
    napi_build::setup();
}
