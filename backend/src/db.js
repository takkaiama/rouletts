import pg from 'pg';
import crypto from 'node:crypto';
export const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:8,connectionTimeoutMillis:12000});
export async function initDb(){
  await pool.query(`
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, username text NOT NULL, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','user')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci ON users(lower(username));
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS tables (
 id text PRIMARY KEY, name text NOT NULL, last_snapshot jsonb, last_seen_at timestamptz,
 gap_count bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS spins (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, table_id text NOT NULL REFERENCES tables(id),
 number smallint NOT NULL CHECK(number BETWEEN 0 AND 36), source text NOT NULL DEFAULT 'api',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spins_table_latest ON spins(table_id,id DESC);
CREATE TABLE IF NOT EXISTS preferences (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, table_id text REFERENCES tables(id),
 display_limit integer NOT NULL DEFAULT 100 CHECK(display_limit BETWEEN 1 AND 2000),
 send_enabled boolean NOT NULL DEFAULT false,
 bot_token_cipher text, chat_id_cipher text, thread_id text,
 gale_limit text NOT NULL DEFAULT '1', threshold smallint NOT NULL DEFAULT 64 CHECK(threshold BETWEEN 0 AND 100),
 flags jsonb NOT NULL DEFAULT '{}'::jsonb,
 armed_after_id bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS signals (
 id bigint GENERATED ALWAYS AS ID PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 table_id text NOT NULL REFERENCES tables(id), strategy_key text NOT NULL,
 target text NOT NULL, kind text NOT NULL, start_spin_id bigint NOT NULL,
 last_processed_id bigint NOT NULL, attempts text NOT NULL DEFAULT '0', gale_limit text NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','green','red','cancelled')),
 closed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS signals_one_open ON signals(user_id,table_id,strategy_key) WHERE status='open';
CREATE INDEX IF NOT EXISTS signals_user_recent ON signals(user_id,id DESC);
CREATE TABLE IF NOT EXISTS outbox (
 id bigint GENERATED ALWAYS AS ID PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 table_id text NOT NULL REFERENCES tables(id), strategy_key text NOT NULL,
 spin_id bigint NOT NULL, signal_id bigint REFERENCES signals(id) ON DELETE SET NULL,
 body text NOT NULL, dedupe_key text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','sent','failed','cancelled')),
 tries integer NOT NULL DEFAULT 0, run_after timestamptz NOT NULL DEFAULT now(),
 last_error text, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_delivery ON outbox(status,run_after,id);
CREATE TABLE IF NOT EXISTS audit_log (
 id bigint GENERATED ALWAYS AS ID PRIMARY KEY, actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
 action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
  `);
}
export async function trimSpins(tableId){
  await pool.query(`DELETE FROM spins WHERE table_id=$1 AND id NOT IN
   (SELECT id FROM spins WHERE table_id=$1 ORDER BY id DESC LIMIT 2000)`,[tableId]);
}
export async function lastSpinId(tableId){
  const {rows}=await pool.query('SELECT COALESCE(MAX(id),0)::text AS id FROM spins WHERE table_id=$1',[tableId]);
  return rows[0].id;
}
export const uniqueId=()=>crypto.randomUUID();
