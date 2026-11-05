#!/bin/sh
# Delete the floating tags (`v0`) in this checkout, before Craft prepares a
# release. Craft finds the last version with `git describe --tags --match
# 'v*'`. The floating tag is on the same commit as the last release tag, and
# git picks it, so Craft reads no version and bumps from 0.0.0. This changes
# only the local checkout. Craft does not push tags when it prepares.
set -eu

tags=$(git tag --list 'v*')
for tag in $tags; do
  case "$tag" in
    v*.*.*) ;;
    *) git tag --delete "$tag" >/dev/null ;;
  esac
done
