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

if [[ "$(uname -s)" == "Darwin" ]]; then
  load_brew
  if ! command_exists brew; then
    echo "thinkless install: installing Homebrew"
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
npm install -g "$pkg"
thinkless --version
echo "thinkless install: complete. Run 'thinkless doctor --deep' after Codex, Claude, and GitHub CLI auth are ready."
