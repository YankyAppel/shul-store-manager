# Local backups

The manager automatically creates verified, single-file SQLite backups of the
store database. Backups include products, inventory, sales, payments, customer
accounts, settings, kiosk records, and other SQLite data in the live database.
Product images are copied into a shared content-addressed vault under
`backups/images/<first-two-hex-digest-characters>/<sha256>`. The digest is
stored with each image row, and the bytes are hashed before they are placed in
the vault. This prevents a missing or corrupt source file from being stored
under the wrong name. Multiple database backups share one vault object for the
same digest, so retaining more backups does not duplicate unchanged images.
Vault writes use a temporary file and atomic rename.
When old database backups rotate out, unreferenced digest objects are removed
from the vault only after the live database and every retained backup has been
read successfully; otherwise cleanup is skipped for that run.

An image that is missing or corrupt when a backup runs does not invalidate the
verified database snapshot. The attempt remains successful, but its copied and
missing image counts are shown in Settings. During restore, existing image
files are checked by digest and missing or corrupt files are repopulated from
the vault. Images that are not available in the vault remain missing and are
reported after the manager relaunches.

## Location and rotation

Backups are stored in the `backups` directory under Electron's `userData`
directory. A scheduled backup is made when the newest scheduled copy is more
than 20 hours old, then approximately every 24 hours while the manager runs.
The manager keeps the 10 newest scheduled backups and the 3 newest
pre-migration backups, plus the 5 newest manual backups and 3 newest
pre-restore safety backups. Foreign files and files with unrecognized names are
left untouched.

Use **Back up now** to create a manual backup. Manual backups have their own
retention limit and are not counted as scheduled backups.

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
