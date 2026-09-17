#!/usr/bin/env bash
#
# Fetches the Game Boy accuracy test-ROM corpus into tests/roms/ (gitignored).
#
# These ROMs are freely redistributable homebrew test programs. No commercial ROM is
# fetched, and nothing fetched here is ever committed — see CLAUDE.md law #4.
#
# Idempotent: re-running with the corpus already present is a no-op.

set -euo pipefail

# Pinned. An unpinned corpus makes yesterday's scoreboard meaningless.
readonly TAG="v7.0"
readonly REPO="c-sp/game-boy-test-roms"
readonly ASSET="game-boy-test-roms-${TAG}.zip"
readonly URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
# Pinned digest of the pinned tag. A mismatch means the asset changed under us — stop.
readonly EXPECTED_SHA256="b9a9d7a1075aa35a3d07c07c34974048672d8520dca9e07a50178f5860c3832c"

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DEST="${ROOT}/tests/roms"
readonly STAMP="${DEST}/.fetched-${TAG}"

if [[ -f "${STAMP}" ]]; then
  echo "Test ROMs ${TAG} already present in tests/roms/ — nothing to do."
  exit 0
fi

for tool in curl unzip; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' is required but not installed." >&2; exit 1; }
done

echo "Fetching ${REPO} ${TAG}…"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

if ! curl --fail --location --silent --show-error --output "${tmp}/roms.zip" "${URL}"; then
  echo "error: download failed from ${URL}" >&2
  echo "       Check the tag exists, or fetch manually into ${DEST}/." >&2
  exit 1
fi

# Fail loudly rather than leaving an empty corpus that reads as "0 tests, all fine".
size="$(wc -c < "${tmp}/roms.zip" | tr -d ' ')"
if [[ "${size}" -lt 100000 ]]; then
  echo "error: downloaded archive is only ${size} bytes — refusing a truncated corpus." >&2
  exit 1
fi

echo "Downloaded ${size} bytes. Verifying checksum…"
if command -v shasum >/dev/null 2>&1; then
  checksum="$(shasum -a 256 "${tmp}/roms.zip" | cut -d' ' -f1)"
elif command -v sha256sum >/dev/null 2>&1; then
  checksum="$(sha256sum "${tmp}/roms.zip" | cut -d' ' -f1)"
else
  echo "error: no shasum or sha256sum available; refusing an unverified corpus." >&2
  exit 1
fi

if [[ "${checksum}" != "${EXPECTED_SHA256}" ]]; then
  echo "error: checksum mismatch for ${ASSET}" >&2
  echo "       expected ${EXPECTED_SHA256}" >&2
  echo "       actual   ${checksum}" >&2
  exit 1
fi

mkdir -p "${DEST}"
unzip -q -o "${tmp}/roms.zip" -d "${DEST}"

count="$(find "${DEST}" -type f \( -name '*.gb' -o -name '*.gbc' \) | wc -l | tr -d ' ')"
if [[ "${count}" -eq 0 ]]; then
  echo "error: archive extracted but contains no .gb/.gbc files." >&2
  exit 1
fi

printf 'tag=%s\nsha256=%s\nroms=%s\nfetched=%s\n' \
  "${TAG}" "${checksum}" "${count}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${STAMP}"

echo "Done: ${count} test ROMs in tests/roms/ (tag ${TAG}, sha256 ${checksum})."
