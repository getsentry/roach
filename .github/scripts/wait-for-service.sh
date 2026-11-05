#!/bin/sh
# Wait until the service at the given domain answers after a VM reset: 30
# tries, 10 s apart, after 30 s for the VM to start. Each try has a limit
# of 10 s. Exits 0 when the service answers.
set -eu

if [ "$#" -ne 2 ]; then
  printf 'Usage: %s <domain> <sha>\n' "$0" >&2
  exit 2
fi
domain=$1
sha=$2

sleep 30
i=0
while [ "$i" -lt 30 ]; do
  i=$((i + 1))
  if curl --fail --silent --show-error --max-time 10 -o /dev/null \
    "https://$domain/__roach/ca.pem"; then
    printf 'Deployed %s.\n' "$sha"
    exit 0
  fi
  sleep 10
done
printf '::error::https://%s did not answer in 30 tries, 10 s apart.\n' "$domain"
exit 1
