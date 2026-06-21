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

ensure_xcode_tools() {
  if xcode-select -p >/dev/null 2>&1; then
    return
  fi
  echo "thinkless bootstrap: Apple Command Line Tools are required. Complete the macOS installer; this installer will continue automatically."
  xcode-select --install >/dev/null 2>&1 || true
  local waited=0
  local timeout="${THINKLESS_XCODE_WAIT_SECONDS:-1800}"
  while ! xcode-select -p >/dev/null 2>&1; do
    if [[ "$waited" -ge "$timeout" ]]; then
      echo "thinkless bootstrap: timed out waiting for Apple Command Line Tools. Rerun this script after they finish installing." >&2
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
  if [[ ! -d "$bin" ]]; then
    return
  fi
  local zprofile="$HOME/.zprofile"
  local line="export PATH=\"$bin:\$PATH\""
  if [[ -f "$zprofile" ]] && grep -F "$line" "$zprofile" >/dev/null 2>&1; then
    return
  fi
  {
    echo ""
    echo "# Added by Thinkless installer"
    echo "$line"
  } >> "$zprofile"
  echo "thinkless bootstrap: added $bin to ~/.zprofile for zsh"
}

verify_thinkless_command() {
  local bin
  if ! bin="$(npm_global_bin)"; then
    echo "thinkless bootstrap: could not determine npm global bin directory." >&2
    exit 1
  fi
  add_to_current_path "$bin"
  persist_zsh_path "$bin"
  if [[ -x /bin/zsh ]]; then
    if ! /bin/zsh -lc 'command -v thinkless >/dev/null 2>&1 && thinkless --version'; then
      echo "thinkless bootstrap: installed, but zsh cannot find thinkless. Open a new terminal or run: export PATH=\"$bin:\$PATH\"" >&2
      exit 1
    fi
  elif ! command_exists thinkless; then
    echo "thinkless bootstrap: installed, but thinkless is not on PATH. Add $bin to PATH and retry." >&2
    exit 1
  else
    thinkless --version
  fi
}

ensure_xcode_tools

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

repo_url="${THINKLESS_REPO_URL:-git@github.com:wici-ai/thinkless.git}"
repo_dir="${THINKLESS_DIR:-$HOME/thinkless}"
repo_ref="${THINKLESS_REF:-main}"

if [[ -f package.json && -f scripts/postinstall.mjs ]]; then
  target_dir="$PWD"
else
  if [[ ! -d "$repo_dir/.git" ]]; then
    git clone --branch "$repo_ref" "$repo_url" "$repo_dir"
  else
    git -C "$repo_dir" fetch origin "$repo_ref"
    git -C "$repo_dir" checkout "$repo_ref"
    git -C "$repo_dir" pull --ff-only origin "$repo_ref"
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
verify_thinkless_command

echo "thinkless bootstrap: installed. Run 'thinkless doctor --deep' after Codex and Claude are authenticated."
