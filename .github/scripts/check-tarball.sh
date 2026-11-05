#!/bin/sh
# Check the tarball of @sentry/roach in the given directory before CI uploads
# it. Craft publishes only a tarball with this name (`includeNames` in
# .craft.yml), and the tarball must have the license and the README.
set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s <directory>\n' "$0" >&2
  exit 2
fi
cd "$1"
set -- sentry-roach-[0-9]*.tgz
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  printf 'Expected one sentry-roach-<version>.tgz, found: %s\n' "$*" >&2
  exit 1
fi
files=$(tar -tzf "$1")
nl='
'
for f in package/LICENSE package/README.md package/package.json; do
  case "$nl$files$nl" in
    *"$nl$f$nl"*) ;;
    *)
      printf '%s does not have %s\n' "$1" "$f" >&2
      exit 1
      ;;
  esac
done
