#!/usr/bin/env bash
set -euo pipefail

release_base="${THINKLESS_RELEASE_BASE:-https://github.com/wici-ai/thinkless/releases/latest/download}"
tarball_url="${THINKLESS_TARBALL_URL:-$release_base/thinkless.tgz}"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

load_brew() {
  if command_exists brew; then
    return
  fi
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

require_sudo_access() {
  local reason="$1"
  if command_exists sudo && sudo -v; then
    return
  fi
  echo "thinkless install: sudo access is required on macOS to ${reason}." >&2
  echo "Run from an admin account, or install dependencies manually and rerun this installer." >&2
  exit 1
}

if [[ "$(uname -s)" == "Darwin" ]]; then
  load_brew
  if ! command_exists brew; then
    echo "thinkless install: installing Homebrew"
    require_sudo_access "install Homebrew and system dependencies"
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    load_brew
  fi
  if ! command_exists npm; then
    brew update
    brew install node git gh
  fi
fi

if ! command_exists npm; then
  echo "thinkless install: npm is required. Install Node.js/npm first, then rerun this installer." >&2
  exit 1
fi

temp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

pkg="$temp_dir/thinkless.tgz"
curl -fsSL "$tarball_url" -o "$pkg"
if ! npm install -g "$pkg"; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "thinkless install: npm global install failed. Do not rerun npm with sudo; Thinkless install scripts write user config." >&2
    echo "Install Node.js through Homebrew or configure a user-writable npm global prefix, then rerun this installer." >&2
  fi
  exit 1
fi
thinkless --version
echo "thinkless install: complete. Run 'thinkless doctor --deep' after Codex, Claude, and GitHub CLI auth are ready."
