#!/bin/sh
# Tell whether the given commit is still the head of main, so a deploy
# does not go back to an older commit. Writes `promoted=true` or
# `promoted=false` to $GITHUB_OUTPUT. Exits non-zero when it cannot read
# the head of main.
set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s <sha>\n' "$0" >&2
  exit 2
fi
sha=$1

head=$(timeout 60 gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha)
if [ -z "$head" ]; then
  printf '::error::Could not read the head of main.\n'
  exit 1
fi
if [ "$head" != "$sha" ]; then
  printf '::notice::main is at %s now, not %s. Nothing deploys.\n' "$head" "$sha"
  printf 'promoted=false\n' >>"$GITHUB_OUTPUT"
else
  printf 'promoted=true\n' >>"$GITHUB_OUTPUT"
fi
