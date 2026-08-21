import { DatabaseSync } from 'node:sqlite';

/** Small adapter around Node's built-in SQLite binding, keeping transaction handling explicit. */
export class SqliteDatabase {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
  }

  prepare(sql: string) {
    return this.database.prepare(sql);
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  close(): void {
    this.database.close();
  }

  pragma(statement: string, options?: { simple?: boolean }): unknown {
    const normalized = statement.trim();
    if (/^user_version\s*=\s*\d+$/.test(normalized)) {
      this.database.exec(`PRAGMA ${normalized}`);
      return undefined;
    }
    if (
      ![
        'foreign_keys = ON',
        'foreign_keys',
        'journal_mode = WAL',
        'busy_timeout = 5000',
        'user_version',
      ].includes(normalized)
    ) {
      throw new Error(`Unsupported PRAGMA: ${statement}`);
    }
    const row = this.database.prepare(`PRAGMA ${normalized}`).get() as
      Record<string, unknown> | undefined;
    if (!row) return undefined;
    return options?.simple ? Object.values(row)[0] : row;
  }

  transaction<T>(operation: () => T): () => T {
    return () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const result = operation();
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    };
  }
}
