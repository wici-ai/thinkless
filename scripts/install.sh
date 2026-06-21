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

ensure_xcode_tools() {
  if xcode-select -p >/dev/null 2>&1; then
    return
  fi
  echo "thinkless install: Apple Command Line Tools are required. Complete the macOS installer; this installer will continue automatically."
  xcode-select --install >/dev/null 2>&1 || true
  local waited=0
  local timeout="${THINKLESS_XCODE_WAIT_SECONDS:-1800}"
  while ! xcode-select -p >/dev/null 2>&1; do
    if [[ "$waited" -ge "$timeout" ]]; then
      echo "thinkless install: timed out waiting for Apple Command Line Tools. Rerun this installer after they finish installing." >&2
      exit 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

npm_global_bin() {
  local prefix
  prefix="$(npm prefix -g 2>/dev/null || true)"
  if [[ -z "$prefix" ]]; then
    return 1
  fi
  printf '%s/bin\n' "$prefix"
}

add_to_current_path() {
  local bin="$1"
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) export PATH="$bin:$PATH" ;;
  esac
}

persist_zsh_path() {
  local bin="$1"
  if [[ "$(uname -s)" != "Darwin" || ! -d "$bin" ]]; then
    return
  fi
  local line="export PATH=\"$bin:\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH\""
  local file
  for file in "$HOME/.zprofile" "$HOME/.zshrc"; do
    if [[ -f "$file" ]] && grep -F "$line" "$file" >/dev/null 2>&1; then
      continue
    fi
    {
      echo ""
      echo "# Added by Thinkless installer"
      echo "$line"
    } >> "$file"
    echo "thinkless install: added $bin to ${file/#$HOME/~} for zsh"
  done
}

verify_thinkless_command() {
  local bin
  if ! bin="$(npm_global_bin)"; then
    echo "thinkless install: could not determine npm global bin directory." >&2
    exit 1
  fi
  add_to_current_path "$bin"
  persist_zsh_path "$bin"
  if [[ "$(uname -s)" == "Darwin" && -x /bin/zsh ]]; then
    if ! env -i HOME="$HOME" USER="${USER:-}" SHELL="/bin/zsh" PATH="/usr/bin:/bin:/usr/sbin:/sbin" /bin/zsh -lc 'command -v thinkless >/dev/null 2>&1 && thinkless --version'; then
      echo "thinkless install: installed, but a clean zsh login shell cannot find thinkless. Open a new terminal or run: export PATH=\"$bin:\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH\"" >&2
      exit 1
    fi
    if ! env -i HOME="$HOME" USER="${USER:-}" SHELL="/bin/zsh" PATH="/usr/bin:/bin:/usr/sbin:/sbin" /bin/zsh -ic 'command -v thinkless >/dev/null 2>&1 && thinkless --version'; then
      echo "thinkless install: installed, but a clean interactive zsh shell cannot find thinkless. Open a new terminal or run: export PATH=\"$bin:\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH\"" >&2
      exit 1
    fi
  elif ! command_exists thinkless; then
    echo "thinkless install: installed, but thinkless is not on PATH. Add $bin to PATH and retry." >&2
    exit 1
  else
    thinkless --version
  fi
}

if [[ "$(uname -s)" == "Darwin" ]]; then
  load_brew
  if ! command_exists brew; then
    echo "thinkless install: installing Homebrew"
    ensure_xcode_tools
    require_sudo_access "install Homebrew and system dependencies"
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    load_brew
  fi
  if ! command_exists npm; then
    ensure_xcode_tools
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
verify_thinkless_command
echo "thinkless install: complete. Run 'thinkless doctor --deep' after Codex, Claude, and GitHub CLI auth are ready."
