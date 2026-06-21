#!/usr/bin/env bash
#
# Ratel Factory — Native Pi Coding Agent Extension Installer
#
# Installs the Ratel factory for users of the Pi Coding Agent. This installs
# the Ratel core service and the native @ratel-factory/pi-extension Pi
# package, then activates the extension inside Pi.
#
# This is the Pi-native path. It is NOT the OpenCode adapter. Use
# install-opencode.sh for OpenCode.
#
# Usage:
#   curl -fsSL https://ratelfactory.dev/install-pi.sh | bash
#   # or locally:
#   bash install/install-pi.sh
#
# Flags:
#   --dev      Install from local workspace instead of npm (for development)
#   --port     Override the Ratel service port (default: 8765)
#   --help     Show this help
#
# Environment variables:
#   RATEL_VERSION        Package version to install (default: latest)
#   RATEL_SERVICE_PORT   Service port (default: 8765)

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────

VERSION="${RATEL_VERSION:-latest}"
SERVICE_PORT="${RATEL_SERVICE_PORT:-8765}"
DEV_MODE=false
EXTENSION_NAME="@ratel-factory/pi-extension"
CORE_NAME="@ratel-factory/core"

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

# ── Install Packages ─────────────────────────────────────────────────────────

install_packages() {
  info "Installing Ratel packages..."

  if [ "$DEV_MODE" = true ]; then
    info "Dev mode: installing from local workspace..."
    if [ ! -f "package.json" ] || [ ! -d "packages/core" ] || [ ! -d "packages/pi-extension" ]; then
      error "Dev mode requires running from the ratel repo root."
    fi
    npm install -g "./packages/core"
    npm install -g "./packages/pi-extension"
  else
    info "Installing $CORE_NAME@$VERSION from npm..."
    npm install -g "${CORE_NAME}@${VERSION}"
    info "Installing $EXTENSION_NAME@$VERSION from npm..."
    npm install -g "${EXTENSION_NAME}@${VERSION}"
  fi

  info "Packages installed ✓"
}

# ── Activate the Pi Extension ────────────────────────────────────────────────

activate_extension() {
  info "Activating the Ratel Pi extension..."

  if [ "$DEV_MODE" = true ]; then
    # In dev mode the global install created a node_modules entry; locate it
    # and install it into Pi by path so developers always test their build.
    local ext_dir
    ext_dir="$(npm root -g)/$EXTENSION_NAME"
    if [ -d "$ext_dir" ]; then
      pi install "$ext_dir" || warn "Could not install local extension into Pi. Run: pi install $ext_dir"
    else
      warn "Local extension not found at $ext_dir; run 'pi install $ext_dir' manually after building."
    fi
  else
    pi install "npm:${EXTENSION_NAME}@${VERSION}" || warn "Could not install extension into Pi. Run: pi install npm:${EXTENSION_NAME}"
  fi

  info "Extension activation attempted ✓"
}

# ── Start Service ────────────────────────────────────────────────────────────

start_service() {
  info "Starting Ratel service on port $SERVICE_PORT..."

  if curl -s "http://localhost:$SERVICE_PORT/health" >/dev/null 2>&1; then
    info "Ratel service already running on port $SERVICE_PORT ✓"
    return
  fi

  nohup ratel --serve --port "$SERVICE_PORT" >/dev/null 2>&1 &
  local pid=$!
  # Don't let the shell wait on the backgrounded child.
  disown "$pid" 2>/dev/null || true

  local attempts=0
  while [ $attempts -lt 30 ]; do
    if curl -s "http://localhost:$SERVICE_PORT/health" >/dev/null 2>&1; then
      info "Ratel service started ✓"
      info "Dashboard: http://localhost:$SERVICE_PORT (or fallback port)"
      return
    fi
    sleep 1
    attempts=$((attempts + 1))
  done

  warn "Service did not start within 30 seconds."
  warn "Try starting manually: ratel --serve --port $SERVICE_PORT"
}

# ── Verify ────────────────────────────────────────────────────────────────────

verify_installation() {
  info "Verifying installation..."

  if curl -s "http://localhost:$SERVICE_PORT/health" >/dev/null 2>&1; then
    info "Service health check ✓"
  else
    warn "Service health check failed. The service may still be starting."
  fi

  info ""
  info "=== Ratel Factory — Pi Extension Installed ==="
  info ""
  info "Ratel service: http://localhost:$SERVICE_PORT"
  info ""
  info "Pi slash commands:"
  info "  /ratel             — show service health & ping factory agents"
  info "  /ratel-start <goal>— start a new mission"
  info "  /ratel-status      — show current mission status"
  info "  /ratel-approve     — approve the current mission"
  info "  /ratel-observatory — open the dashboard"
  info ""
  info "Pi tools (the LLM can call these):"
  info "  ratel_start_mission, ratel_poll_status, ratel_get_status,"
  info "  ratel_approve_plan, ratel_answer_question, ratel_reply_to_factory,"
  info "  ratel_run_feature_worker, ratel_run_validation, ratel_ping_agents"
  info ""
  info "To start the service manually:"
  info "  ratel --serve --port $SERVICE_PORT"
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
      --port)
        SERVICE_PORT="$2"
        shift 2
        ;;
      --help|-h)
        echo "Ratel Factory — Pi Coding Agent Extension Installer"
        echo ""
        echo "Usage: bash install-pi.sh [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --dev       Install from local workspace (for development)"
        echo "  --port      Override the Ratel service port (default: 8765)"
        echo "  --help, -h  Show this help"
        echo ""
        echo "Environment variables:"
        echo "  RATEL_VERSION        Package version to install (default: latest)"
        echo "  RATEL_SERVICE_PORT   Service port (default: 8765)"
        echo ""
        exit 0
        ;;
      *)
        error "Unknown argument: $1"
        ;;
    esac
  done

  echo ""
  echo "🚀 Ratel Factory — Pi Coding Agent Extension Installer"
  echo ""

  check_prerequisites
  check_pi
  install_packages
  activate_extension
  start_service
  verify_installation
}

main "$@"
