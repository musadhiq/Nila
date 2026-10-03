// Nila — native backend entry point.
//
// The binary is intentionally thin: real logic lives in the `nila_lib`
// crate modules (db, scheduler, …) so it can be unit-tested
// without a running Tauri app.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nila_lib::run();
}
