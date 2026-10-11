.PHONY: up down build restart staging-up staging-down staging-build staging-restart staging-logs usage usage-staging

up:
	docker compose up -d
down:
	docker compose down
build:
	docker compose build
restart: down build up

STAGING = docker compose --profile staging

staging-up:
	$(STAGING) up -d marvin-staging
staging-down:
	$(STAGING) rm -sf marvin-staging
staging-build:
	$(STAGING) build marvin-staging
staging-restart: staging-down staging-build staging-up
staging-logs:
	$(STAGING) logs -f marvin-staging

usage:
	docker compose exec -T marvin cat data/usage.json | node scripts/usage-report.mjs - $(DAYS)
usage-staging:
	$(STAGING) exec -T marvin-staging cat data/usage.json | node scripts/usage-report.mjs - $(DAYS)
