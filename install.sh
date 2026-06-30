#!/usr/bin/env bash
set -euo pipefail

release_repo="${THINKLESS_RELEASE_REPO:-wici-ai/thinkless}"

resolve_release_base() {
  if [[ -n "${THINKLESS_RELEASE_BASE:-}" ]]; then
    printf '%s\n' "$THINKLESS_RELEASE_BASE"
    return
  fi
  local tag
  tag="$(
    curl -fsSL "https://api.github.com/repos/$release_repo/releases/latest" 2>/dev/null \
      | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' \
      | head -n 1
  )"
  if [[ -n "$tag" ]]; then
    printf 'https://github.com/%s/releases/download/%s\n' "$release_repo" "$tag"
    return
  fi
  printf 'https://github.com/%s/releases/latest/download\n' "$release_repo"
}

release_base="$(resolve_release_base)"
tarball_url="${THINKLESS_TARBALL_URL:-$release_base/thinkless.tgz}"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

path_prepend_once() {
  local dir
  for dir in "$@"; do
    if [[ -z "$dir" || ! -d "$dir" ]]; then
      continue
    fi
    case ":$PATH:" in
      *":$dir:"*) ;;
      *) PATH="$dir:$PATH" ;;
    esac
  done
  export PATH
}

prepend_common_paths() {
  path_prepend_once \
    "$HOME/.local/bin" \
    "$HOME/.codex/bin" \
    "$HOME/.claude/local" \
    "$HOME/.claude/bin" \
    "$HOME/.volta/bin" \
    "/opt/homebrew/bin" \
    "/usr/local/bin"
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

command_dir() {
  local resolved
  resolved="$(command -v "$1" 2>/dev/null || true)"
  if [[ -n "$resolved" && "$resolved" == */* ]]; then
    printf '%s\n' "${resolved%/*}"
  fi
}

activation_path_dirs() {
  local npm_bin
  npm_bin="$(npm_global_bin 2>/dev/null || true)"
  {
    printf '%s\n' "$npm_bin"
    command_dir node
    command_dir npm
    command_dir thinkless
    command_dir codex
    command_dir claude
    command_dir gh
    command_dir git
    command_dir brew
    printf '%s\n' "$HOME/.local/bin"
    printf '%s\n' "$HOME/.codex/bin"
    printf '%s\n' "$HOME/.claude/local"
    printf '%s\n' "$HOME/.claude/bin"
    printf '%s\n' "$HOME/.volta/bin"
    printf '%s\n' "/opt/homebrew/bin"
    printf '%s\n' "/usr/local/bin"
  } | awk 'NF && !seen[$0]++'
}

join_path_dirs() {
  local joined=""
  local dir
  for dir in "$@"; do
    if [[ -z "$joined" ]]; then
      joined="$dir"
    else
      joined="$joined:$dir"
    fi
  done
  printf '%s' "$joined"
}

escape_double_quoted() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\\$}"
  value="${value//\`/\\\`}"
  printf '%s' "$value"
}

npm_global_root() {
  local root
  root="$(npm root -g 2>/dev/null || true)"
  if [[ -z "$root" ]]; then
    return 1
  fi
  printf '%s\n' "$root"
}

persist_zsh_path() {
  if [[ "$(uname -s)" != "Darwin" || "$#" -eq 0 ]]; then
    return
  fi
  local path_prefix
  path_prefix="$(join_path_dirs "$@")"
  if [[ -z "$path_prefix" ]]; then
    return
  fi
  local escaped
  escaped="$(escape_double_quoted "$path_prefix")"
  local line="export PATH=\"$escaped:\$PATH\""
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
    echo "thinkless install: added command paths to ${file/#$HOME/~} for zsh"
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
    echo "thinkless install: installing Codex CLI"
    curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh
    prepend_common_paths
  fi
  if ! command_exists claude; then
    echo "thinkless install: installing Claude Code CLI"
    curl -fsSL https://claude.ai/install.sh | bash
    prepend_common_paths
  fi
}

verify_required_commands() {
  local npm_bin
  if ! npm_bin="$(npm_global_bin)"; then
    echo "thinkless install: could not determine npm global bin directory." >&2
    exit 1
  fi
  prepend_common_paths
  path_prepend_once "$npm_bin"
  local path_dirs=()
  local dir
  while IFS= read -r dir; do
    if [[ -d "$dir" ]]; then
      path_dirs+=("$dir")
    fi
  done < <(activation_path_dirs)
  path_prepend_once "${path_dirs[@]}"
  persist_zsh_path "${path_dirs[@]}"
  local path_export
  path_export="$(escape_double_quoted "$(join_path_dirs "${path_dirs[@]}")")"
  local clean_check="export THINKLESS_SELF_UPDATE=0; export PATH=\"$path_export:\$PATH\"; for cmd in node npm thinkless codex claude gh; do command -v \"\$cmd\" >/dev/null 2>&1 || exit 127; done; thinkless --version >/dev/null && codex --version >/dev/null && claude --version >/dev/null && gh --version >/dev/null"
  if [[ "$(uname -s)" == "Darwin" && -x /bin/zsh ]]; then
    if ! env -i HOME="$HOME" USER="${USER:-}" SHELL="/bin/zsh" PATH="/usr/bin:/bin:/usr/sbin:/sbin" /bin/zsh -lc "$clean_check"; then
      echo "thinkless install: installed, but a clean zsh login shell cannot find node, npm, thinkless, codex, claude, and gh. Open a new terminal or run: export PATH=\"$(join_path_dirs "${path_dirs[@]}"):\$PATH\"" >&2
      exit 1
    fi
    if ! env -i HOME="$HOME" USER="${USER:-}" SHELL="/bin/zsh" PATH="/usr/bin:/bin:/usr/sbin:/sbin" /bin/zsh -ic "$clean_check"; then
      echo "thinkless install: installed, but a clean interactive zsh shell cannot find node, npm, thinkless, codex, claude, and gh. Open a new terminal or run: export PATH=\"$(join_path_dirs "${path_dirs[@]}"):\$PATH\"" >&2
      exit 1
    fi
  else
    local cmd
    for cmd in node npm thinkless codex claude gh; do
      if ! command_exists "$cmd"; then
        echo "thinkless install: installed, but $cmd is not on PATH. Add $(join_path_dirs "${path_dirs[@]}") to PATH and retry." >&2
        exit 1
      fi
    done
    THINKLESS_SELF_UPDATE=0 thinkless --version >/dev/null
    codex --version >/dev/null
    claude --version >/dev/null
    gh --version >/dev/null
  fi
  echo "thinkless install: verified node, npm, thinkless, codex, claude, and gh on PATH"
}

install_thinkless_launcher() {
  local bin root cli launcher temp quoted_cli
  if ! bin="$(npm_global_bin)" || ! root="$(npm_global_root)"; then
    echo "thinkless install: could not determine npm global install paths." >&2
    exit 1
  fi
  cli="$root/thinkless/dist/src/cli.js"
  launcher="$bin/thinkless"
  if [[ ! -f "$cli" ]]; then
    echo "thinkless install: installed Thinkless CLI was not found at $cli." >&2
    exit 1
  fi
  mkdir -p "$bin"
  printf -v quoted_cli '%q' "$cli"
  temp="$launcher.tmp.$$"
  rm -f "$launcher"
  cat > "$temp" <<EOF
#!/usr/bin/env bash
set -e
THINKLESS_CLI=$quoted_cli
thinkless_default_target() {
  local repo
  repo="\$(git -C "\$PWD" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "\$repo" ]]; then
    printf '%s\n' "\$repo"
    return
  fi
  printf '%s\n' "\$PWD"
}

thinkless_next_session_dir() {
  local target index candidate
  target="\$1"
  mkdir -p "\$target"
  index=1
  while [[ "\$index" -lt 10000 ]]; do
    candidate="\$target/.thinkless\${index}"
    if mkdir "\$candidate" 2>/dev/null; then
      printf '%s\n' "\$candidate"
      return
    fi
    index="\$((index + 1))"
  done
  echo "thinkless: could not allocate a session directory under \$target" >&2
  exit 1
}

if [[ "\$#" -eq 0 ]]; then
  target="\$(thinkless_default_target)"
  session_dir="\$(thinkless_next_session_dir "\$target")"
  THINKLESS_SESSION_DIR="\$session_dir" exec node "\$THINKLESS_CLI" tui --target "\$target"
fi
exec node "\$THINKLESS_CLI" "\$@"
EOF
  chmod +x "$temp"
  mv "$temp" "$launcher"
}

print_path_activation_note() {
  local path_dirs=()
  local dir
  while IFS= read -r dir; do
    if [[ -d "$dir" ]]; then
      path_dirs+=("$dir")
    fi
  done < <(activation_path_dirs)
  local path_prefix
  path_prefix="$(join_path_dirs "${path_dirs[@]}")"
  if [[ "$(uname -s)" == "Darwin" && -n "$path_prefix" ]]; then
    echo "thinkless install: PATH updates were written to ~/.zprofile and ~/.zshrc for new zsh sessions."
    echo "thinkless install: open a new terminal, or update this terminal now with:"
    echo "  export PATH=\"$path_prefix:\$PATH\""
    echo "thinkless install: to launch Thinkless in this terminal now, run:"
    echo "  export PATH=\"$path_prefix:\$PATH\" && thinkless"
  fi
}

auth_onboarding_enabled() {
  case "${THINKLESS_AUTH_ONBOARDING:-1}" in
    0|false|FALSE|False|no|NO|No) return 1 ;;
  esac
  if [[ -n "${CI:-}" ]]; then
    return 1
  fi
  [[ -r /dev/tty && -w /dev/tty ]] || return 1
  true 2>/dev/null < /dev/tty > /dev/tty
}

prompt_yes_no() {
  local prompt="$1"
  local answer
  if ! printf "%s [Y/n] " "$prompt" 2>/dev/null > /dev/tty; then
    echo "thinkless install: could not write to /dev/tty; auth onboarding requires an interactive terminal." >&2
    return 2
  fi
  if ! IFS= read -r answer 2>/dev/null < /dev/tty; then
    echo "thinkless install: could not read from /dev/tty; auth onboarding requires an interactive terminal." >&2
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
  local codex_cmd
  codex_cmd="$(codex_auth_command)"
  echo "thinkless install: auth onboarding status"
  if codex_auth_ready; then
    echo "thinkless install: Codex auth file/env detected. Reauthenticate or switch accounts with: $codex_cmd"
  else
    echo "thinkless install: Codex auth is not configured; setup command: $codex_cmd"
  fi
  if github_auth_ready; then
    echo "thinkless install: GitHub CLI auth detected. Reauthenticate or switch accounts with: gh auth login"
  else
    echo "thinkless install: GitHub CLI auth is not configured; setup command: gh auth login"
  fi
  if claude_auth_ready; then
    echo "thinkless install: Claude auth file/env detected. Reauthenticate or switch accounts with: claude"
  else
    echo "thinkless install: Claude auth is not configured; setup command: claude"
  fi
  if codex_auth_ready && claude_auth_ready && github_auth_ready; then
    echo "thinkless install: Codex, Claude, and GitHub CLI auth already look configured"
    return
  fi
  if ! auth_onboarding_enabled; then
    echo "thinkless install: auth onboarding skipped. To finish setup, run: codex, gh auth login, claude"
    THINKLESS_AUTH_PENDING=1
    return
  fi
  echo "thinkless install: starting Codex, Claude, and GitHub CLI auth onboarding"
  if ! codex_auth_ready; then
    if prompt_yes_no "Sign in to Codex now?"; then
      run_tty "$codex_cmd" || echo "thinkless install: Codex auth command did not complete successfully; run '$codex_cmd' later." >&2
    fi
  fi
  if ! github_auth_ready; then
    if prompt_yes_no "Sign in to GitHub CLI now?"; then
      run_tty "gh auth login" || echo "thinkless install: GitHub CLI auth did not complete successfully; run 'gh auth login' later." >&2
    fi
  fi
  if ! claude_auth_ready; then
    echo "thinkless install: Claude opens an interactive session; exit with /exit or Ctrl-D after login." > /dev/tty
    if prompt_yes_no "Sign in to Claude Code now?"; then
      run_tty "claude" || echo "thinkless install: Claude auth command did not complete successfully; run 'claude' later." >&2
    fi
  fi
  local pending=()
  codex_auth_ready || pending+=("Codex")
  github_auth_ready || pending+=("GitHub CLI")
  claude_auth_ready || pending+=("Claude")
  if [[ "${#pending[@]}" -gt 0 ]]; then
    THINKLESS_AUTH_PENDING=1
    echo "thinkless install: auth still pending for: ${pending[*]}. Finish setup with: codex, gh auth login, claude"
  else
    echo "thinkless install: Codex, Claude, and GitHub CLI auth are ready"
  fi
}

prepend_common_paths
if [[ "$(uname -s)" == "Darwin" ]]; then
  load_brew
  if ! command_exists brew; then
    echo "thinkless install: installing Homebrew"
    ensure_xcode_tools
    require_sudo_access "install Homebrew and system dependencies"
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    load_brew
  fi
  if ! command_exists brew; then
    echo "thinkless install: Homebrew installed, but brew is not on PATH. Open a new terminal and rerun this installer."
    exit 1
  fi
  install_brew_packages
  install_agent_clis
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
if ! npm install -g --foreground-scripts --ignore-scripts=false "$pkg"; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "thinkless install: npm global install failed. Do not rerun npm with sudo; Thinkless install scripts write user config." >&2
    echo "Install Node.js through Homebrew or configure a user-writable npm global prefix, then rerun this installer." >&2
  fi
  exit 1
fi
install_thinkless_launcher
verify_required_commands
print_path_activation_note
run_auth_onboarding
if [[ "${THINKLESS_AUTH_PENDING:-0}" == "1" ]]; then
  echo "thinkless install: installed; auth is pending. Finish Codex, Claude, and GitHub CLI auth, then run 'thinkless'."
else
  echo "thinkless install: complete. Run 'thinkless' to start."
fi
