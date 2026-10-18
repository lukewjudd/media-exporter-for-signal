# Media Exporter for Signal: run `make` to see these targets.
# The same tasks as the justfile; both call the npm scripts and tools/.

.DEFAULT_GOAL := help
.PHONY: help setup import sync view update send-to-photos send-to-photos-preview demo-build demo step test

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/' | awk -F'\t' '{printf "  %-24s %s\n", $$1, $$2}'

setup: ## Install dependencies, download the face models and build the Swift helper
	npm install
	npm run setup
	@[ -f .env ] || { cp .env.example .env; echo "Created .env: add your recovery key to it (or leave it blank to be asked)"; }

import: ## Move a backup into backup/: make import FOLDER=~/Downloads/SignalBackups
	@[ -n "$(FOLDER)" ] || { echo "Usage: make import FOLDER=~/Downloads/SignalBackups" >&2; exit 1; }
	tools/import-backup.sh "$(FOLDER)"

sync: ## Decrypt the backup and build everything (only new files are processed)
	npm run sync

view: ## Open the app in your browser
	npm run view

update: import sync ## Import a new backup, then sync: make update FOLDER=...

send-to-photos: ## Send photos you marked keep to Apple Photos
	npm run export-photos

send-to-photos-preview: ## Show what Send to Photos would import, without importing
	node src/export-photos.mjs --dry-run

demo-build: ## Build the demo archive from made-up chats
	npm run demo:build

demo: ## Open the demo, building it first if needed
	@[ -d demo/data/archive ] || $(MAKE) demo-build
	npm run demo

step: ## Run one sync step: make step STEP=clip (extract, db, dashboard, viewer, clip, faces, people)
	@case "$(STEP)" in extract|db|dashboard|viewer|clip|faces|people) npm run "$(STEP)" ;; *) echo "Usage: make step STEP=<extract|db|dashboard|viewer|clip|faces|people>" >&2; exit 1 ;; esac

test: ## Run the end-to-end test
	npm test
