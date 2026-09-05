# Repository Instructions

## Required spec workflow

These instructions apply to every repository change, including code, tests, protocol files, scripts, configuration, documentation, and assets.

1. Read `spec/architecture/index.md` and every architecture document relevant to the requested change before editing.
2. Create or update one focused report under `spec/report/` before implementation. Use `spec/report/TEMPLATE.md`; record context, goals, non-goals, constraints, risks, and an implementation plan. A coherent multi-turn change may keep updating the same report.
3. During implementation, keep the report aligned with actual decisions and deviations. Do not leave a report describing a plan that the code no longer follows.
4. Before completion, record changed components, migrations/API/security impact, exact validation commands and results, cleanup, rollback, conclusion, and remaining work. Update `spec/report/index.md`.
5. If the change affects architecture, invariants, trust boundaries, public interfaces, protocol compatibility, operations, or tested behavior, update the corresponding file under `spec/architecture/` in the same change.

## Release contracts

- Treat `spec/architecture/02-project-constraints.md` as normative.
- Treat `spec/architecture/07-e2e-release-contracts.md` and `test/e2e/portal-gate.test.mjs` as release contracts. Do not delete, skip, or weaken them just to make a change pass.
- Run `npm run gate` on a macOS host with loopback bind and Seatbelt support before declaring a change complete. If the environment cannot run it, report that limitation explicitly and do not claim the release gate passed.
- Run `git diff --check` and validate relative Markdown links for documentation changes.

## Documentation boundaries

- Long-lived architecture and mandatory invariants belong in `spec/architecture/`.
- Point-in-time plans, implementation details, evidence, and conclusions belong in `spec/report/`.
- Operator instructions belong in `docs/`; the high-level entry point remains `README.md`.
- Never place passwords, tokens, cookies, private keys, production file contents, full prompts, command secrets, or raw sensitive diffs in source, specs, reports, examples, tests, or logs.
