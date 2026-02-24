.PHONY: install link unlink typecheck test check smoke release-gate

install:
	bun install

link:
	bun link

unlink:
	bun unlink

typecheck:
	bun run typecheck

test:
	bun test

check: typecheck test

smoke:
	bun run src/index.ts --help >/dev/null
	bun run src/index.ts --version
	bun run src/index.ts list >/dev/null
	bun run src/index.ts autonomy >/dev/null
	bun run src/index.ts verify >/dev/null
	bun run src/index.ts verify --show-scode >/dev/null

release-gate: check smoke
	@echo "Release gate passed. Review docs/RELEASE-GATE.md before tagging."
