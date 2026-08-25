# Local backups

The manager automatically creates verified, single-file SQLite backups of the
store database. Backups include products, inventory, sales, payments, customer
accounts, settings, kiosk records, and other SQLite data in the live database.
Product images under `userData/images` are not covered by this backup.

## Location and rotation

Backups are stored in the `backups` directory under Electron's `userData`
directory. A scheduled backup is made when the newest scheduled copy is more
than 20 hours old, then approximately every 24 hours while the manager runs.
The manager keeps the 10 newest scheduled backups and the 3 newest
pre-migration backups. Foreign files and files with unrecognized names are
left untouched.

Before a database migration on a non-empty store, the manager makes and
verifies a pre-migration backup. If that backup cannot be verified, the
migration is aborted. Every attempt and its result is retained in the local
backup history.

## Restore

In **Settings → Local backups**, choose an available verified backup and type
the requested confirmation text. The manager first creates a verified
pre-restore copy of the current database, closes the live database, removes
stale SQLite WAL files, swaps in the selected copy, and relaunches. The source
backup is never deleted. If preparation fails, the live database is not
replaced.

Backups are verified with SQLite's integrity check, schema-version check, and
queries against core tables before they are offered as restorable copies.
