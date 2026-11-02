# Copyright 2026 zrdt contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# Signal-Desktop fork with zrdt: build and run the live demo.
#
#   make install && make run
#
# Prerequisites: macOS on Apple silicon, git, Node v24.22.0 (.nvmrc), pnpm
# 11.24.0 (package.json "packageManager"), elan/lake (Lean). See README.md and
# demo/README.md, "Quick start". GNU Make 3.81 (macOS /usr/bin/make) is enough.
# On Linux only the Lean side runs: make proofs, make comparator.

SHELL := /bin/bash
.DEFAULT_GOAL := help

NODE_WANT := v$(shell cat .nvmrc 2>/dev/null)
PNPM_WANT := 11.24.0

RUN_ARGS ?=
SMOKE_ARGS ?=
STOP_ARGS ?=
KIT_ARGS ?=

ZRDTD := zrdt/core/.lake/build/bin/zrdtd
ELECTRON_APP := node_modules/electron/dist/Electron.app

.PHONY: help tools install built run smoke smoke-apps stop proofs comparator kit

help: ## Show this help
	@echo "Usage: make install && make run"
	@echo
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[1m%-11s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Variables: RUN_ARGS, SMOKE_ARGS, STOP_ARGS (e.g. --port 7461), KIT_ARGS"
	@echo "  e.g. make smoke SMOKE_ARGS=\"--background --port 7461\""

tools: ## Check the required tools (macOS, git, node, pnpm, lake)
	@if [ "$$(uname -s)" != Darwin ]; then \
	  echo "error: the demo (Signal Desktop + zrdt) runs on macOS on Apple silicon; this is $$(uname -s)."; \
	  echo "  The Lean side runs here: make proofs (zrdt's install + run), or clone l-adic/zrdt"; \
	  echo "  and run make install && make run there."; \
	  exit 1; \
	fi
	@[ "$$(uname -m)" = arm64 ] || echo "warning: the demo is tested on Apple silicon (arm64); this Mac is $$(uname -m)"
	@ok=1; \
	command -v git >/dev/null 2>&1 || { echo "missing: git"; ok=; }; \
	if ! command -v node >/dev/null 2>&1; then \
	  echo "missing: node $(NODE_WANT) (.nvmrc); e.g. 'nvm install' or 'fnm use', or https://nodejs.org/dist/$(NODE_WANT)/"; ok=; \
	else \
	  have=$$(node --version); \
	  if [ "$$have" != "$(NODE_WANT)" ]; then \
	    if [ "$${have%%.*}" != "$$(echo $(NODE_WANT) | cut -d. -f1)" ]; then \
	      echo "wrong node: $$have, need $(NODE_WANT) (.nvmrc); e.g. 'nvm install'"; ok=; \
	    else echo "warning: node $$have, the demo is tested with $(NODE_WANT) (.nvmrc)"; fi; \
	  fi; \
	fi; \
	if ! command -v pnpm >/dev/null 2>&1; then \
	  echo "missing: pnpm $(PNPM_WANT); run 'corepack enable' (ships with Node 24) or 'npm install -g pnpm@$(PNPM_WANT)'"; ok=; \
	else \
	  have=$$(pnpm --version 2>/dev/null); \
	  [ "$$have" = "$(PNPM_WANT)" ] || echo "warning: pnpm $$have, package.json wants $(PNPM_WANT) ('corepack enable' or 'npm install -g pnpm@$(PNPM_WANT)')"; \
	fi; \
	command -v lake >/dev/null 2>&1 || { echo "missing: lake; install elan: curl https://elan.lean-lang.org/elan-init.sh -sSf | sh"; ok=; }; \
	if [ -z "$$ok" ]; then echo "fix the above, then run 'make install' again"; exit 1; fi; \
	echo "tools OK: git, node $$(node --version), pnpm $$(pnpm --version), $$(lake --version | head -1)"

install: tools ## Build everything: zrdt submodule + zrdtd, node_modules, Electron, generated files, preload cache
	git submodule update --init --recursive
	cd zrdt/core && lake build zrdtd
	pnpm install --frozen-lockfile
	./node_modules/.bin/install-electron
	pnpm run generate
	pnpm run build:preload-cache
	@echo
	@echo "install done; next: make run (live demo) or make smoke (go/no-go test)"

# What run and smoke need from make install, checked in a second.
built:
	@[ -x $(ZRDTD) ] || { echo "error: no zrdtd at $(ZRDTD): run make install first"; exit 1; }
	@[ -d $(ELECTRON_APP) ] || { echo "error: no Electron at $(ELECTRON_APP): run make install first"; exit 1; }
	@[ -d node_modules/tsx ] || { echo "error: node_modules is incomplete: run make install first"; exit 1; }

run: built ## Live demo: Alice, Bob, Carol linked, the villain's panel in the browser (RUN_ARGS=...)
	demo/run-demo.sh $(RUN_ARGS)

smoke: built ## Smoke test (beats 1-5, headless-ish); exit 0 only if every check passes (SMOKE_ARGS=...)
	demo/run-demo.sh --smoke $(SMOKE_ARGS)

smoke-apps: built ## Apps smoke: the torrent beat on the mock server (SMOKE_ARGS="--plan": no desktops)
	LEAN_ABORT_ON_PANIC=1 node --import tsx demo/smoke-apps.ts $(SMOKE_ARGS)

stop: ## Stop desktops a crashed run left behind (STOP_ARGS="--port N" if not 7357)
	demo/run-demo.sh --stop $(STOP_ARGS)

proofs: ## HEAVY (Mathlib, ~9 GB, ~5 min on 32 cores; best on Linux; not needed for run): build + check zrdt/ proofs
	@[ -f zrdt/Makefile ] || { echo "error: zrdt/ is empty: git submodule update --init"; exit 1; }
	$(MAKE) -C zrdt install run

comparator: ## MEMORY-HEAVY, Linux only: check the proofs with Comparator (zrdt/Makefile; zrdt/README.md)
	@if [ "$$(uname -s)" != Linux ]; then \
	  echo "Comparator runs on Linux only: its sandboxes (bubblewrap for lake comparator, landrun for"; \
	  echo "the standalone comparator) are Linux-only. On a Linux machine, in a fresh clone:"; \
	  echo "  git clone https://github.com/l-adic/zrdt && cd zrdt && make comparator"; \
	  echo "(see 'Running Comparator' in zrdt/README.md)"; \
	  exit 1; \
	fi
	@[ -f zrdt/Makefile ] || { echo "error: zrdt/ is empty: git submodule update --init"; exit 1; }
	$(MAKE) -C zrdt comparator

kit: ## Pack the self-contained MacBook demo kit (demo/pack.sh, KIT_ARGS=...)
	demo/pack.sh $(KIT_ARGS)
