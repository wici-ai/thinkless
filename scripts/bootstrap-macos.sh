#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "thinkless bootstrap: macOS only"
  exit 1
fi

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

prepend_common_paths() {
  export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
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
    echo "thinkless bootstrap: added $bin to ${file/#$HOME/~} for zsh"
  done
}

install_brew_packages() {
  local packages=()
  if ! command_exists git; then
    packages+=(git)
  fi
  if ! command_exists node || ! command_exists npm; then
    packages+=(node)
  fi
  if ! command_exists gh; then
    packages+=(gh)
  fi
  if [[ "${#packages[@]}" -eq 0 ]]; then
    return
  fi
  ensure_xcode_tools
  brew update
  brew install "${packages[@]}"
  prepend_common_paths
}

install_agent_clis() {
  if ! command_exists codex; then
    echo "thinkless bootstrap: installing Codex CLI"
    curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh
    prepend_common_paths
  fi
  if ! command_exists claude; then
    echo "thinkless bootstrap: installing Claude Code CLI"
    curl -fsSL https://claude.ai/install.sh | bash
    prepend_common_paths
  fi
}

verify_required_commands() {
  local bin
  if ! bin="$(npm_global_bin)"; then
    echo "thinkless bootstrap: could not determine npm global bin directory." >&2
    exit 1
  fi
  add_to_current_path "$bin"
  persist_zsh_path "$bin"
  local clean_check='for cmd in thinkless codex claude gh; do command -v "$cmd" >/dev/null 2>&1 || exit 127; done; thinkless --version >/dev/null && codex --version >/dev/null && claude --version >/dev/null && gh --version >/dev/null'
  if [[ -x /bin/zsh ]]; then
    if ! env -i HOME="$HOME" USER="${USER:-}" SHELL="/bin/zsh" PATH="/usr/bin:/bin:/usr/sbin:/sbin" /bin/zsh -lc "$clean_check"; then
      echo "thinkless bootstrap: installed, but a clean zsh login shell cannot find thinkless, codex, claude, and gh. Open a new terminal or run: export PATH=\"$bin:\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH\"" >&2
      exit 1
    fi
    if ! env -i HOME="$HOME" USER="${USER:-}" SHELL="/bin/zsh" PATH="/usr/bin:/bin:/usr/sbin:/sbin" /bin/zsh -ic "$clean_check"; then
      echo "thinkless bootstrap: installed, but a clean interactive zsh shell cannot find thinkless, codex, claude, and gh. Open a new terminal or run: export PATH=\"$bin:\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH\"" >&2
      exit 1
    fi
  else
    local cmd
    for cmd in thinkless codex claude gh; do
      if ! command_exists "$cmd"; then
        echo "thinkless bootstrap: installed, but $cmd is not on PATH. Add $bin, \$HOME/.local/bin, /opt/homebrew/bin, and /usr/local/bin to PATH and retry." >&2
        exit 1
      fi
    done
    thinkless --version >/dev/null
    codex --version >/dev/null
    claude --version >/dev/null
    gh --version >/dev/null
  fi
  echo "thinkless bootstrap: verified thinkless, codex, claude, and gh on PATH"
}

print_path_activation_note() {
  local bin
  bin="$(npm_global_bin 2>/dev/null || true)"
  if [[ -n "$bin" ]]; then
    echo "thinkless bootstrap: PATH updates were written to ~/.zprofile and ~/.zshrc for new zsh sessions."
    echo "thinkless bootstrap: open a new terminal, or update this terminal now with:"
    echo "  export PATH=\"$bin:\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH\""
  fi
}

auth_onboarding_enabled() {
  case "${THINKLESS_AUTH_ONBOARDING:-1}" in
    0|false|FALSE|False|no|NO|No) return 1 ;;
  esac
  if [[ -n "${CI:-}" ]]; then
    return 1
  fi
  [[ -r /dev/tty && -w /dev/tty ]]
}

prompt_yes_no() {
  local prompt="$1"
  local answer
  printf "%s [Y/n] " "$prompt" > /dev/tty
  if ! IFS= read -r answer < /dev/tty 2>/dev/null; then
    echo "thinkless bootstrap: could not read from /dev/tty; auth onboarding requires an interactive terminal." >&2
    return 2
  fi
  case "$answer" in
    ""|y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

run_tty() {
  /bin/bash -lc "$1" < /dev/tty > /dev/tty 2>&1
}

codex_auth_ready() {
  [[ -f "$HOME/.codex/auth.json" || -n "${OPENAI_API_KEY:-}" ]]
}

claude_auth_ready() {
  [[ -f "$HOME/.claude/.credentials.json" || -f "$HOME/.claude.json" || -n "${ANTHROPIC_API_KEY:-}" ]]
}

github_auth_ready() {
  gh auth status >/dev/null 2>&1
}

codex_auth_command() {
  if codex login --help >/dev/null 2>&1; then
    printf '%s\n' 'codex login'
  else
    printf '%s\n' 'codex'
  fi
}

run_auth_onboarding() {
  THINKLESS_AUTH_PENDING=0
  if codex_auth_ready && claude_auth_ready && github_auth_ready; then
    echo "thinkless bootstrap: Codex, Claude, and GitHub CLI auth already look configured"
    return
  fi
  if ! auth_onboarding_enabled; then
    echo "thinkless bootstrap: auth onboarding skipped. To finish setup, run: codex, gh auth login, claude"
    THINKLESS_AUTH_PENDING=1
    return
  fi
  echo "thinkless bootstrap: starting Codex, Claude, and GitHub CLI auth onboarding"
  if ! codex_auth_ready; then
    local codex_cmd
    codex_cmd="$(codex_auth_command)"
    if prompt_yes_no "Sign in to Codex now?"; then
      run_tty "$codex_cmd" || echo "thinkless bootstrap: Codex auth command did not complete successfully; run '$codex_cmd' later." >&2
    fi
  fi
  if ! github_auth_ready; then
    if prompt_yes_no "Sign in to GitHub CLI now?"; then
      run_tty "gh auth login" || echo "thinkless bootstrap: GitHub CLI auth did not complete successfully; run 'gh auth login' later." >&2
    fi
  fi
  if ! claude_auth_ready; then
    echo "thinkless bootstrap: Claude opens an interactive session; exit with /exit or Ctrl-D after login." > /dev/tty
    if prompt_yes_no "Sign in to Claude Code now?"; then
      run_tty "claude" || echo "thinkless bootstrap: Claude auth command did not complete successfully; run 'claude' later." >&2
    fi
  fi
  local pending=()
  codex_auth_ready || pending+=("Codex")
  github_auth_ready || pending+=("GitHub CLI")
  claude_auth_ready || pending+=("Claude")
  if [[ "${#pending[@]}" -gt 0 ]]; then
    THINKLESS_AUTH_PENDING=1
    echo "thinkless bootstrap: auth still pending for: ${pending[*]}. Finish setup with: codex, gh auth login, claude"
  else
    echo "thinkless bootstrap: Codex, Claude, and GitHub CLI auth are ready"
  fi
}

prepend_common_paths
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

install_brew_packages
install_agent_clis

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
npm ci --foreground-scripts --ignore-scripts=false
npm run build
if ! npm link; then
  echo "thinkless bootstrap: npm link failed. Do not rerun npm with sudo; Thinkless install scripts write user config." >&2
  echo "Install Node.js through Homebrew or configure a user-writable npm global prefix, then rerun this script." >&2
  exit 1
fi
verify_required_commands
print_path_activation_note
run_auth_onboarding

if [[ "${THINKLESS_AUTH_PENDING:-0}" == "1" ]]; then
  echo "thinkless bootstrap: installed; auth is pending. Run 'thinkless doctor --deep' after Codex, Claude, and GitHub CLI auth are ready."
else
  echo "thinkless bootstrap: installed. Run 'thinkless doctor --deep' to verify the full setup."
fi
