.PHONY: help bootstrap build test lint license-check compose-up compose-down compose-logs e2e sdk-check clean

help:
	@echo "synapseone make targets:"
	@echo "  bootstrap    - copy .env.example to .env + npm install all"
	@echo "  build        - build all node packages"
	@echo "  test         - run unit tests"
	@echo "  license-check - copyleft gate + SBOM (node tools/license-check.cjs)"
	@echo "  compose-up   - docker compose up --build -d"
	@echo "  compose-down - docker compose down"
	@echo "  e2e          - run e2e smoke script"
	@echo "  sdk-check    - live SDK smoke (needs gateway at SYNAPSEONE_BASE_URL)"

bootstrap:
	cp -n .env.example .env || copy .env.example .env
	npm install --workspaces
	cd sdks/sdk-python && pip install -e . || true

build:
	npm run build --workspaces --if-present

test:
	npm run test --workspaces --if-present

lint:
	npm run lint --workspaces --if-present || true

license-check:
	node tools/license-check.cjs --sbom sbom.json

compose-up:
	docker compose --env-file .env up --build -d

compose-down:
	docker compose down

compose-logs:
	docker compose logs -f --tail=200

e2e:
	bash tests/e2e/smoke.sh || powershell -File tests/e2e/smoke.ps1
	bash tests/e2e/api-check.sh

sdk-check:
	node tests/e2e/sdk-check.js
	python tests/e2e/sdk-check.py || python3 tests/e2e/sdk-check.py

clean:
	docker compose down -v || true
	rm -rf apps/*/dist tools/*/dist sdks/sdk-js/dist apps/*/node_modules tools/*/node_modules sdks/sdk-js/node_modules node_modules || true
