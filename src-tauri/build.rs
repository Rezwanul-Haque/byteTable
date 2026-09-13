fn main() {
    // MinGW flakiness fix: the GNU linker auto-exports every global symbol pulled
    // in from static libraries when linking the `cdylib` target (`*_lib.dll`),
    // and PE/COFF export ordinals are 16-bit. With the heavy dependency tree
    // here (aws-sdk, mongodb, scylla, sqlx, rusqlite, ring, …) that overflows
    // 65535 symbols and the link dies with "error: export ordinal too large".
    // Hiding symbols that come from archives leaves only this crate's own
    // exports in the table. The desktop executable links the `staticlib`/`rlib`
    // artifacts, not the DLL, so narrowing the export list changes nothing at
    // runtime. Only meaningful for the GNU toolchain — MSVC's linker has no such
    // auto-export behaviour and rejects the `-Wl,` flag.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu") {
        println!("cargo::rustc-link-arg=-Wl,--exclude-libs=ALL");
    }

    tauri_build::build()
}
