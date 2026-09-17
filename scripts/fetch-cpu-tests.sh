#!/usr/bin/env bash
#
# Fetches the SingleStepTests SM83 per-opcode JSON suite into tests/sm83/ (gitignored).
#
# 500 files x 1000 cases = 500,000 tests, each with an initial state, a final state and
# per-M-cycle bus activity. This is the Phase 01 exit gate.
#
# Idempotent.

set -euo pipefail

readonly REF="main"
readonly REPO="SingleStepTests/sm83"
readonly URL="https://codeload.github.com/${REPO}/tar.gz/${REF}"

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DEST="${ROOT}/tests/sm83"
readonly STAMP="${DEST}/.fetched"

if [[ -f "${STAMP}" ]]; then
  echo "SM83 tests already present in tests/sm83/ — nothing to do."
  exit 0
fi

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' is required." >&2; exit 1; }
done

echo "Fetching ${REPO}@${REF}…"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

if ! curl --fail --location --silent --show-error --output "${tmp}/sm83.tar.gz" "${URL}"; then
  echo "error: download failed from ${URL}" >&2
  exit 1
fi

size="$(wc -c < "${tmp}/sm83.tar.gz" | tr -d ' ')"
if [[ "${size}" -lt 1000000 ]]; then
  echo "error: archive is only ${size} bytes — refusing a truncated suite." >&2
  exit 1
fi

mkdir -p "${DEST}"
tar -xzf "${tmp}/sm83.tar.gz" -C "${tmp}"
mv "${tmp}"/sm83-*/v1/*.json "${DEST}/"

count="$(find "${DEST}" -name '*.json' | wc -l | tr -d ' ')"
if [[ "${count}" -lt 400 ]]; then
  echo "error: expected ~500 opcode files, found ${count}." >&2
  exit 1
fi

printf 'ref=%s\nfiles=%s\nfetched=%s\n' \
  "${REF}" "${count}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${STAMP}"

echo "Done: ${count} opcode test files in tests/sm83/."
