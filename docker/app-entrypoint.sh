#!/bin/sh
# Default command of the app image: load the generated secrets, then start the
# Next.js standalone server on 0.0.0.0:3000. POSIX sh only.
cd /app || exit 1
exec /app/tools/docker/with-secrets.sh node server.js "$@"
