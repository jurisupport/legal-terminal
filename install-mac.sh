#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[legal-terminal] %s\n' "$1"
}

die() {
  printf '[legal-terminal] 오류: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 명령을 찾을 수 없습니다"
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
    printf '[legal-terminal] %s [예/Y, 기본: 예] ' "$question" > /dev/tty
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
    log "Claude Code를 찾았습니다: $(command -v claude)${claude_version:+ (${claude_version})}"
    if ask_yes_no "Claude Code를 최신 버전으로 업데이트할까요?" "LEGAL_TERMINAL_UPDATE_CLAUDE"; then
      log "Claude Code를 업데이트합니다."
      claude update || log "Claude Code 업데이트에 실패해 기존 버전을 유지합니다."
      refresh_path
      log "현재 Claude Code 버전: $(claude --version 2>/dev/null | head -1 || echo '확인 불가')"
    else
      log "기존 Claude Code 버전을 유지합니다."
    fi
    return
  fi

  if ! ask_yes_no "Claude Code가 설치되어 있지 않습니다. 먼저 설치할까요?" "LEGAL_TERMINAL_INSTALL_CLAUDE"; then
    log "Claude Code 설치를 건너뜁니다."
    return
  fi

  log "Claude Code를 설치합니다."
  curl -fsSL https://claude.ai/install.sh | bash
  refresh_path
}

jurisupport_plugins_installed() {
  [[ -f "$HOME/jurisupport-plugins/install.sh" ]] && return 0
  command -v claude >/dev/null 2>&1 || return 1
  claude plugin list 2>/dev/null | grep -E -q 'jurisupport@jurisupport-plugins|jurisupport-plugins|songmu-legal|korean-law'
}

run_jurisupport_plugins_bootstrap() {
  curl -fsSL \
    -H 'Accept: application/vnd.github.raw+json' \
    https://api.github.com/repos/jurisupport/jurisupport-plugins/contents/bootstrap.sh \
    | JURISUPPORT_SKIP_LAWYER_PROFILE=1 JURISUPPORT_SKIP_LEGAL_TERMINAL=1 bash
  refresh_path
}

install_jurisupport_plugins() {
  if jurisupport_plugins_installed; then
    # 설치 여부만 보고 넘어가면 구버전이 계속 남는다 — 최신화 여부를 물어 재실행한다.
    if ask_yes_no "jurisupport-plugins가 이미 설치되어 있습니다. 최신 버전으로 업데이트할까요?" "LEGAL_TERMINAL_UPDATE_JURI_SUPPORT"; then
      log "jurisupport-plugins를 업데이트합니다."
      run_jurisupport_plugins_bootstrap || log "jurisupport-plugins 업데이트에 실패해 기존 버전을 유지합니다."
    else
      log "기존 jurisupport-plugins를 유지합니다."
    fi
    return
  fi

  if ! ask_yes_no "법률 검색, 스킬, 개인정보 보호 훅을 위한 jurisupport-plugins를 설치할까요?" "LEGAL_TERMINAL_INSTALL_JURI_SUPPORT"; then
    log "jurisupport-plugins 설치를 건너뜁니다."
    return
  fi

  log "jurisupport-plugins를 설치합니다."
  run_jurisupport_plugins_bootstrap
}

lawyer_profile_plugin_installed() {
  command -v claude >/dev/null 2>&1 || return 1
  claude plugin list 2>/dev/null | grep -q 'jurisupport-lawyer-profile'
}

run_lawyer_profile_plugin_installer() {
  curl -fsSL \
    -H 'Accept: application/vnd.github.raw+json' \
    https://api.github.com/repos/jurisupport/jurisupport-lawyer-profile-plugin/contents/install.sh \
    | JURISUPPORT_LAWYER_PROFILE_SKIP_JURISUPPORT=1 JURISUPPORT_LAWYER_PROFILE_SKIP_LEGAL_TERMINAL=1 JURISUPPORT_CONNECT_MCP=0 bash
  refresh_path
}

install_lawyer_profile_plugin() {
  if lawyer_profile_plugin_installed; then
    if ask_yes_no "JuriSupport 변호사 강점찾기 플러그인이 이미 설치되어 있습니다. 최신 버전으로 업데이트할까요?" "LEGAL_TERMINAL_UPDATE_LAWYER_PROFILE"; then
      log "변호사 강점찾기 플러그인을 업데이트합니다."
      run_lawyer_profile_plugin_installer || log "변호사 강점찾기 플러그인 업데이트에 실패해 기존 버전을 유지합니다."
    else
      log "기존 변호사 강점찾기 플러그인을 유지합니다."
    fi
    return
  fi

  if ! ask_yes_no "JuriSupport 변호사 강점찾기 플러그인을 설치할까요?" "LEGAL_TERMINAL_INSTALL_LAWYER_PROFILE"; then
    log "변호사 강점찾기 플러그인 설치를 건너뜁니다."
    return
  fi

  log "변호사 강점찾기 플러그인을 설치합니다."
  run_lawyer_profile_plugin_installer
}

case "$(uname -s)" in
  Darwin) ;;
  *) die "이 설치 스크립트는 macOS 전용입니다." ;;
esac

case "$(uname -m)" in
  arm64) arch="arm64" ;;
  x86_64) arch="x64" ;;
  *) die "지원하지 않는 Mac 아키텍처입니다: $(uname -m)" ;;
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

  log "앱을 교체하기 전에 실행 중인 legal-terminal을 종료합니다."
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

  log "설치 전에 기존 legal-terminal 프로세스를 종료합니다."
  printf '%s\n' "$pids" | while IFS= read -r pid; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  sleep 1
}

log "${asset} 파일을 내려받습니다."
log "$download_url"
curl -fL --retry 3 --progress-bar "$download_url" -o "$zip_path"

log "앱의 압축을 풉니다."
unzip -q "$zip_path" -d "$tmpdir"

source_app="$(find "$tmpdir" -maxdepth 3 -type d -name 'legal-terminal.app' -print -quit)"
if [[ -z "$source_app" ]]; then
  die "내려받은 압축 파일에서 legal-terminal.app을 찾을 수 없습니다"
fi

copy_app() {
  mkdir -p "$install_dir"
  rm -rf "$target_app"
  ditto "$source_app" "$target_app"
}

quit_running_app

log "${target_app}에 설치합니다."
if ! copy_app 2>/dev/null; then
  log "${install_dir}에 설치할 권한이 필요합니다. 관리자 암호를 요청합니다."
  sudo mkdir -p "$install_dir"
  sudo rm -rf "$target_app"
  sudo ditto "$source_app" "$target_app"
fi

if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$target_app" 2>/dev/null || true
fi

log "설치가 끝났습니다."

install_jurisupport_plugins
install_lawyer_profile_plugin

if [[ "${LEGAL_TERMINAL_NO_OPEN:-0}" != "1" ]]; then
  open "$target_app"
fi
