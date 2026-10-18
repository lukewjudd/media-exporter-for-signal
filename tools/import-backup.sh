#!/usr/bin/env bash
# Move a Signal backup folder copied from your phone into backup/.
# The previous backup goes to the Trash, or is renamed to backup.previous-<date>
# if macOS won't let us use the Trash. Used by `just import` and `make import`.
#
# Usage: tools/import-backup.sh <folder>   (the SignalBackups folder, or a folder containing it)
set -euo pipefail

src="${1:-}"
if [ -z "$src" ]; then
  echo "Usage: tools/import-backup.sh <folder>   e.g. ~/Downloads/SignalBackups" >&2
  exit 1
fi
src="${src%/}"
[ -d "$src/SignalBackups" ] && src="$src/SignalBackups"
if [ ! -d "$src/files" ] || ! ls -d "$src"/signal-backup-* >/dev/null 2>&1; then
  echo "That doesn't look like a Signal backup: expected a files/ folder and a signal-backup-… folder in $src" >&2
  exit 1
fi

src="$(cd "$src" && pwd)" # absolute, since we change directory next
cd "$(dirname "$0")/.."
if [ -d backup ]; then
  stamp=$(date +%Y%m%d-%H%M%S)
  if mv backup "$HOME/.Trash/signal-backup-previous-$stamp" 2>/dev/null; then
    echo "Moved the previous backup to the Trash"
  else
    mv backup "backup.previous-$stamp"
    echo "Kept the previous backup as backup.previous-$stamp (delete it when you're happy)"
  fi
fi
mkdir -p backup
mv "$src"/* backup/
rmdir "$src" 2>/dev/null || true
echo "Backup ready in backup/. Next: sync"
