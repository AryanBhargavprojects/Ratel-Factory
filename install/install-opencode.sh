#!/usr/bin/env bash
#
# Ratel OpenCode Installer
#
# Installs the Ratel factory for OpenCode. This is a single-agent installer:
# it does NOT detect or install other agents. Use install-pi.sh for Pi SDK.
#
# Usage:
#   curl -fsSL https://ratel.dev/install-opencode.sh | bash
#   # or locally:
#   bash install/install-opencode.sh
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
PLUGIN_NAME="@ratel/opencode"
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
n  exit 1
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

# ── OpenCode Detection ───────────────────────────────────────────────────────

check_opencode() {
  info "Checking OpenCode..."

  if ! command -v opencode >/dev/null 2>&1; then
    warn "OpenCode CLI not found in PATH."
    warn "Install it from https://opencode.ai/ first, then re-run this script."
    die "OpenCode is required for the Ratel plugin."
  fi

  info "OpenCode $(opencode --version 2>/dev/null || echo 'unknown') ✓"

  # Check OpenCode config directory
  local config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
  if [ ! -d "$config_dir" ]; then
    info "Creating OpenCode config directory: $config_dir"
    mkdir -p "$config_dir"
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
    npm install -g "./packages/opencode-plugin"
  else
    info "Installing $CORE_NAME@$VERSION..."
    npm install -g "$CORE_NAME@$VERSION"

    info "Installing $PLUGIN_NAME@$VERSION..."
    npm install -g "$PLUGIN_NAME@$VERSION"
  fi

  info "Packages installed ✓"
}

# ── Configure OpenCode ───────────────────────────────────────────────────────

configure_opencode() {
  info "Configuring OpenCode..."

  local commands_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/commands"
  mkdir -p "$commands_dir"

  # Install command stubs
  if [ "$DEV_MODE" = true ]; then
    if [ -d "packages/opencode-plugin/commands" ]; then
      cp packages/opencode-plugin/commands/*.md "$commands_dir/" 2>/dev/null || true
    fi
  else
    # For npm-installed package, find the commands directory
    local plugin_dir
    plugin_dir=$(npm root -g)/"$PLUGIN_NAME"
    if [ -d "$plugin_dir/commands" ]; then
      cp "$plugin_dir/commands/"*.md "$commands_dir/" 2>/dev/null || true
    fi
  fi

  info "Command stubs installed ✓"

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

  # Check plugin is available
  if [ "$DEV_MODE" = true ]; then
    if [ -d "packages/opencode-plugin" ]; then
      info "Plugin source found ✓"
    fi
  else
    local plugin_dir
    plugin_dir=$(npm root -g)/"$PLUGIN_NAME"
    if [ -d "$plugin_dir" ]; then
      info "Plugin package found ✓"
    fi
  fi

  info ""
  info "=== Installation Complete ==="
  info ""
  info "Ratel service: http://localhost:$SERVICE_PORT"
  info "Commands available in OpenCode:"
  info "  /ratel           — Toggle factory mode"
  info "  /ratel-mission   — Show mission status"
  info "  /ratel-observatory — Open dashboard"
  info ""
  info "Tools available:"
  info "  ratel_start_mission — Start a new mission"
  info "  ratel_get_status    — Get mission status"
  info "  ratel_run_worker    — Run a worker"
  info "  ratel_run_validation — Run validation"
  info ""
  info "To start the service manually:"
  info "  ratel --serve --port $SERVICE_PORT"
  info ""
  info "For Pi SDK users, run: bash install/install-pi.sh"
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
        echo "Ratel OpenCode Installer"
        echo ""
        echo "Usage: bash install-opencode.sh [OPTIONS]"
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
  echo "🚀 Ratel Factory — OpenCode Installer"
  echo ""

  check_prerequisites
  check_opencode
  install_packages
  configure_opencode
  start_service
  verify_installation
}

main "$@"
