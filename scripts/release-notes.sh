#!/usr/bin/env bash
# Print one version's section of CHANGELOG.md, for use as GitHub release notes.
#
# This is a verbatim extraction, never a reformat. GitHub renders release
# bodies with GFM hard line breaks, so CHANGELOG.md is written with one long
# line per paragraph and copies across unchanged.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CHANGELOG="${REPO_ROOT}/CHANGELOG.md"

function usage() {
  cat <<EOF
Usage: $(basename "${0}") [version]

Print the CHANGELOG.md section for a release. Defaults to the version in
package.json. A leading "v" is accepted and ignored.

Examples:
  $(basename "${0}")                       # current package.json version
  $(basename "${0}") 0.1.0
  gh release create v0.1.0 --notes-file <($(basename "${0}"))
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

version="${1:-}"
if [[ -z "${version}" ]]; then
  version="$(node -p "require('${REPO_ROOT}/package.json').version")"
fi
version="${version#v}"

awk -v want="${version}" '
  /^## / {
    inside = (index($0, "## [" want "]") == 1)
    next
  }
  !inside { next }
  /^\[(Unreleased|[0-9]+\.[0-9]+\.[0-9]+)\]:[ \t]+https?:\/\// { next }
  { lines[++n] = $0; if (NF) last = n }
  END {
    if (!last) {
      printf("no CHANGELOG section for version %s\n", want) > "/dev/stderr"
      exit 1
    }
    start = 1
    while (lines[start] == "") start++
    for (i = start; i <= last; i++) print lines[i]
  }
' "${CHANGELOG}"
