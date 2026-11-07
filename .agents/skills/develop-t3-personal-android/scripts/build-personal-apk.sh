#!/usr/bin/env bash
set -euo pipefail

if (($# > 0)); then
  printf 'Usage: %s\nBuilds the personal ARM64 APK with EAS managed signing and remote counters.\n' "$0"
  if [[ "$1" == '--help' || "$1" == '-h' ]]; then exit 0; fi
  printf 'Legacy release-version, no-prebuild and universal options are retired.\n' >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../../.." && pwd)"
cd "$repo_root/apps/mobile"
export APP_VARIANT=personal
export T3CODE_MOBILE_CHANNEL=personal-production
export EXPO_NO_DOTENV=1
# EAS still reserves the remote build number and supplies managed credentials for local workers.
exec pnpm dlx eas-cli@27.5.0 build --platform android --profile personal --local
