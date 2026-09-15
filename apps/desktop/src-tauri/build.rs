use std::{env, path::PathBuf, process::Command};

fn output(command: &mut Command) -> String {
    let result = command.output().expect("Could not run the Apple toolchain");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=native/DootNative.swift");
        println!("cargo:rerun-if-changed=native/DootOverlay.swift");
        println!("cargo:rerun-if-changed=../src/tokens.css");
        let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
        let swift = output(Command::new("xcrun").args(["--find", "swiftc"]));
        let sdk = output(Command::new("xcrun").args(["--sdk", "macosx", "--show-sdk-path"]));
        let arch = if env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        // Keep the native accent tied to the same palette as the overlay and Windows.
        let tokens = std::fs::read_to_string("../src/tokens.css").unwrap();
        let rgb = tokens
            .split("--brand-rgb:")
            .nth(1)
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .split_whitespace()
            .map(|v| v.parse::<f64>().unwrap() / 255.0)
            .collect::<Vec<_>>();
        let palette = out.join("Palette.swift");
        std::fs::write(
            &palette,
            format!(
                "import SwiftUI\nlet dootAccent = Color(red: {}, green: {}, blue: {})\n",
                rgb[0], rgb[1], rgb[2]
            ),
        )
        .unwrap();
        output(
            Command::new(&swift)
                .args([
                    "-emit-library",
                    "-static",
                    "-swift-version",
                    "5",
                    "-module-name",
                    "DootNative",
                    "-O",
                    "-sdk",
                    &sdk,
                    "-target",
                    &format!("{arch}-apple-macosx14.0"),
                    "-module-cache-path",
                ])
                .arg(out.join("swift-cache"))
                    .arg("native/DootNative.swift")
                    .arg("native/DootOverlay.swift")
                    .arg(palette)
                .arg("-o")
                .arg(out.join("libdoot_native.a")),
        );
        println!("cargo:rustc-link-search=native={}", out.display());
        let toolchain = PathBuf::from(swift)
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("lib/swift/macosx");
        println!("cargo:rustc-link-search=native={}", toolchain.display());
        println!("cargo:rustc-link-search=native={sdk}/usr/lib/swift");
        println!("cargo:rustc-link-lib=static=doot_native");
        for framework in ["AppKit", "SwiftUI", "UniformTypeIdentifiers"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
    tauri_build::build()
}
