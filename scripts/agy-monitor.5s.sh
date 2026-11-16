#!/usr/bin/env bash
# <xbar.title>Agy Monitor</xbar.title>
# <xbar.version>0.1.0</xbar.version>
# <xbar.desc>Real-time monitoring of Antigravity and Jetski sessions</xbar.desc>
# <xbar.author>eggboy</xbar.author>
# <xbar.var>string(AGY_MENUBAR_SCRIPT="${HOME}/scripts/agy-menubar.ts"): Path to the helper script</xbar.var>

# SwiftBar/xbar plugin wrapper -- delegates to the Node/Bun/tsx helper script.
# Filename convention: agy-monitor.5s.sh -> refreshes every 5 seconds.

set -euo pipefail

# SwiftBar/xbar launches with a minimal PATH that excludes Homebrew.
# Add common install locations so node/bun/tsx/npx are found.
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.bun/bin:${HOME}/.local/bin:${PATH}"

if [[ "${0}" == */* ]]; then
  SCRIPT_DIR="$(cd "${0%/*}" && pwd)"
else
  SCRIPT_DIR="$(pwd)"
fi

# Resolve symlinks to find the real script directory
REAL_SCRIPT="${0}"
if [[ -L "${REAL_SCRIPT}" ]]; then
  REAL_SCRIPT="$(readlink "${0}")"
  [[ "${REAL_SCRIPT}" != /* ]] && REAL_SCRIPT="${SCRIPT_DIR}/${REAL_SCRIPT}"
fi
if [[ "${REAL_SCRIPT}" == */* ]]; then
  REAL_DIR="$(cd "${REAL_SCRIPT%/*}" && pwd)"
else
  REAL_DIR="${SCRIPT_DIR}"
fi

# Resolve helper script: try real dir first, then sibling, then env var
HELPER="${REAL_DIR}/agy-menubar.ts"
if [[ ! -f "${HELPER}" ]]; then
  HELPER="${SCRIPT_DIR}/agy-menubar.ts"
fi
if [[ ! -f "${HELPER}" ]]; then
  HELPER="${AGY_MENUBAR_SCRIPT:-}"
fi

if [[ -z "${HELPER}" || ! -f "${HELPER}" ]]; then
  # Exit 0 intentionally -- non-zero causes SwiftBar to show an error badge
  echo "⚪ | size=14"
  echo "---"
  echo "Helper script not found | color=red"
  echo "Expected: ${SCRIPT_DIR}/agy-menubar.ts | size=11 color=#888888"
  exit 0
fi

# Absolute path to this wrapper, exported so the helper can build click
# actions that re-enter through it and inherit its runtime probing.
AGY_MENUBAR_PLUGIN="${SCRIPT_DIR}/${0##*/}"
export AGY_MENUBAR_PLUGIN

# Try runtimes in order: node (>= 22.18 native TS) > bun > tsx > npx tsx.
# Cache the node >= 22.18 probe keyed on binary path and mtime so warm 5s ticks
# avoid spawning an extra `node -v` process before `exec node`.
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -n "${NODE_BIN}" ]]; then
  STATE_BASE="${AGY_MONITOR_STATE_DIR:-${HOME}/.gemini}"
  PROBE_CACHE="${STATE_BASE}/.agy-monitor-cache/.runtime-node"
  CACHED_PROBE=""
  if [[ -f "${PROBE_CACHE}" && ! "${NODE_BIN}" -nt "${PROBE_CACHE}" ]]; then
    read -r CACHED_PROBE < "${PROBE_CACHE}" || true
  fi
  if [[ "${CACHED_PROBE}" == "ok:${NODE_BIN}" ]]; then
    exec "${NODE_BIN}" --no-warnings "${HELPER}" "$@"
  elif [[ "${CACHED_PROBE}" != "skip:${NODE_BIN}" ]]; then
    NODE_VER="$("${NODE_BIN}" -v 2>/dev/null || true)"
    NODE_VER="${NODE_VER#v}"
    NODE_MAJ="${NODE_VER%%.*}"
    NODE_REST="${NODE_VER#*.}"
    NODE_MIN="${NODE_REST%%.*}"
    mkdir -p "${STATE_BASE}/.agy-monitor-cache" 2>/dev/null || true
    if [[ "${NODE_MAJ}" =~ ^[0-9]+$ && "${NODE_MIN}" =~ ^[0-9]+$ ]] && \
       { (( NODE_MAJ > 22 )) || (( NODE_MAJ == 22 && NODE_MIN >= 18 )); }; then
      printf 'ok:%s\n' "${NODE_BIN}" > "${PROBE_CACHE}" 2>/dev/null || true
      exec "${NODE_BIN}" --no-warnings "${HELPER}" "$@"
    else
      printf 'skip:%s\n' "${NODE_BIN}" > "${PROBE_CACHE}" 2>/dev/null || true
    fi
  fi
fi

if command -v bun &>/dev/null; then
  exec bun run "${HELPER}" "$@"
elif command -v tsx &>/dev/null; then
  exec tsx "${HELPER}" "$@"
elif command -v npx &>/dev/null; then
  exec npx --yes tsx "${HELPER}" "$@" 2>/dev/null
else
  # Exit 0 intentionally -- non-zero causes SwiftBar to show an error badge
  echo "⚪ | size=14"
  echo "---"
  echo "No TypeScript runtime found | color=red"
  echo "Install Node.js (>= 22.18), bun, or tsx | size=11 color=#888888"
  echo "---"
  echo "brew install node | bash='brew install node' terminal=true"
  exit 0
fi
