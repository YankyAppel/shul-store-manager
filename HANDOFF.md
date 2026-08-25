# Session Handoff — Shul Store Manager

_Last updated: 2026-08-25, by the `arena/01a03689-shul-store-manager` session._
_Read this first in the next session, then check `gh pr list` for the current state of open PRs._

## What this project is

Offline-first desktop store-management app for small stores (shuls/shamosim).
Electron + React + TypeScript monorepo, local SQLite (via `node:sqlite`, Node ≥ 22.12 required).

### Layout

| Path | Purpose |
| --- | --- |
| `apps/manager` | Main desktop app (inventory, checkout, customers, settings) |
| `apps/kiosk` | LAN card-only self-checkout app (Milestone 7, currently in open PR #6) |
| `packages/database` | SQLite schema, migrations, transactions, outbox |
| `packages/shared` | Schemas, types, Code 128 SVG rendering |
| `packages/sync` | Supabase cloud backup/restore engine (optional, offline-first) |
| `packages/payments` | Processor-agnostic payment framework |
| `packages/hardware` | Printer/serial helpers |
| `docs/` | architecture, checkout, receivables, labels, payments, cloud-sync, kiosk, development |

## Repo state

- **`main`** is up to date (head `8d6b157`): Milestones 1–4 + optional Supabase cloud backup all merged.
  - M1: inventory + offline checkout foundation
  - M2: customer accounts & receivables
  - M3: barcode label printing + printer settings
  - M4: "Pay now" processor-agnostic payment framework
  - Optional cloud backup/restore (outbox, safeStorage, restore to fresh install)
- **Open PR #6 — "Milestone 7: LAN card-only kiosk"** on branch
  `arena/01a03277-shul-store-manager` (head `e8e18cc`, 13 commits over main, mergeable, no reviews).
  It contains the complete kiosk implementation:
  - LAN HTTP server in the manager (default port 3939), single-use 6-digit pairing codes, bearer-token auth (SHA-256 hash stored)
  - Kiosk Electron app skeleton (pairing screen → barcode scan → card-only checkout)
  - New schema/migration (kiosk pairs + tokens), strict request schemas (client never sends prices)
  - Inventory reservation for pending card charges, 10-minute reconciliation of outstanding processor work, idempotent charge recovery across kiosk/manager restarts
  - `docs/kiosk.md` with API description + a 5-step manual QA checklist
  - **Remaining work: the manual QA checklist in `docs/kiosk.md` (pair → scan → kill/restart charge recovery → revoke), then review/merge.**

## Commands (repo root)

```bash
npm install
npm run dev        # builds shared pkgs, starts Vite + Electron
npm test           # builds shared pkgs, runs database + sync test suites
npm run lint
npm run typecheck
npm run format     # prettier; run `format:check` to verify
npm run build
npm audit --omit=dev --audit-level=high
```

Before submitting changes, run: `format` → `lint` → `typecheck` → `test` → `build` → `audit`.

## Conventions that matter

- **Offline-first:** local SQLite is the single source of truth; all features must work with sync disabled/offline.
- **Migrations are append-only** in `packages/database/src/migrations.ts` (next integer version, never edit shipped ones, fresh-DB + upgrade-path tests).
- **Renderer isolation:** no Node/FS/SQL in the renderer; add a narrow IPC method + shared schema + main-process validation + tests per new operation.
- **Money is integer cents**; balances use a sign convention (positive = owed, negative = credit) — keep it consistent.
- Prettier-formatted; keep the existing file structure and test style.

## Suggested next steps for the new session

1. Confirm PR #6 state (`gh pr view 6`). If it has been merged, continue from `main` and start the next milestone as a new branch/PR. If still open, decide whether to finish QA on top of it.
2. If kiosk QA/fixes are next: work the 5 steps in `docs/kiosk.md`, fix what surfaces, keep the pre-submit checklist green.
3. Any new milestone: follow the repo pattern — feature branch → `npm test`/`lint`/`typecheck`/`build` green → `gh pr create` → merge after review.
