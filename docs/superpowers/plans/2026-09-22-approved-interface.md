# Approved Kairos interface connected to production

**Goal:** Publish the approved clarity prototype with real authenticated data, preserving verified-owner administration and public sharing.
**Architecture:** Keep the existing secure administration in admin-workspace.html. Move the approved stock and market shell into production with shared Firebase authentication, API error handling and explicit data adapters. No demo datasets ship with the live UI.
**Spec:** ../../../../design-proposals/kairos-clarity/LOCAL-V2.md and the user's approved screens.

## Constraints
- Preserve backend entitlement checks and server-side verified owner allowlist.
- Never fabricate prices, identities, holdings history, news or missing metrics.
- Preserve public /a/:ticker and /og/:ticker.png sharing.
- Use the approved HTML/CSS, radar and chart interactions rather than restyling legacy cards.
- French and English navigation; missing data has an explicit empty state.

## Execution
- [x] Add and test pure adapters: finite numbers, weighted radar normalization, transaction dates, missing holdings comparisons, source links.
- [x] Copy the approved presentation assets, replace fixture loading with authenticated API bootstrap and real search. Retain wheel zoom, operation-only popovers and activist stars.
- [x] Connect the stock tabs to actual fundamentals, funds, activists, news, earnings and company fields. No synthetic price history or benchmark.
- [x] Connect insider, convergence, activist and fund screens with search, filters, pagination and real identities.
- [x] Preserve admin in a dedicated workspace; update old hash routes and public entry links to the new UI.
- [x] Check automated tests, authenticated browser interactions, FR/EN and mobile. Compare screenshot against approved local page.
- [ ] Publish explicit changed files and verify production, admin access and social metadata.
