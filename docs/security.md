# Security and publication boundary

## Never publish

- API keys, cookies, bearer tokens, JWTs, `.env` files, credential stores;
- Pi/DSH JSONL sessions, attachments, logs, SQLite/storage projections;
- browser profiles, Chrome Local State, receipts, ports, PIDs and machine paths;
- raw user/assistant messages, prompts, commands, tool output or patch hunks;
- private repository names, remotes, email addresses or internal domains;
- generated `cordis.yml`, `node_modules`, package caches and backup files.

## Safe fixture policy

Tests use synthetic tasks, fake child processes and temporary directories. They must
not read the user's live `DSH_HOME`, Pi session root or browser state. A test that
needs to prove a path or process property should use a generated temporary path and
assert only its shape or lifecycle.

## Restart policy

The supervisor may retry a startup/configuration probe because it has no user task
and no model side effect. It must not automatically replay an accepted coding task.
A real deployment may add an explicit idempotency key and receipt protocol later;
this prototype does not claim that contract.

## Trust statement

This package executes a configured external command with the caller's OS identity.
It is a process-management and evidence-shaping helper, not a sandbox. Review the
DSH command, profile, workspace and environment before enabling it in a trusted Pi
session.
