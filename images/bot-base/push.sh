#!/bin/sh
# Builds the bot base image for linux/amd64 and pushes it to an explicitly selected Vercel Container Registry repository.
# Usage: BOT_BASE_IMAGE_REPOSITORY=vcr.vercel.com/<team>/<project>/bot-base \
#        images/bot-base/push.sh <tag>   (after `vercel vcr login docker`)
# The tag must be v<image-version>: image-version is the ABI marker the image installs as
# /etc/busy-image-version and the bot expects as BOT_BASE_IMAGE_VERSION. Publishing a new image
# changes nothing by itself: bump BOT_BASE_IMAGE (the digest printed below) and BOT_BASE_IMAGE_VERSION
# together, keep the previous digest for rollback, and remember that existing sessions keep the
# computer they were created with.
# Bots live in their own projects: the repository is shared with the team once, with
# `vercel vcr permissions bot-base add <team-id>` (CLI 65+). The repository is
# deliberately required so a clone cannot push to another operator's registry by
# inheriting a project-specific default.
set -eu
cd "$(dirname "$0")"
version=$(cat image-version)
[ "$1" = "v$version" ] || { echo "push.sh: tag $1 does not match image-version $version (expected v$version)" >&2; exit 2; }
if [ -z "${BOT_BASE_IMAGE_REPOSITORY:-}" ]; then
  echo "push.sh: set BOT_BASE_IMAGE_REPOSITORY to your Vercel Container Registry repository (for example vcr.vercel.com/<team>/<project>/bot-base)" >&2
  exit 2
fi
case "$BOT_BASE_IMAGE_REPOSITORY" in
  *[!A-Za-z0-9._:/@-]*|*/|/*)
    echo "push.sh: BOT_BASE_IMAGE_REPOSITORY must be a single Vercel Container Registry repository path" >&2
    exit 2
    ;;
esac
metadata=$(mktemp)
trap 'rm -f "$metadata"' EXIT
# VCR takes gzip layers only; eve's base image ships zstd ones, so recompress on push.
docker buildx build --platform linux/amd64 --provenance=false --metadata-file "$metadata" \
  --output "type=image,name=${BOT_BASE_IMAGE_REPOSITORY}:$1,push=true,compression=gzip,force-compression=true,oci-mediatypes=false" .
digest=$(sed -n 's/.*"containerimage.digest": *"\(sha256:[0-9a-f]*\)".*/\1/p' "$metadata" | head -n 1)
echo "image-version $version"
echo "BOT_BASE_IMAGE ${BOT_BASE_IMAGE_REPOSITORY}@${digest:-<digest not reported; check the registry>}"
