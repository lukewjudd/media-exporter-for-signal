# Media Exporter for Signal: run `just` to see these recipes.

set shell := ["bash", "-euo", "pipefail", "-c"]

# List the recipes
[private]
default:
    @just --list --unsorted

# Install dependencies, download the face models and build the Swift helper
[group('start here')]
setup:
    npm install
    npm run setup
    @[ -f .env ] || { cp .env.example .env; echo "Created .env: add your recovery key to it (or leave it blank to be asked)"; }

# Move a backup folder copied from your phone into backup/ (the old one goes to the Trash)
[group('start here')]
import folder:
    tools/import-backup.sh "{{ folder }}"

# Decrypt the backup and build everything (only new files are processed)
[group('everyday')]
sync:
    npm run sync

# Open the app in your browser
[group('everyday')]
view:
    npm run view

# Import a new backup folder, then sync
[group('everyday')]
update folder: (import folder) sync

# Send photos you marked keep to Apple Photos (the Send to Photos button does the same)
[group('everyday')]
send-to-photos:
    npm run export-photos

# Show what Send to Photos would import, without importing
[group('everyday')]
send-to-photos-preview:
    node src/export-photos.mjs --dry-run

# Build the demo archive from made-up chats (photos are downloaded once)
[group('demo')]
demo-build:
    npm run demo:build

# Open the demo, building it first if needed
[group('demo')]
demo:
    @[ -d demo/data/archive ] || just demo-build
    npm run demo

# Run one step of the sync on its own
[group('single steps')]
step name:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{ name }}" in
        extract|db|dashboard|viewer|clip|faces|people) npm run "{{ name }}" ;;
        *) echo "Unknown step '{{ name }}'. Steps: extract, db, dashboard, viewer, clip, faces, people" >&2; exit 1 ;;
    esac

# Run the end-to-end test (fake backup, sync, delete media, sync again)
[group('develop')]
test:
    npm test
