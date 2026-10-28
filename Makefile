.PHONY: install link unlink runtime typecheck shell test contracts sandbox-contract check smoke release-gate live-gate

install:
	bun install

link:
	bun link

unlink:
	bun unlink

runtime:
	bun run scripts/check-bun-version.ts

typecheck:
	bun run typecheck

shell:
	sh -n bin/codemux
	sh -n scripts/aliases.sh

test:
	bun run test:coverage

contracts:
	bun run test:contracts

sandbox-contract:
	bun run scripts/check-scode-version.ts

check: typecheck shell test

smoke:
	./bin/codemux --help >/dev/null
	./bin/codemux --version
	./bin/codemux list >/dev/null
	./bin/codemux autonomy >/dev/null
	./bin/codemux verify >/dev/null
	./bin/codemux verify --show-scode >/dev/null
	./bin/codemux usage --help >/dev/null
	./bin/codemux calls --help >/dev/null
	./bin/codemux session --help >/dev/null
	./bin/codemux check --help >/dev/null
	./bin/codemux list --help >/dev/null
	./bin/codemux doctor --help >/dev/null
	./bin/codemux autonomy --help >/dev/null

live-gate:
	bun run scripts/live-gate.ts $(LIVE_GATE_ARGS)

release-gate: runtime check contracts sandbox-contract smoke
	bun audit
	bun install --frozen-lockfile --dry-run
	./bin/codemux run --help >/dev/null
	./bin/codemux tui --help >/dev/null
	./bin/codemux usage --help >/dev/null
	./bin/codemux verify --help >/dev/null
	./bin/codemux verify --show-scode --sandbox-trust trusted --sandbox-no-net >/dev/null
	./bin/codemux verify --sandbox-no-net >/dev/null
	@echo "Release gate passed. Review docs/RELEASE-GATE.md before tagging."
