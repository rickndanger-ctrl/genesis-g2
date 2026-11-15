#!/bin/sh
set -eu
reader_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$reader_root/../bin"
xcrun swiftc -O -swift-version 5 "$reader_root/CodexTransport.swift" "$reader_root/CodexReader.swift" "$reader_root/CodexReaderCLI.swift" -o "$reader_root/../bin/codex-reader"
printf 'Built Codex read-only conversation adapter.\n'
