.PHONY: help bootstrap build test lint compose-up compose-down compose-logs e2e sdk-demo clean

help:
	@echo "OLP make targets:"
	@echo "  bootstrap    - copy .env.example to .env + npm install all"
	@echo "  build        - build all node packages"
	@echo "  test         - run unit tests"
	@echo "  compose-up   - docker compose up --build -d"
	@echo "  compose-down - docker compose down"
	@echo "  e2e          - run e2e smoke script"

bootstrap:
	cp -n .env.example .env || copy .env.example .env
	npm install --workspaces
	cd packages/sdk-python && pip install -e . || true

build:
	npm run build --workspaces --if-present

test:
	npm run test --workspaces --if-present

lint:
	npm run lint --workspaces --if-present || true

compose-up:
	docker compose --env-file .env up --build -d

compose-down:
	docker compose down

compose-logs:
	docker compose logs -f --tail=200

e2e:
	bash tests/e2e/smoke.sh || powershell -File tests/e2e/smoke.ps1

clean:
	docker compose down -v || true
	rm -rf packages/*/dist packages/*/node_modules node_modules || true
