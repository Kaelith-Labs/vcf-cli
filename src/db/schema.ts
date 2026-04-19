// SQL migration text for the two SQLite databases.
//
// Schemas mirror the spec §10 layout. Kept as inline SQL rather than a
// migration library because the footprint is tiny and shipping a pure-SQL
// upgrade path is cheaper than threading a schema lib through bin startup.
//
// Each migration is numbered, applied in a transaction, and recorded in a
// `schema_migrations` table. Running the opener twice is idempotent.

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const GLOBAL_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    up: `
      CREATE TABLE IF NOT EXISTS ideas (
        id              INTEGER PRIMARY KEY,
        path            TEXT NOT NULL UNIQUE,
        slug            TEXT NOT NULL,
        tags            TEXT NOT NULL DEFAULT '[]',   -- JSON array of tags
        created_at      INTEGER NOT NULL,             -- ms since epoch
        frontmatter_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_ideas_slug ON ideas(slug);
      CREATE INDEX IF NOT EXISTS idx_ideas_created_at ON ideas(created_at);

      CREATE TABLE IF NOT EXISTS specs (
        id              INTEGER PRIMARY KEY,
        path            TEXT NOT NULL UNIQUE,
        slug            TEXT NOT NULL,
        tags            TEXT NOT NULL DEFAULT '[]',
        status          TEXT NOT NULL DEFAULT 'draft',
        created_at      INTEGER NOT NULL,
        frontmatter_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_specs_slug ON specs(slug);
      CREATE INDEX IF NOT EXISTS idx_specs_status ON specs(status);

      CREATE TABLE IF NOT EXISTS primers (
        id              INTEGER PRIMARY KEY,
        path            TEXT NOT NULL UNIQUE,
        kind            TEXT NOT NULL,        -- primer | best-practice | lens | stage | reviewer | standard
        tags            TEXT NOT NULL DEFAULT '[]',
        applies_to      TEXT NOT NULL DEFAULT '[]',
        last_reviewed   INTEGER,              -- ms since epoch; NULL if never
        version         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_primers_kind ON primers(kind);

      CREATE TABLE IF NOT EXISTS endpoints (
        id              INTEGER PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        provider        TEXT NOT NULL,
        base_url        TEXT NOT NULL,
        auth_env_var    TEXT,
        trust_level     TEXT NOT NULL CHECK (trust_level IN ('local','trusted','public'))
      );

      CREATE TABLE IF NOT EXISTS model_aliases (
        alias           TEXT PRIMARY KEY,
        endpoint_id     INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
        model_id        TEXT NOT NULL,
        prefer_for      TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS audit (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              INTEGER NOT NULL,
        tool            TEXT NOT NULL,
        scope           TEXT NOT NULL CHECK (scope IN ('global','project','cli')),
        project_root    TEXT,
        client_id       TEXT,
        inputs_hash     TEXT NOT NULL,
        outputs_hash    TEXT NOT NULL,
        endpoint        TEXT,
        result_code     TEXT NOT NULL    -- 'ok' or an E_* code
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
      CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit(tool);
      CREATE INDEX IF NOT EXISTS idx_audit_project ON audit(project_root);
    `,
  },
  {
    version: 2,
    name: "audit_full_payload",
    up: `
      -- Nullable redacted-JSON columns for opt-in full-audit mode.
      -- Populated only when config.audit.full_payload_storage = true.
      -- Same redaction pass that runs before hashing is applied before
      -- storage, so enabling the flag does not leak secrets.
      ALTER TABLE audit ADD COLUMN inputs_json TEXT;
      ALTER TABLE audit ADD COLUMN outputs_json TEXT;
    `,
  },
];

export const PROJECT_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    up: `
      CREATE TABLE IF NOT EXISTS project (
        id              INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
        name            TEXT NOT NULL,
        root_path       TEXT NOT NULL,
        state           TEXT NOT NULL CHECK (state IN (
                          'draft','planning','building','testing','reviewing','shipping','shipped'
                        )),
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        spec_path       TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id              INTEGER PRIMARY KEY,
        path            TEXT NOT NULL UNIQUE,
        kind            TEXT NOT NULL,
        frontmatter_json TEXT NOT NULL DEFAULT '{}',
        mtime           INTEGER NOT NULL,
        hash            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind);

      CREATE TABLE IF NOT EXISTS review_runs (
        id              TEXT PRIMARY KEY,     -- '<type>-<ts>' run id
        type            TEXT NOT NULL,
        stage           INTEGER NOT NULL,
        status          TEXT NOT NULL CHECK (status IN (
                          'pending','running','submitted','superseded'
                        )),
        started_at      INTEGER NOT NULL,
        finished_at     INTEGER,
        report_path     TEXT,
        verdict         TEXT CHECK (verdict IN ('PASS','NEEDS_WORK','BLOCK')),
        carry_forward_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_review_runs_type ON review_runs(type);
      CREATE INDEX IF NOT EXISTS idx_review_runs_stage ON review_runs(stage);

      CREATE TABLE IF NOT EXISTS decisions (
        id              INTEGER PRIMARY KEY,
        slug            TEXT NOT NULL UNIQUE,
        created_at      INTEGER NOT NULL,
        path            TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS response_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        -- review_run_id is a free-form id string. The M5 response-log tool
        -- accepts any value so builders can write stance notes before the
        -- M7 review subsystem creates the matching review_runs row.
        -- Application-level validation (tighter than a DB FK) is added when
        -- M7 lands and the run-id lifecycle is known.
        review_run_id   TEXT NOT NULL,
        stance          TEXT NOT NULL CHECK (stance IN ('agree','disagree')),
        note            TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_response_log_run ON response_log(review_run_id);

      CREATE TABLE IF NOT EXISTS builds (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        target          TEXT NOT NULL,
        started_at      INTEGER NOT NULL,
        finished_at     INTEGER,
        status          TEXT NOT NULL CHECK (status IN ('running','success','failed','canceled')),
        output_path     TEXT
      );
    `,
  },
];
