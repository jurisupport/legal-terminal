#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[legal-terminal] %s\n' "$1"
}

die() {
  printf '[legal-terminal] ERROR: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 command not found"
}

env_yes_no() {
  local name="$1" default="$2" value
  value="${!name:-}"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"

  case "$value" in
    1|true|yes|y|on) return 0 ;;
    0|false|no|n|off) return 1 ;;
  esac

  [[ "$default" == "yes" ]]
}

ask_yes_no() {
  local question="$1" env_name="$2" answer

  if [[ -n "${!env_name:-}" ]]; then
    env_yes_no "$env_name" yes
    return $?
  fi

  if [[ -r /dev/tty && -w /dev/tty ]]; then
    printf '[legal-terminal] %s [Y/n, Enter=yes] ' "$question" > /dev/tty
    IFS= read -r answer < /dev/tty || answer=""
  else
    return 1
  fi
  case "$answer" in
    [Nn]|[Nn][Oo]) return 1 ;;
    *) return 0 ;;
  esac
}

refresh_path() {
  export PATH="$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
}

ensure_claude() {
  refresh_path
  if command -v claude >/dev/null 2>&1; then
    local claude_version
    claude_version="$(claude --version 2>/dev/null | head -1 || true)"
    log "Claude Code found: $(command -v claude)${claude_version:+ (${claude_version})}"
    if ask_yes_no "Update Claude Code to the latest version?" "LEGAL_TERMINAL_UPDATE_CLAUDE"; then
      log "Updating Claude Code."
      claude update || log "Claude Code update failed; keeping the current version."
      refresh_path
      log "Claude Code version now: $(claude --version 2>/dev/null | head -1 || echo unknown)"
    else
      log "Keeping the current Claude Code version."
    fi
    return
  fi

  if ! ask_yes_no "Claude Code is not installed. Install it first?" "LEGAL_TERMINAL_INSTALL_CLAUDE"; then
    log "Skipping Claude Code install."
    return
  fi

  log "Installing Claude Code."
  curl -fsSL https://claude.ai/install.sh | bash
  refresh_path
}

jurisupport_plugins_installed() {
  [[ -f "$HOME/jurisupport-plugins/install.sh" ]] && return 0
  command -v claude >/dev/null 2>&1 || return 1
  claude plugin list 2>/dev/null | grep -E -q 'jurisupport@jurisupport-plugins|jurisupport-plugins|songmu-legal|korean-law'
}

run_jurisupport_plugins_bootstrap() {
  curl -fsSL https://raw.githubusercontent.com/jurisupport/jurisupport-plugins/main/bootstrap.sh \
    | JURISUPPORT_SKIP_LAWYER_PROFILE=1 JURISUPPORT_SKIP_LEGAL_TERMINAL=1 bash
  refresh_path
}

install_jurisupport_plugins() {
  if jurisupport_plugins_installed; then
    # 설치 여부만 보고 넘어가면 구버전이 계속 남는다 — 최신화 여부를 물어 재실행한다.
    if ask_yes_no "jurisupport-plugins is already installed. Update it to the latest version?" "LEGAL_TERMINAL_UPDATE_JURI_SUPPORT"; then
      log "Updating jurisupport-plugins."
      run_jurisupport_plugins_bootstrap || log "jurisupport-plugins update failed; keeping the current version."
    else
      log "Keeping existing jurisupport-plugins."
    fi
    return
  fi

  if ! ask_yes_no "Install jurisupport-plugins for legal search, skills, and privacy hooks?" "LEGAL_TERMINAL_INSTALL_JURI_SUPPORT"; then
    log "Skipping jurisupport-plugins install."
    return
  fi

  log "Installing jurisupport-plugins."
  run_jurisupport_plugins_bootstrap
}

lawyer_profile_plugin_installed() {
  command -v claude >/dev/null 2>&1 || return 1
  claude plugin list 2>/dev/null | grep -q 'jurisupport-lawyer-profile'
}

run_lawyer_profile_plugin_installer() {
  curl -fsSL https://raw.githubusercontent.com/jurisupport/jurisupport-lawyer-profile-plugin/main/install.sh \
    | JURISUPPORT_LAWYER_PROFILE_SKIP_JURISUPPORT=1 JURISUPPORT_LAWYER_PROFILE_SKIP_LEGAL_TERMINAL=1 JURISUPPORT_CONNECT_MCP=0 bash
  refresh_path
}

install_lawyer_profile_plugin() {
  if lawyer_profile_plugin_installed; then
    if ask_yes_no "JuriSupport lawyer profile plugin is already installed. Update it to the latest version?" "LEGAL_TERMINAL_UPDATE_LAWYER_PROFILE"; then
      log "Updating lawyer strength/profile plugin."
      run_lawyer_profile_plugin_installer || log "Lawyer profile plugin update failed; keeping the current version."
    else
      log "Keeping existing lawyer strength/profile plugin."
    fi
    return
  fi

  if ! ask_yes_no "Install the JuriSupport lawyer strength/profile plugin?" "LEGAL_TERMINAL_INSTALL_LAWYER_PROFILE"; then
    log "Skipping lawyer strength/profile plugin install."
    return
  fi

  log "Installing lawyer strength/profile plugin."
  run_lawyer_profile_plugin_installer
}

case "$(uname -s)" in
  Darwin) ;;
  *) die "This installer is for macOS only." ;;
esac

case "$(uname -m)" in
  arm64) arch="arm64" ;;
  x86_64) arch="x64" ;;
  *) die "Unsupported Mac architecture: $(uname -m)" ;;
esac

require_command curl
require_command unzip
require_command ditto

ensure_claude

version="${LEGAL_TERMINAL_VERSION:-latest}"
asset="legal-terminal-mac-${arch}.zip"

if [[ "$version" == "latest" ]]; then
  release_base="https://github.com/jurisupport/legal-terminal/releases/latest/download"
else
  tag="$version"
  if [[ "$tag" != v* ]]; then
    tag="v${tag}"
  fi
  release_base="https://github.com/jurisupport/legal-terminal/releases/download/${tag}"
fi

download_url="${release_base}/${asset}"
install_dir="${LEGAL_TERMINAL_INSTALL_DIR:-/Applications}"
target_app="${install_dir}/legal-terminal.app"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/legal-terminal.XXXXXX")"

cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

zip_path="${tmpdir}/${asset}"

running_app_pids() {
  pgrep -f "${target_app}/Contents/MacOS/legal-terminal" 2>/dev/null || true
}

quit_running_app() {
  local pids attempt

  pids="$(running_app_pids)"
  if [[ -z "$pids" ]]; then
    return
  fi

  log "Quitting running legal-terminal before replacing the app."
  if command -v osascript >/dev/null 2>&1; then
    osascript -e 'tell application id "kr.lawpid.legalterminal" to quit' >/dev/null 2>&1 \
      || osascript -e 'tell application "legal-terminal" to quit' >/dev/null 2>&1 \
      || true
  fi

  attempt=0
  while [[ "$attempt" -lt 20 ]]; do
    pids="$(running_app_pids)"
    if [[ -z "$pids" ]]; then
      return
    fi
    sleep 0.25
    attempt=$((attempt + 1))
  done

  log "Stopping old legal-terminal process before install."
  printf '%s\n' "$pids" | while IFS= read -r pid; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  sleep 1
}

log "Downloading ${asset}"
log "$download_url"
curl -fL --retry 3 --progress-bar "$download_url" -o "$zip_path"

log "Extracting app"
unzip -q "$zip_path" -d "$tmpdir"

source_app="$(find "$tmpdir" -maxdepth 3 -type d -name 'legal-terminal.app' -print -quit)"
if [[ -z "$source_app" ]]; then
  die "legal-terminal.app not found in downloaded archive"
fi

copy_app() {
  mkdir -p "$install_dir"
  rm -rf "$target_app"
  ditto "$source_app" "$target_app"
}

quit_running_app

log "Installing to ${target_app}"
if ! copy_app 2>/dev/null; then
  log "Permission needed for ${install_dir}; requesting administrator password."
  sudo mkdir -p "$install_dir"
  sudo rm -rf "$target_app"
  sudo ditto "$source_app" "$target_app"
fi

if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$target_app" 2>/dev/null || true
fi

log "Installed."

install_jurisupport_plugins
install_lawyer_profile_plugin

if [[ "${LEGAL_TERMINAL_NO_OPEN:-0}" != "1" ]]; then
  open "$target_app"
fi
