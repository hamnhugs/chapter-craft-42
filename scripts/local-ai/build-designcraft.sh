#!/usr/bin/env bash
# DesignCraft with Bookworm Studio's "Save as Template" button beside every page
# in its Pages panel. Builds the desktop app from a source checkout carrying the
# patch (branch bookworm-templates, one commit on top of the release tag) and
# puts it in place of the released binary. The released CLI stays: the bridge's
# MCP server is unchanged.
#
#   scripts/local-ai/build-designcraft.sh        # build + install (~2 min warm, ~5 cold)
#
# Re-run after install-crafts.sh updates DesignCraft (install-crafts.sh does it
# for you): it moves the patch onto the installed release first. Needs Rust
# (rustup, user-level) and the checkout at DESIGNCRAFT_SRC (default ~/Work/designcraft).
# How the button reaches Bookworm Studio: docs/local-ai/CRAFTS.md › "Save as
# Template from the DesignCraft window".
set -euo pipefail

CC_HOME="${CC_HOME:-$HOME/.local/share/chapter-craft-local}"
CRAFTS="$CC_HOME/crafts"
DEST="$CRAFTS/designcraft"
SRC="${DESIGNCRAFT_SRC:-$HOME/Work/designcraft}"
BRANCH=bookworm-templates
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/designcraft-target}"
say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
die() { echo "build-designcraft: $*" >&2; exit 1; }

command -v cargo >/dev/null || die "needs Rust: curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal"
[ -x "$DEST/usr/bin/designcraft" ] || die "DesignCraft isn't installed; run scripts/local-ai/install-crafts.sh designcraft"
[ -d "$SRC/.git" ] || die "no DesignCraft source at $SRC (git clone https://github.com/storytold/designcraft $SRC)"
git -C "$SRC" rev-parse -q --verify "$BRANCH" >/dev/null || die "$SRC has no $BRANCH branch (the patch)"
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || die "$SRC has uncommitted changes; commit or stash them first"

# The patch goes on the release that's installed, so the app matches its CLI.
tag="$(cat "$DEST/VERSION")"
git -C "$SRC" rev-parse -q --verify "refs/tags/$tag" >/dev/null || git -C "$SRC" fetch -q origin tag "$tag"
git -C "$SRC" switch -q "$BRANCH"
if ! git -C "$SRC" merge-base --is-ancestor "$tag" HEAD; then
  say "moving the patch onto $tag"
  # The patch is the branch's one commit.
  git -C "$SRC" rebase -q --onto "$tag" HEAD~1 "$BRANCH" \
    || { git -C "$SRC" rebase --abort 2>/dev/null; die "the patch doesn't apply to $tag; DesignCraft keeps the released build (no button)"; }
fi

say "building DesignCraft $tag + Save as Template ($(git -C "$SRC" rev-parse --short HEAD))"
(cd "$SRC" && nice -n 10 cargo build --release -j "${JOBS:-6}" -p designcraft)
built="$CARGO_TARGET_DIR/release/designcraft"
"$built" --version >/dev/null 2>&1 || die "the build doesn't run"

bin="$DEST/usr/bin/designcraft"
[ -f "$DEST/PATCHED" ] || cp -f "$bin" "$bin.release"
cp -f "$built" "$bin.new" && mv -f "$bin.new" "$bin"
printf '%s %s\n' "$tag" "$(git -C "$SRC" rev-parse HEAD)" > "$DEST/PATCHED"

# The menu launcher has to pass DESIGNCRAFT_TEMPLATE_INBOX (older launchers don't).
grep -q DESIGNCRAFT_TEMPLATE_INBOX "$CRAFTS/bin/designcraft" 2>/dev/null \
  || CC_LAUNCHERS_ONLY=1 CC_SKIP_DESIGNCRAFT_BUILD=1 "$(dirname "$0")/install-crafts.sh" designcraft
say "done. Close any open DesignCraft window and open it again to get the button."
say "back to the released build: cp $bin.release $bin && rm $DEST/PATCHED"
