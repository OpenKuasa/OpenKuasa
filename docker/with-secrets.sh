#!/bin/sh
# Loads /secrets/generated.env (written once by scripts/local-init.mjs) into the
# environment, then runs the given command. A name that is already set and
# non-empty keeps its value, so what the user typed in .env always wins.
# POSIX sh only: this file is also mounted into Supabase containers.
file="${OPENKUASA_SECRETS_FILE:-/secrets/generated.env}"

if [ -e "$file" ] && [ ! -r "$file" ]; then
  echo "with-secrets: cannot read $file; starting without generated settings" >&2
elif [ -r "$file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    case "$key" in
      ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;;
    esac
    eval "cur=\${$key:-}"   # $key is a validated identifier; the value is never eval'd
    if [ -z "$cur" ]; then
      export "$key=$val"
    fi
  done < "$file"
fi

exec "$@"
