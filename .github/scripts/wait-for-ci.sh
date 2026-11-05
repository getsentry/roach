#!/bin/sh
# Wait until the CI workflow of the given commit on main ends, for up to 20
# minutes. A push or a manual run (workflow_dispatch) on main counts, so a
# commit whose push GitHub did not run can still deploy after
# `gh workflow run ci.yml --ref main`. Exits 0 only when that run passed.
set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s <sha>\n' "$0" >&2
  exit 2
fi
sha=$1

i=0
while [ "$i" -lt 60 ]; do
  i=$((i + 1))
  run=$(timeout 60 gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml \
    --branch main --commit "$sha" --limit 1 --json status,conclusion)
  status=$(printf '%s' "$run" | jq -r '.[0].status // empty')
  if [ "$status" = completed ]; then
    conclusion=$(printf '%s' "$run" | jq -r '.[0].conclusion')
    if [ "$conclusion" = success ]; then
      exit 0
    fi
    printf '::error::CI of %s is %s. Nothing deploys.\n' "$sha" "$conclusion"
    exit 1
  fi
  sleep 20
done
printf '::error::CI of %s did not end in 20 minutes.\n' "$sha"
exit 1
