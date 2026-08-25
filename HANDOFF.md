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
  `arena/01a03277-shul-store-manager` (head `e8e18cc`, 13 commits over main, no conflicts, **NOT merge-ready** — in progress).
  What is implemented so far (foundation + rounds of narrow fixes):
  - LAN HTTP server in the manager (default port 3939), single-use 6-digit pairing codes, bearer-token auth (SHA-256 hash stored)
  - Kiosk Electron app skeleton (pairing screen → barcode scan → card-only checkout)
  - New schema/migration (kiosk pairs + tokens), strict request schemas (client never sends prices)
  - Inventory reservation for pending card charges, 10-minute reconciliation of outstanding processor work, idempotent charge recovery across kiosk/manager restarts
  - Kiosk charge path now resolves + validates processor config BEFORE creating a transaction/reservation or any processor I/O (`apps/manager/electron/kiosk-server.ts`)
  - `docs/kiosk.md` with API description + a 5-step manual QA checklist
  - Last verification run: `npm install` + `npm run typecheck` (all workspaces passed). The full command matrix was NOT re-run after the final fix.
  - **Open requirements (from the last session's final report — the milestone is NOT done):**
    1. Shared payment lifecycle/finalizer (orchestration service) — the kiosk charge path duplicates manager checkout logic instead of using one shared service
    2. Frozen processor configuration identity (snapshot the processor config at transaction creation)
    3. Isolated reconciliation (must not race live operations)
    4. Snapshot-only completion (charge completion must use the frozen snapshot)
    5. `needs-attention` state for failed/orphaned charges
    6. Real LAN integration tests (HTTP regression tests against the kiosk server — none committed yet)
    7. Scanner flow in the kiosk app
    8. Secure kiosk main-process bridge (preload/IPC)
    9. Kiosk + manager UX polish
    10. Sync/restore coverage for kiosk data (outbox events, cloud restore)
    11. PIN KDF for the kiosk local admin PIN
    12. Bind/rebind (kiosk re-pairing)
    13. `docs/kiosk.md` updated to reflect actual behavior
    14. Windows QA

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

1. **Get the command matrix green first:** `npm install` → `format:check`/`format` → `lint` → `typecheck` → `test` → `build` → `audit` (the last session only ran typecheck after its final fix).
2. **Work through the open kiosk requirements above**, starting with the architectural gaps: (a) the shared payment lifecycle/finalizer so kiosk and manager checkout share one path, (b) frozen processor config + snapshot-only completion, (c) isolated reconciliation + `needs-attention` state.
3. **Add real LAN HTTP integration tests** for pair / catalog / cart price / charges / charge lookup / revoke, including kill-and-restart charge recovery.
4. Then the remaining items: scanner flow, secure preload bridge, UX polish, sync/restore coverage, PIN KDF, bind/rebind.
5. Update `docs/kiosk.md` to match actual behavior, then work the manual QA checklist, then Windows QA.
6. Only consider merging PR #6 after the above; otherwise keep pushing to `arena/01a03277-shul-store-manager` (no force-pushes — that branch is tracked by this session history).
7. Any new milestone: feature branch → full command matrix green → `gh pr create` → merge after review.
