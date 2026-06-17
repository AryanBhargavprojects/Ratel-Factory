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
#   --help     Show this help

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────

VERSION="${RATEL_VERSION:-latest}"
DEV_MODE=false
PLUGIN_NAME="@ratel-factory/opencode"
CORE_NAME="@ratel-factory/core"

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

# ── npm global bin resolution ───────────────────────────────────────────────

get_npm_global_bin() {
  # Primary: npm prefix -g (works in all npm versions)
  local prefix
  if prefix=$(npm prefix -g 2>/dev/null) && [ -n "$prefix" ]; then
    echo "$prefix/bin"
    return 0
  fi

  # Fallback: npm bin -g (deprecated in npm 9, removed in 10)
  local bin_dir
  if bin_dir=$(npm bin -g 2>/dev/null) && [ -n "$bin_dir" ]; then
    echo "$bin_dir"
    return 0
  fi

  # Last resort: dirname of npm command itself
  if command -v npm >/dev/null 2>&1; then
    dirname "$(command -v npm)"
    return 0
  fi

  return 1
}

# ── Stale Ratel service cleanup ──────────────────────────────────────────────

# Kill any running Ratel service processes owned by the current user and remove
# stale .ratel/service.json metadata files under $HOME. This prevents an old
# service from continuing to serve outdated state after a reinstall.
cleanup_stale_services() {
  # Match command lines containing --serve plus a known Ratel core path, or the
  # plain `ratel --serve` command. Avoid killing unrelated node/opencode processes.
  local pids current_user
  current_user="${USER:-$(id -un 2>/dev/null || true)}"
  pids=$(
    ps -eo user,pid,args 2>/dev/null \
      | awk -v u="$current_user" '$1 == u {
          line = $0
          sub(/^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]*/, "", line)
          print $2 "\t" line
        }' \
      | awk -F'\t' '{
          if ($2 !~ /^opencode[[:space:]]/ && $2 !~ /^npm[[:space:]]/ && $2 ~ /--serve/) {
            if ($2 ~ /@ratel\/core/ || $2 ~ /@ratel-factory\/core/ || $2 ~ /\/ratel\/core\// || $2 ~ /\/ratel-factory\/core\// || $2 ~ /(^|[[:space:]\/])ratel --serve/) {
              print $1
            }
          }
        }'
  ) || true

  if [ -n "$pids" ]; then
    local pid
    for pid in $pids; do
      if kill "$pid" 2>/dev/null; then
        info "Killed stale Ratel service process $pid ✓"
      else
        warn "Could not kill stale Ratel service process $pid (non-fatal)"
      fi
    done
  fi

  # Remove stale service.json metadata under $HOME without touching missions or
  # other .ratel data. Bounded depth keeps the search predictable.
  if [ -n "${HOME:-}" ] && [ -d "$HOME" ]; then
    local stale_meta
    stale_meta=$(find "$HOME" -maxdepth 8 -type f -path '*/.ratel/service.json' 2>/dev/null) || true
    if [ -n "$stale_meta" ]; then
      local f
      while IFS= read -r f; do
        if rm -f "$f" 2>/dev/null; then
          info "Removed stale service metadata: $f ✓"
        else
          warn "Failed to remove stale service metadata: $f (non-fatal)"
        fi
      done <<< "$stale_meta"
    fi
  fi
}

# ── Pre-Install Cleanup ──────────────────────────────────────────────────────

preinstall_cleanup() {
  info "Pre-install cleanup..."

  cleanup_stale_services

  # Step 1: Uninstall known legacy and current global packages non-fatally.
  # This removes npm's package registry so install won't trip over itself.
  for pkg in "@ratel/core" "@ratel/opencode" "@ratel-factory/core" "@ratel-factory/opencode"; do
    if npm list -g "$pkg" --depth=0 >/dev/null 2>&1; then
      warn "Found existing package $pkg — removing..."
      if npm uninstall -g "$pkg" 2>/dev/null; then
        info "Removed $pkg ✓"
      else
        warn "Failed to uninstall $pkg (non-fatal)"
      fi
    fi
  done

  # Step 2: Handle stale ratel binary that survived npm uninstall.
  # npm uninstall can leave binaries behind if the package was removed
  # externally or the binary was manually placed.
  if command -v ratel >/dev/null 2>&1; then
    local ratel_path
    ratel_path=$(command -v ratel)
    warn "Found existing ratel binary at: $ratel_path"

    # Resolve npm global bin directory
    local npm_bin
    if ! npm_bin=$(get_npm_global_bin); then
      die "Cannot determine npm global bin directory. Please remove $ratel_path manually."
    fi

    # Resolve both paths to their real locations (follow symlinks for dirs)
    local ratel_dir npm_bin_real
    ratel_dir=$(cd "$(dirname "$ratel_path")" 2>/dev/null && pwd -P 2>/dev/null || pwd)
    npm_bin_real=$(cd "$npm_bin" 2>/dev/null && pwd -P 2>/dev/null || echo "$npm_bin")

    if [ "$ratel_dir" != "$npm_bin_real" ]; then
      die "Existing ratel binary at $ratel_path is outside npm global bin ($npm_bin_real).\n       Please remove or rename it manually before re-running this script."
    fi

    # It's inside npm global bin — determine if we can safely remove it.
    local safe_to_remove=false

    if [ -L "$ratel_path" ]; then
      # Symlinks are always safe to remove (npm creates these)
      safe_to_remove=true
      info "Existing ratel is a symlink — safe to remove"
    elif [ -f "$ratel_path" ]; then
      # Check if it's a known Ratel shim by grepping for distinctive patterns
      if grep -qE '@ratel/core|@ratel-factory/core|@ratel/opencode|@ratel-factory/opencode|dist/index\.js' "$ratel_path" 2>/dev/null; then
        safe_to_remove=true
        info "Existing ratel appears to be a Ratel shim — safe to remove"
      else
        die "Existing ratel binary at $ratel_path is not recognized as a Ratel shim.\n       Please remove or rename it manually before re-running this script."
      fi
    fi

    if [ "$safe_to_remove" = true ]; then
      rm -f "$ratel_path"
      info "Removed stale ratel binary ✓"
    fi
  fi

  info "Pre-install cleanup complete ✓"
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

  # Install Ratel factory skill for OpenCode
  local skills_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/ratel-factory"
  mkdir -p "$skills_dir"

  if [ "$DEV_MODE" = true ]; then
    if [ -f "skills/ratel-factory/SKILL.md" ]; then
      cp "skills/ratel-factory/SKILL.md" "$skills_dir/SKILL.md"
      info "Skill installed from local repo ✓"
    else
      warn "Skill SKILL.md not found at skills/ratel-factory/SKILL.md"
    fi
  else
    local plugin_dir
    plugin_dir=$(npm root -g)/"$PLUGIN_NAME"
    if [ -f "$plugin_dir/skills/ratel-factory/SKILL.md" ]; then
      cp "$plugin_dir/skills/ratel-factory/SKILL.md" "$skills_dir/SKILL.md"
      info "Skill installed from npm package ✓"
    else
      warn "Skill SKILL.md not found at $plugin_dir/skills/ratel-factory/SKILL.md"
    fi
  fi

}

# ── Patch OpenCode Config ────────────────────────────────────────────────────

patch_opencode_config() {
  info "Patching OpenCode config..."

  local config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
  local config_file="$config_dir/opencode.json"

  # Determine the plugin file path
  local plugin_path
  if [ "$DEV_MODE" = true ]; then
    plugin_path="$(pwd)/packages/opencode-plugin/dist/plugin.js"
    if [ ! -f "$plugin_path" ]; then
      warn "Plugin file not found at $plugin_path — skipping config patch"
      return
    fi
  else
    plugin_path="$(npm root -g)/$PLUGIN_NAME/dist/plugin.js"
    if [ ! -f "$plugin_path" ]; then
      # Try without .js extension (some builds may use different naming)
      local alt_plugin
      alt_plugin="$(npm root -g)/$PLUGIN_NAME/dist/plugin.mjs"
      if [ -f "$alt_plugin" ]; then
        plugin_path="$alt_plugin"
      else
        warn "Plugin file not found at $plugin_path — skipping config patch"
        return
      fi
    fi
  fi

  # Use Node.js for robust JSON manipulation
  node --input-type=module - "$config_file" "$plugin_path" <<'NODESCRIPT'
    import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
    import { dirname } from 'node:path';
    import { pathToFileURL } from 'node:url';

    const configPath = process.argv[2];
    const pluginPath = process.argv[3];

    // Read existing config or start fresh
    let config = {};
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8').trim();
        if (raw) {
          config = JSON.parse(raw);
        }
      } catch {
        console.warn('[ratel] WARNING: Could not parse existing config — creating new one');
        config = {};
      }
    }

    // Ensure $schema
    if (!config.$schema) {
      config.$schema = 'https://opencode.ai/config.json';
    }

    // Ensure plugin array
    if (!Array.isArray(config.plugin)) {
      config.plugin = [];
    }

    // Remove stale Ratel plugin entries (old @ratel/opencode or current @ratel-factory/opencode)
    const beforeCount = config.plugin.length;
    config.plugin = config.plugin.filter(entry => {
      if (typeof entry !== 'string') return true;
      return !entry.includes('@ratel/opencode') && !entry.includes('@ratel-factory/opencode');
    });
    const removedCount = beforeCount - config.plugin.length;

    // Convert plugin path to a file:// URL
    const pluginUrl = pathToFileURL(pluginPath).href;

    // Add the current plugin entry
    config.plugin.push(pluginUrl);

    // Ensure parent directory exists
    mkdirSync(dirname(configPath), { recursive: true });

    // Write pretty-printed JSON
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    if (removedCount > 0) {
      console.log(`[ratel] Removed ${removedCount} stale plugin entr${removedCount === 1 ? 'y' : 'ies'}`);
    }
    console.log(`[ratel] Plugin entry added: ${pluginUrl}`);
NODESCRIPT

  info "OpenCode config patched ✓"
}

# ── Post-Install Legacy Cleanup ──────────────────────────────────────────────

# Only cleans legacy package names (@ratel/core, @ratel/opencode) that predate
# the @ratel-factory scope. Does NOT touch @ratel-factory/* packages so the
# just-installed packages are never uninstalled.
cleanup_legacy() {
  info "Checking for legacy packages..."

  local cleaned=0
  for pkg in "@ratel/core" "@ratel/opencode"; do
    if npm list -g "$pkg" --depth=0 >/dev/null 2>&1; then
      warn "Found legacy package $pkg — removing..."
      if npm uninstall -g "$pkg" 2>/dev/null; then
        info "Removed legacy package $pkg ✓"
        cleaned=$((cleaned + 1))
      else
        warn "Failed to uninstall $pkg (non-fatal)"
      fi
    fi
  done

  if [ "$cleaned" -gt 0 ]; then
    info "Post-install legacy cleanup complete ($cleaned package(s) removed)"
  else
    info "No legacy packages found ✓"
  fi
}

# ── Verify ────────────────────────────────────────────────────────────────────

verify_installation() {
  info "Verifying installation..."

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

  # Check ratel binary is on PATH
  if command -v ratel >/dev/null 2>&1; then
    info "Ratel binary found on PATH ✓"
  else
    warn "Ratel binary not found on PATH. Make sure $CORE_NAME is installed globally."
  fi

  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║           Ratel Factory — Installation Complete             ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "  Next step: Open OpenCode and run /ratel"
  echo ""
  echo "  In OpenCode, you can use:"
  echo "    /ratel              — Ping factory health & agent status"
  echo "    /ratel-mission      — Show current mission status"
  echo "    /ratel-observatory  — Open the Observatory dashboard"
  echo ""
  echo "  The Ratel plugin auto-discovers or auto-starts the service"
  echo "  when you open a project. No manual setup needed."
  echo ""
  echo "  To start the service manually:"
  echo "    ratel --serve"
  echo ""
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
      --help|-h)
        echo "Ratel OpenCode Installer"
        echo ""
        echo "Usage: bash install-opencode.sh [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --dev       Install from local workspace (for development)"
        echo "  --help, -h  Show this help"
        echo ""
        echo "Environment variables:"
        echo "  RATEL_VERSION  Package version to install (default: latest)"
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
  preinstall_cleanup
  install_packages
  configure_opencode
  patch_opencode_config
  cleanup_legacy
  verify_installation
}

main "$@"
