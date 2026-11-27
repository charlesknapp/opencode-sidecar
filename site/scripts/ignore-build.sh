#!/bin/sh
# Vercel's Ignored Build Step: exit 0 skips the build, exit 1 builds.
# Compares against the last deployed commit, so a push of several commits
# deploys when any of them touched the site. Vercel clones shallowly, so that
# commit is fetched first; if it can't be found, build.
paths=". ../CHANGELOG.md ../package.json ../src/webview ../src/shared ../media/main.css"
base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -n "$base" ]; then
  git cat-file -e "$base^{commit}" 2>/dev/null ||
    git fetch -q --depth=1 origin "$base" 2>/dev/null
else
  base="HEAD^"
fi
git cat-file -e "$base^{commit}" 2>/dev/null || exit 1
# shellcheck disable=SC2086
git diff --quiet "$base" HEAD -- $paths && exit 0
exit 1
