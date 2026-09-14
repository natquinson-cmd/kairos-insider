# Kairos audit reliability implementation plan

> For agentic workers: use the subagent-driven-development workflow for independent tasks, with review before completion.

**Goal:** Fix the reproducible data and premium-journey defects observed in the September 14 browser audit, and make the analysis/watchlist navigation clearer.

**Architecture:** Keep the existing vanilla frontend, Cloudflare Worker and Python pipelines. Correct source normalization and shared presentation contracts rather than changing stored customer data. Add focused offline regression tests with Node's test runner and Python unittest.

**Spec:** User-approved audit in this conversation: regulatory source provenance, fund identity, earnings percentages, public/premium consistency, current offers, alerts availability and direct analysis access.

## Constraints

- Work only in this worktree on `codex/audit-reliability`; preserve the original checkout's existing modifications.
- No production writes, messages, subscription changes, cleanup jobs, pushes or deployment during implementation.
- Keep legacy subscribers at their existing 29 EUR price; advertise Pro 19 EUR/month (190/year) and Elite 49 EUR/month (490/year) for new users.
- Read no secrets. Tests must use controlled fixtures and local data stores, not production bindings.
- Preserve French and English behavior and the current visual identity.
- Do not change the Kairos investment model or infer missing financial values from zero.

## Task 1: Regulatory provenance

Owned files: EU threshold Python collectors, `worker/src/eu_thresholds_aggregator.js`, a focused provenance module and its tests. Integration points in `worker/src/index.js` are coordinated by root.

- [x] Trace the AMF article through the collectors, cached payloads and consumers.
- [x] Reproduce with fixtures: official AMF filing stays eligible; a Google News editorial with no verified declaration never becomes an official regulatory signal; a press item never inherits an AMF source label.
- [x] Fix ingestion and protect existing cached rows at read time without deleting production data.
- [x] Run offline Python/Node tests and report changes required at the API boundary.

## Task 2: Financial normalization and fund identity

Owned files: `worker/src/stock-api.js`, 13F collection/discovery scripts, focused tests. Dashboard and public HTML rendering are coordinated by root.

- [x] Trace earnings, dividend, insiders and fund-count contracts across providers and public truncation.
- [x] Reproduce earnings examples with literal expected results: 2.02 vs 1.89 = approximately 6.8783%; 2.01 vs 1.94 = 3.6082%; missing/zero consensus must not produce infinity.
- [x] Correct erroneous fund CIK/name mappings using official entity evidence and protect consumers of cached aliases where feasible.
- [x] Keep aggregate counts intact when trimming the public list, preserve transaction classification, normalize dividend units and expose missing data distinctly.
- [x] Run offline tests and communicate frontend expectations.

## Task 3: Public offers and entry path

Owned files: `index.html`, `action.html`, optional shared public presentation asset, focused tests. SSR sections in `worker/src/index.js` and `assets/i18n.js` are coordinated by root.

- [x] Replace obsolete new-customer prices with current Pro/Elite offers while leaving legacy billing untouched.
- [x] Make analysis CTAs point to the dashboard ticker route, retaining the selected ticker and language.
- [x] Clearly label illustrative market data and simplify the primary/secondary entry actions.
- [x] Distinguish the available historical placement simulator from planned strategy backtests; remove unsupported availability dates and undocumented comparative claims in touched sections.
- [x] Verify HTML/script syntax and functional routing; no tests of static marketing wording.

## Task 4: Dashboard clarity and integration

Owned files: `dashboard.html`, `assets/i18n.js`, `worker/src/index.js`, test integration/configuration.

- [x] Integrate the provenance and financial fixes in API/SSR and dashboard presentation.
- [x] Correct dividend labels and low-price rounding; show missing values faithfully.
- [x] Replace the obsolete Elite alerts screen with accurate channel status/access to watchlist settings, preserving the working Telegram and email controls.
- [x] Put adding a watchlist ticker before oversized status cards, and provide a clear confirmation recovery action only if supported by the existing API.
- [x] Add lightweight in-page navigation to the long stock analysis and clarify incomplete score-variation explanations without altering scores.
- [x] Keep mobile navigation usable and preserve existing portfolio/watchlist state.

## Task 5: Verification and delivery

- [x] Run the focused Node/Python tests, JS syntax checks and Worker build locally.
- [x] Exercise representative public/analysis/watchlist views in Chrome against a local preview and controlled data; inspect desktop/mobile layout.
- [x] Obtain independent review of the changes and resolve material findings.
- [x] Record the tested results and any production refresh required, commit only this worktree's intended files, and deliver a reviewable local branch.

## Baseline

Base commit: `3f9fd20cc65d8d4d6c1a5b995331eff156231927` (matches remote main at start).
`node --check worker/src/index.js` and `node --check worker/src/stock-api.js` pass. No general test runner is configured initially.
