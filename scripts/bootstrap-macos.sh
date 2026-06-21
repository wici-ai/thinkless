#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "thinkless bootstrap: macOS only"
  exit 1
fi

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
  echo "thinkless bootstrap: sudo access is required on macOS to ${reason}." >&2
  echo "Run from an admin account, or install dependencies manually and rerun this script." >&2
  exit 1
}

if ! xcode-select -p >/dev/null 2>&1; then
  echo "thinkless bootstrap: installing Apple Command Line Tools"
  xcode-select --install
  echo "Finish the Apple installer, then rerun this script."
  exit 1
fi

load_brew
if ! command_exists brew; then
  echo "thinkless bootstrap: installing Homebrew"
  require_sudo_access "install Homebrew and system dependencies"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_brew
fi

if ! command_exists brew; then
  echo "thinkless bootstrap: Homebrew installed, but brew is not on PATH. Open a new terminal and rerun this script."
  exit 1
fi

brew update
brew install git node gh

repo_url="${THINKLESS_REPO_URL:-git@github.com:wici-ai/thinkless-dev.git}"
repo_dir="${THINKLESS_DIR:-$HOME/thinkless}"

if [[ -f package.json && -f scripts/postinstall.mjs ]]; then
  target_dir="$PWD"
else
  if [[ ! -d "$repo_dir/.git" ]]; then
    git clone "$repo_url" "$repo_dir"
  fi
  target_dir="$repo_dir"
fi

cd "$target_dir"
npm ci
npm run build
if ! npm link; then
  echo "thinkless bootstrap: npm link failed. Do not rerun npm with sudo; Thinkless install scripts write user config." >&2
  echo "Install Node.js through Homebrew or configure a user-writable npm global prefix, then rerun this script." >&2
  exit 1
fi

echo "thinkless bootstrap: installed. Run 'thinkless doctor --deep' after Codex and Claude are authenticated."
