#!/usr/bin/env bash
#
# Ratel Factory — Pi Extension Installer (compatibility helper)
#
# Preferred install path is the direct Pi command:
#   pi install npm:@ratel-factory/pi-extension
# which pulls in @ratel-factory/core automatically as a dependency of the
# extension and activates the extension inside Pi.
#
# This script exists for users who still curl-install Ratel. When run, it
# invokes the canonical `pi install npm:@ratel-factory/pi-extension` command
# for you (no separate global `npm install -g @ratel-factory/core` needed).
# In --dev mode it installs from a local workspace clone instead.
#
# This is the Pi-native path. It is NOT the OpenCode adapter. Use
# install-opencode.sh for OpenCode.
#
# Usage:
#   bash install/install-pi.sh
#   RATEL_VERSION=0.2.1 bash install/install-pi.sh
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
    # Install core globally so the bundled resolver can find it via node module
    # resolution from the dev-installed extension (dev path).
    npm install -g "./packages/core"
    # Install the local extension into Pi by path so developers test their build.
    local ext_dir
    ext_dir="$(npm root -g)/$EXTENSION_NAME"
    if [ ! -d "$ext_dir" ]; then
      ext_dir="$(pwd)/packages/pi-extension"
    fi
    pi install "$ext_dir" || error "Could not install local extension into Pi. Run: pi install $ext_dir"
  else
    info "Running: pi install npm:${EXTENSION_NAME}@${VERSION}"
    info "  (this installs the extension and its @ratel-factory/core dependency automatically)"
    pi install "npm:${EXTENSION_NAME}@${VERSION}" || error "Could not install extension into Pi. Run: pi install npm:${EXTENSION_NAME}"
  fi

  info "Ratel Pi extension installed ✓"
}

# ── Start Service ────────────────────────────────────────────────────────────

start_service() {
  info "Checking for a running Ratel service on port $SERVICE_PORT..."

  if curl -s "http://localhost:$SERVICE_PORT/health" >/dev/null 2>&1; then
    info "Ratel service already running on port $SERVICE_PORT ✓"
    return
  fi

  # The Pi extension auto-starts the bundled @ratel-factory/core service on
  # session_start via Node module resolution, so a global `ratel` binary is not
  # required for the public install path. Only attempt a PATH-based start for
  # dev/backward compatibility when `ratel` is available.
  if ! command -v ratel >/dev/null 2>&1; then
    info "No global 'ratel' on PATH; the Pi extension will auto-start the"
    info "bundled core service when you open a project in Pi."
    return
  fi

  info "Starting Ratel service on port $SERVICE_PORT via 'ratel' (PATH fallback)..."
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
  warn "The Pi extension will auto-start it on session_start, or run: ratel --serve --port $SERVICE_PORT"
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
        echo "Ratel Factory — Pi Extension Installer (compatibility helper)"
        echo ""
        echo "Preferred:  pi install npm:@ratel-factory/pi-extension"
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
  echo "🚀 Ratel Factory — Pi Extension Installer (compatibility helper)"
  echo ""
  echo "  Preferred:  pi install npm:@ratel-factory/pi-extension"
  echo ""

  check_prerequisites
  check_pi
  install_and_activate
  start_service
  verify_installation
}

main "$@"
