# Copyright 2026 zrdt contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# Signal-Desktop fork with zrdt: build and run the live demo.
#
#   make install && make run
#
# Prerequisites: macOS (arm64), git, Node v24.22.0 (.nvmrc), pnpm 11.24.0
# (package.json "packageManager"), elan/lake (Lean). See demo/README.md,
# "Quick start". GNU Make 3.81 (macOS /usr/bin/make) is enough.

SHELL := /bin/bash
.DEFAULT_GOAL := help

NODE_WANT := v$(shell cat .nvmrc 2>/dev/null)
PNPM_WANT := 11.24.0

RUN_ARGS ?=
SMOKE_ARGS ?=
STOP_ARGS ?=
KIT_ARGS ?=

.PHONY: help tools install run smoke stop proofs comparator kit

help: ## Show this help
	@echo "Usage: make install && make run"
	@echo
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[1m%-11s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Variables: RUN_ARGS, SMOKE_ARGS, STOP_ARGS (e.g. --port 7461), KIT_ARGS"
	@echo "  e.g. make smoke SMOKE_ARGS=\"--background --port 7461\""

tools: ## Check the required tools (git, node, pnpm, lake)
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
	[ "$$(uname -s)" = Darwin ] || echo "warning: the demo scripts are written for macOS (Electron.app); other systems are untested"; \
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

run: ## Live demo: Alice, Bob, Carol linked, the villain's panel in the browser (RUN_ARGS=...)
	demo/run-demo.sh $(RUN_ARGS)

smoke: ## Smoke test (beats 1-5, headless-ish); exit 0 only if every check passes (SMOKE_ARGS=...)
	demo/run-demo.sh --smoke $(SMOKE_ARGS)

stop: ## Stop desktops a crashed run left behind (STOP_ARGS="--port N" if not 7357)
	demo/run-demo.sh --stop $(STOP_ARGS)

proofs: ## Build the Lean proofs in zrdt/ (Mathlib cache) and run the axiom gate
	$(MAKE) -C zrdt install run

comparator: ## Check the proofs with Comparator (via zrdt/Makefile)
	@if grep -qE '^comparator:' zrdt/Makefile 2>/dev/null; then \
	  $(MAKE) -C zrdt comparator; \
	else \
	  echo "zrdt/ (submodule at $$(git -C zrdt rev-parse --short HEAD 2>/dev/null || echo '?')) has no 'comparator' target yet."; \
	  echo "Update the submodule to a zrdt commit that has one (git -C zrdt fetch && git -C zrdt checkout origin/main),"; \
	  echo "or see zrdt/README.md for running Comparator by hand."; \
	  exit 1; \
	fi

kit: ## Pack the self-contained MacBook demo kit (demo/pack.sh, KIT_ARGS=...)
	demo/pack.sh $(KIT_ARGS)
