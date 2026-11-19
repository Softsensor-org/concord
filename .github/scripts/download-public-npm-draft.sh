#!/usr/bin/env bash
# Fetch one reviewed npm tarball from the public Concord release draft.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: download-public-npm-draft.sh RELEASE_ID ASSET_ID TAG SHA256 OUTPUT" >&2
  exit 2
fi
release_id="$1"
asset_id="$2"
tag="$3"
digest="$4"
output="$5"
if ! [[ "$release_id" =~ ^[1-9][0-9]*$ && "$asset_id" =~ ^[1-9][0-9]*$ &&
        "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.+-]+)?$ && "$digest" =~ ^[a-f0-9]{64}$ ]]; then
  echo "invalid public npm draft identity" >&2
  exit 2
fi

endpoint="repos/Softsensor-org/concord/releases"
gh api --method GET "$endpoint/$release_id" |
  node -e '
    const [id, assetId, tag, digest] = process.argv.slice(1);
    const release = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const asset = release.assets?.find((entry) => String(entry.id) === assetId);
    if (String(release.id) !== id || release.draft !== true || release.tag_name !== tag ||
        asset?.name !== `create-concord-${tag.slice(1)}.tgz` || asset.state !== "uploaded" ||
        asset.digest !== `sha256:${digest}`) {
      throw new Error("the public draft does not contain the approved npm asset");
    }
  ' "$release_id" "$asset_id" "$tag" "$digest"
umask 077
gh api --method GET --header 'Accept: application/octet-stream' "$endpoint/assets/$asset_id" > "$output"
if ! printf '%s  %s\n' "$digest" "$output" | sha256sum --check --status --strict; then
  echo "downloaded public npm tarball differs from the approved asset digest" >&2
  exit 1
fi
