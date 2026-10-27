#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${JAVA_HOME:-}" ]] && "$JAVA_HOME/bin/javac" -version; then exit 0; fi
if [[ -x .tools/jdk/bin/javac ]]; then .tools/jdk/bin/javac -version; exit 0; fi
if command -v javac >/dev/null; then javac -version; exit 0; fi
mkdir -p .tools/packages .tools/extracted
cd .tools/packages
apt-get download openjdk-21-jdk-headless openjdk-21-jre-headless
for deb in ./*.deb; do dpkg-deb -x "$deb" ../extracted; done
cd ../..
jdk_path=$(find "$PWD/.tools/extracted/usr/lib/jvm" -name javac -type f | head -1)
ln -s "$(dirname "$(dirname "$jdk_path")")" .tools/jdk
.tools/jdk/bin/javac -version
