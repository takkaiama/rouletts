import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined,
  max: 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

export async function initDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada.');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bdt_users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(80) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(10) NOT NULL CHECK (role IN ('admin','user')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bdt_machines (
      id BIGSERIAL PRIMARY KEY,
      code VARCHAR(60) UNIQUE NOT NULL,
      description VARCHAR(180) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );


    CREATE TABLE IF NOT EXISTS bdt_farms (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(180) UNIQUE NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bdt_records (
      id BIGSERIAL PRIMARY KEY,
      work_date VARCHAR(20) NOT NULL,
      shift VARCHAR(30) NOT NULL,
      operation_code VARCHAR(30),
      sheet_no VARCHAR(20),
      sheet_total VARCHAR(20),
      farm VARCHAR(180) NOT NULL,
      up_area VARCHAR(180) NOT NULL,
      machine_code VARCHAR(60) NOT NULL,
      machine_description VARCHAR(180) NOT NULL,
      operator_name VARCHAR(180) NOT NULL,
      employee_id VARCHAR(80) NOT NULL,
      trailer_set VARCHAR(180),
      hourmeter_initial VARCHAR(40) NOT NULL,
      hourmeter_final VARCHAR(40) NOT NULL,
      hourmeter_hours VARCHAR(40) NOT NULL,
      shift_start VARCHAR(20) NOT NULL,
      shift_end VARCHAR(20) NOT NULL,
      hourmeter_fueling VARCHAR(40),
      diesel_l VARCHAR(40),
      hydraulic_oil_l VARCHAR(40),
      fueling_responsible VARCHAR(180),
      trips JSONB NOT NULL DEFAULT '[]'::jsonb,
      interventions JSONB NOT NULL DEFAULT '[]'::jsonb,
      total_trips VARCHAR(40) NOT NULL,
      shift_hours VARCHAR(40) NOT NULL,
      operated_hours VARCHAR(40) NOT NULL,
      unproductive_hours VARCHAR(40) NOT NULL,
      operational_stops VARCHAR(40) NOT NULL,
      maintenance_stops VARCHAR(40) NOT NULL,
      observations TEXT,
      operator_signature VARCHAR(180),
      supervisor_signature VARCHAR(180),
      created_by BIGINT REFERENCES bdt_users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_bdt_records_date ON bdt_records(work_date);
    CREATE INDEX IF NOT EXISTS idx_bdt_records_machine ON bdt_records(machine_code);
    CREATE INDEX IF NOT EXISTS idx_bdt_records_creator ON bdt_records(created_by);
  `);

  const machineCount = await pool.query('SELECT COUNT(*)::int AS count FROM bdt_machines');
  if (machineCount.rows[0].count === 0) {
    const machines = [
      ['BT-01','PICADOR'],['BT-18','PICADOR'],['BT-42','PICADOR'],
      ['BT-02','PC'],['BT-10','PC'],['BT-17','PC'],
      ['BT-06','SKIDER'],['BT-14','SKIDER'],['BT-34','SKIDER'],
      ['BT-15','FELLER'],['BT-24','FELLER'],['BT-41','FELLER'],
      ['BT-0001','PICADOR ALUGADO'],['BT-320','PC ALUGADA'],
      ['BT-0002','PICADOR ALUGADO BIOMATA'],['BT-04','PICADOR ALUGADO']
    ];
    for (const [code, description] of machines) {
      await pool.query('INSERT INTO bdt_machines(code,description,active) VALUES($1,$2,true)', [code,description]);
    }
  }

  const farmCount = await pool.query('SELECT COUNT(*)::int AS count FROM bdt_farms');
  if (farmCount.rows[0].count === 0) {
    const farms = ['ALDEIA','BOA ESPERANÇA','CANEL','CARACOL','CATINGUEIRA','CATINGUEIRO','COLINA VERDE','EXTREMA','FRANGO NATO','IPÊ','JUSSARA','LIVRAMENTO','MAIOBA','MELINA','PROGRESSO','SANTIAGO','SINOBRAS','TUPACIGUARA'];
    for (const name of farms) {
      await pool.query('INSERT INTO bdt_farms(name,active) VALUES($1,true)', [name]);
    }
  }

}
