#!/usr/bin/env bash
#
# Ratel Pi SDK Installer
#
# Installs the Ratel factory for Pi SDK. This is a single-agent installer:
# it does NOT detect or install other agents. Use install-opencode.sh for OpenCode.
#
# Usage:
#   curl -fsSL https://ratel.dev/install-pi.sh | bash
#   # or locally:
#   bash install/install-pi.sh
#
# Flags:
#   --dev      Install from local workspace instead of npm
#   --port     Override the Ratel service port (default: 8765)
#   --help     Show this help

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────

VERSION="${RATEL_VERSION:-latest}"
SERVICE_PORT="${RATEL_SERVICE_PORT:-8765}"
DEV_MODE=false
EXTENSION_NAME="@ratel/pi-extension"
CORE_NAME="@ratel/core"

# ── Helpers ──────────────────────────────────────────────────────────────────

info() {
  echo "  [ratel] $1"
}

warn() {
  echo "  [ratel] WARNING: $1" >&2
}

error() {
  echo "  [ratel] ERROR: $1" >&2
  exit 1
}

die() {
  error "$1"
}

# ── Prerequisites ────────────────────────────────────────────────────────────

check_prerequisites() {
  info "Checking prerequisites..."

  if ! command -v node >/dev/null 2>&1; then
    die "Node.js is not installed. Install from https://nodejs.org/ first."
  fi

  if ! command -v npm >/dev/null 2>&1; then
    die "npm is not installed. Install Node.js from https://nodejs.org/ first."
  fi

  local node_version
  node_version=$(node --version | sed 's/v//')
  local major_version
  major_version=$(echo "$node_version" | cut -d. -f1)
  if [ "$major_version" -lt 18 ]; then
    die "Node.js 18+ is required. Found: $node_version"
  fi

  info "Node.js $node_version ✓"
  info "npm $(npm --version) ✓"
}

# ── Pi SDK Detection ─────────────────────────────────────────────────────────

check_pi_sdk() {
  info "Checking Pi SDK..."

  if ! command -v pi >/dev/null 2>&1; then
    warn "Pi CLI not found in PATH."
    warn "Install it from https://pi.ai/ first, then re-run this script."
    die "Pi SDK is required for the Ratel extension."
  fi

  info "Pi $(pi --version 2>/dev/null || echo 'unknown') ✓"

  # Check Pi extension directory
  local pi_dir="${HOME}/.pi"
  if [ ! -d "$pi_dir" ]; then
    info "Creating Pi directory: $pi_dir"
    mkdir -p "$pi_dir"
  fi
}

# ── Install Packages ─────────────────────────────────────────────────────────

install_packages() {
  info "Installing Ratel packages..."

  if [ "$DEV_MODE" = true ]; then
    info "Dev mode: installing from local workspace..."
    # In dev mode, we assume the user cloned the repo and runs the script from there
    if [ ! -f "package.json" ] || [ ! -d "packages/core" ]; then
      die "Dev mode requires running from the ratel repo root."
    fi
    npm install -g "./packages/core"
    npm install -g "./packages/pi-extension"
  else
    info "Installing $CORE_NAME@$VERSION..."
    npm install -g "$CORE_NAME@$VERSION"

    info "Installing $EXTENSION_NAME@$VERSION..."
    npm install -g "$EXTENSION_NAME@$VERSION"
  fi

  info "Packages installed ✓"
}

# ── Configure Pi ─────────────────────────────────────────────────────────────

configure_pi() {
  info "Configuring Pi SDK..."

  # Pi extensions are loaded via `pi install` command or by being in the extension path
  # The extension package has a "pi" field in package.json that tells Pi where to find it

  # Set environment variable hint
  local shell_rc
  if [ -n "${ZSH_VERSION:-}" ]; then
    shell_rc="$HOME/.zshrc"
  elif [ -n "${BASH_VERSION:-}" ]; then
    shell_rc="$HOME/.bashrc"
  else
    shell_rc=""
  fi

  if [ -n "$shell_rc" ] && [ -f "$shell_rc" ]; then
    if ! grep -q "RATEL_SERVICE_PORT" "$shell_rc" 2>/dev/null; then
      info "Adding RATEL_SERVICE_PORT to $shell_rc"
      echo "" >> "$shell_rc"
      echo "# Ratel Factory Service" >> "$shell_rc"
      echo "export RATEL_SERVICE_PORT=$SERVICE_PORT" >> "$shell_rc"
    fi
  fi

  info "Pi SDK configured ✓"
  info ""
  info "To activate the extension, run:"
  info "  pi install $EXTENSION_NAME"
  info ""
}

# ── Start Service ──────────────────────────────────────────────────────────────

start_service() {
  info "Starting Ratel service on port $SERVICE_PORT..."

  # Check if service is already running
  if curl -s "http://localhost:$SERVICE_PORT/health" >/dev/null 2>&1; then
    info "Ratel service already running on port $SERVICE_PORT ✓"
    return
  fi

  # Start service in background
  nohup ratel --serve --port "$SERVICE_PORT" >/dev/null 2>&1 &
  local pid=$!

  # Wait for service to start
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

  # Check service health
  if curl -s "http://localhost:$SERVICE_PORT/health" >/dev/null 2>&1; then
    info "Service health check ✓"
  else
    warn "Service health check failed. The service may still be starting."
  fi

  # Check extension is available
  if [ "$DEV_MODE" = true ]; then
    if [ -d "packages/pi-extension" ]; then
      info "Extension source found ✓"
    fi
  else
    local ext_dir
    ext_dir=$(npm root -g)/"$EXTENSION_NAME"
    if [ -d "$ext_dir" ]; then
      info "Extension package found ✓"
    fi
  fi

  info ""
  info "=== Installation Complete ==="
  info ""
  info "Ratel service: http://localhost:$SERVICE_PORT"
  info "Commands available in Pi:"
  info "  /ratel           — Toggle factory mode"
  info "  /ratel-mission   — Show mission status"
  info "  /ratel-observatory — Open dashboard"
  info ""
  info "Tools available:"
  info "  ratel_start_mission   — Start a new mission"
  info "  ratel_run_worker      — Run a worker"
  info "  ratel_run_validator   — Run validation"
  info ""
  info "To activate the extension:"
  info "  pi install $EXTENSION_NAME"
  info ""
  info "To start the service manually:"
  info "  ratel --serve --port $SERVICE_PORT"
  info ""
  info "For OpenCode users, run: bash install/install-opencode.sh"
  info ""
  info "For direct/headless mode (no Pi extension):"
  info "  npm run dev  # from the ratel repo"
  info ""
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  # Parse arguments
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
        echo "Ratel Pi SDK Installer"
        echo ""
        echo "Usage: bash install-pi.sh [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --dev       Install from local workspace (for development)"
        echo "  --port      Override the Ratel service port (default: 8765)"
        echo "  --help, -h  Show this help"
        echo ""
        echo "Environment variables:"
        echo "  RATEL_VERSION      Package version to install (default: latest)"
        echo "  RATEL_SERVICE_PORT  Service port (default: 8765)"
        echo ""
        exit 0
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
  done

  echo ""
  echo "🚀 Ratel Factory — Pi SDK Installer"
  echo ""

  check_prerequisites
  check_pi_sdk
  install_packages
  configure_pi
  start_service
  verify_installation
}

main "$@"
