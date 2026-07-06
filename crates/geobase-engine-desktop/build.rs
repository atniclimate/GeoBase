fn main() {
    // Tauri codegen only when the desktop shell is actually being built —
    // the plain library/server build must stay dependency-light everywhere.
    if std::env::var_os("CARGO_FEATURE_SHELL").is_some() {
        tauri_build::build();
    }
}
