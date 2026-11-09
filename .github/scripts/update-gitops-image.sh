#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <values-file> <40-character-git-sha>" >&2
  exit 64
fi

values_file=$1
image_tag=$2

if [[ ! -f "$values_file" ]]; then
  echo "Helm values file does not exist: $values_file" >&2
  exit 66
fi

if [[ ! "$image_tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Image tag must be a full lowercase 40-character Git SHA" >&2
  exit 65
fi

temporary_file=$(mktemp "${values_file}.tmp.XXXXXX")
trap 'rm -f "$temporary_file"' EXIT

awk -v image_tag="$image_tag" '
  BEGIN {
    in_root_image = 0
    updated = 0
  }

  /^image:[[:space:]]*(#.*)?$/ {
    in_root_image = 1
    print
    next
  }

  in_root_image && /^[^[:space:]#]/ {
    in_root_image = 0
  }

  in_root_image && /^  tag:[[:space:]]*/ {
    if (updated > 0) {
      exit 42
    }

    print "  tag: " image_tag
    updated++
    next
  }

  { print }

  END {
    if (updated != 1) {
      exit 42
    }
  }
' "$values_file" > "$temporary_file"

mv "$temporary_file" "$values_file"
trap - EXIT
