#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
mkdir -p bin
swiftc -D VISIBILITY_TEST native/overlay.swift -o "$build_dir/visibility-check"
"$build_dir/visibility-check"
swiftc native/overlay.swift -O -target arm64-apple-macos13.0 -o "$build_dir/arm64"
swiftc native/overlay.swift -O -target x86_64-apple-macos13.0 -o "$build_dir/x86_64"
lipo -create "$build_dir/arm64" "$build_dir/x86_64" -output bin/token-speed-macos
codesign --force --sign - bin/token-speed-macos
