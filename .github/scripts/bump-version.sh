#!/bin/sh
# Write the new version to packages/roach/package.json. Craft runs this when
# it prepares a release (`preReleaseCommand` in .craft.yml). Craft sets
# CRAFT_NEW_VERSION and also gives the old and the new version as arguments.
# The script uses CRAFT_NEW_VERSION, or else the second argument. Only
# `@sentry/roach` has a version: the workspace root and
# `@sentry/roach-service` are private and are not published. Without this
# script, Craft finds the pnpm workspace and also runs
# `npm version --workspaces`, which installs the dev dependencies with npm in
# the release job.
set -eu

if [ -z "${CRAFT_NEW_VERSION:-}" ] && [ "$#" -ne 2 ]; then
  printf 'Usage: %s <old version> <new version>\n' "$0" >&2
  exit 2
fi
cd "$(dirname "$0")/../../packages/roach"
npm version "${CRAFT_NEW_VERSION:-$2}" --no-git-tag-version --allow-same-version >/dev/null
