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

if [[ "${LEGAL_TERMINAL_NO_OPEN:-0}" != "1" ]]; then
  open "$target_app"
fi
