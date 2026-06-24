#!/usr/bin/env bash
#
# Ratel Factory — Pi Extension Installer / Helper
#
# Preferred install path is the direct Pi command:
#   pi install npm:@ratel-factory/pi-extension
# which pulls in @ratel-factory/core automatically as a dependency of the
# extension and activates the extension inside Pi. The Pi extension runs the
# Ratel orchestrator in-process — there is no separate daemon, no HTTP service
# boundary, and no `ratel --serve` to start.
#
# This script exists as a convenience wrapper for users who prefer an
# install-script flow. When run, it invokes the canonical
# `pi install npm:@ratel-factory/pi-extension` command for you. In --dev mode
# it builds the local workspace packages and installs the local extension
# build into Pi by path (for development only — it does not globally install
# core or start any service).
#
# This is the Pi-native path. It is NOT the OpenCode adapter. Use
# install-opencode.sh for OpenCode.
#
# Usage:
#   bash install/install-pi.sh
#   RATEL_VERSION=0.2.2 bash install/install-pi.sh
#
# Flags:
#   --dev      Install from local workspace instead of npm (for development)
#   --help     Show this help
#
# Environment variables:
#   RATEL_VERSION        Package version to install (default: latest)

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────

VERSION="${RATEL_VERSION:-latest}"
DEV_MODE=false
EXTENSION_NAME="@ratel-factory/pi-extension"

# ── Helpers ──────────────────────────────────────────────────────────────────

info()  { echo "  [ratel] $1"; }
warn()  { echo "  [ratel] WARNING: $1" >&2; }
error() { echo "  [ratel] ERROR: $1" >&2; exit 1; }

# ── Prerequisites ────────────────────────────────────────────────────────────

check_prerequisites() {
  info "Checking prerequisites..."

  if ! command -v node >/dev/null 2>&1; then
    error "Node.js is not installed. Install from https://nodejs.org/ first."
  fi
  if ! command -v npm >/dev/null 2>&1; then
    error "npm is not installed. Install Node.js from https://nodejs.org/ first."
  fi

  local node_version major_version
  node_version=$(node --version | sed 's/v//')
  major_version=$(echo "$node_version" | cut -d. -f1)
  if [ "$major_version" -lt 18 ]; then
    error "Node.js 18+ is required. Found: $node_version"
  fi

  info "Node.js $node_version ✓"
  info "npm $(npm --version) ✓"
}

# ── Pi CLI Detection ─────────────────────────────────────────────────────────

check_pi() {
  info "Checking Pi Coding Agent CLI..."

  if ! command -v pi >/dev/null 2>&1; then
    warn "Pi CLI not found in PATH."
    warn "Install it first (see https://github.com/earendil-works/pi-coding-agent), then re-run this script."
    error "Pi Coding Agent is required for the Ratel Pi extension."
  fi

  info "Pi $(pi --version 2>/dev/null || echo 'unknown') ✓"
}

# ── Install / Activate ────────────────────────────────────────────────────────

install_and_activate() {
  info "Installing Ratel Pi extension..."

  if [ "$DEV_MODE" = true ]; then
    info "Dev mode: installing from local workspace..."
    if [ ! -f "package.json" ] || [ ! -d "packages/core" ] || [ ! -d "packages/pi-extension" ]; then
      error "Dev mode requires running from the ratel repo root."
    fi
    # Build local packages so the path install resolves to compiled dist.
    (cd packages/core && npm run build >/dev/null 2>&1) || warn "core build failed; continuing"
    (cd packages/pi-extension && npm run build >/dev/null 2>&1) || warn "pi-extension build failed; continuing"
    # Install the local extension into Pi by path so developers test their build.
    # The extension declares @ratel-factory/core as a dependency; during local
    # development it resolves core from the workspace via npm/dedupe, so no
    # separate global install or service start is needed.
    local ext_dir
    ext_dir="$(pwd)/packages/pi-extension"
    pi install "$ext_dir" || error "Could not install local extension into Pi. Run: pi install $ext_dir"
  else
    info "Running: pi install npm:${EXTENSION_NAME}@${VERSION}"
    info "  (this installs the extension and its @ratel-factory/core dependency automatically)"
    pi install "npm:${EXTENSION_NAME}@${VERSION}" || error "Could not install extension into Pi. Run: pi install npm:${EXTENSION_NAME}"
  fi

  info "Ratel Pi extension installed ✓"
}

# ── Next Steps ────────────────────────────────────────────────────────────────

print_next_steps() {
  info ""
  info "=== Ratel Factory — Pi Extension Installed ==="
  info ""
  info "The Pi extension runs the Ratel orchestrator in-process. No separate"
  info "daemon or HTTP service is started."
  info ""
  info "Pi slash commands:"
  info "  /ratel             — show in-process availability & ping factory roles"
  info "  /ratel-start <goal>— start a new mission"
  info "  /ratel-status      — show current mission status"
  info "  /ratel-approve     — approve the current mission"
  info "  /ratel-observatory — show the dashboard / local mission directory"
  info ""
  info "Pi tools (the LLM can call these):"
  info "  ratel_start_mission, ratel_poll_status, ratel_get_status,"
  info "  ratel_approve_plan, ratel_answer_question, ratel_reply_to_factory,"
  info "  ratel_run_feature_worker, ratel_run_validation, ratel_ping_agents"
  info ""
  info "Things to try:"
  info "  - Open Pi in a project and run /ratel"
  info "  - Start a mission: /ratel-start <your goal>"
  info ""
  info "Bundled skill: ratel-factory (describes the mission loop)."
  info ""
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dev)
        DEV_MODE=true
        shift
        ;;
      --help|-h)
        echo "Ratel Factory — Pi Extension Installer / Helper"
        echo ""
        echo "Preferred:  pi install npm:@ratel-factory/pi-extension"
        echo ""
        echo "Usage: bash install-pi.sh [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --dev       Install from local workspace (for development)"
        echo "  --help, -h  Show this help"
        echo ""
        echo "Environment variables:"
        echo "  RATEL_VERSION        Package version to install (default: latest)"
        echo ""
        exit 0
        ;;
      *)
        error "Unknown argument: $1"
        ;;
    esac
  done

  echo ""
  echo "🚀 Ratel Factory — Pi Extension Installer / Helper"
  echo ""
  echo "  Preferred:  pi install npm:@ratel-factory/pi-extension"
  echo ""

  check_prerequisites
  check_pi
  install_and_activate
  print_next_steps
}

main "$@"
