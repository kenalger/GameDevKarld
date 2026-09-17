#!/usr/bin/env bash
#
# Fetches jsmolka/gba-tests — freely-licensed homebrew accuracy tests for the GBA — into
# tests/roms/gba-tests/ (gitignored via *.gba). No commercial ROM is fetched. Idempotent.

set -euo pipefail

readonly REPO="jsmolka/gba-tests"
readonly REF="master"
readonly URL="https://codeload.github.com/${REPO}/tar.gz/${REF}"

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DEST="${ROOT}/tests/roms/gba-tests"
readonly STAMP="${DEST}/.fetched"

if [[ -f "${STAMP}" ]]; then
  echo "GBA tests already present in tests/roms/gba-tests/ — nothing to do."
  exit 0
fi

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' is required." >&2; exit 1; }
done

echo "Fetching ${REPO}@${REF}…"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

if ! curl --fail --location --silent --show-error --output "${tmp}/gba.tar.gz" "${URL}"; then
  echo "error: download failed from ${URL}" >&2
  exit 1
fi

mkdir -p "${DEST}"
tar -xzf "${tmp}/gba.tar.gz" -C "${tmp}"
# Only the prebuilt ROMs are needed; the sources stay in the archive.
find "${tmp}"/gba-tests-* -name '*.gba' -exec cp {} "${DEST}/" \;

count="$(find "${DEST}" -name '*.gba' | wc -l | tr -d ' ')"
if [[ "${count}" -eq 0 ]]; then
  echo "error: no .gba files found in the archive." >&2
  exit 1
fi

printf 'ref=%s\nroms=%s\nfetched=%s\n' "${REF}" "${count}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${STAMP}"
echo "Done: ${count} GBA test ROMs in tests/roms/gba-tests/."
