const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        uuid VARCHAR PRIMARY KEY,
        nickname VARCHAR(20) UNIQUE NOT NULL,
        gender VARCHAR(10),
        birth_year INTEGER,
        region VARCHAR(50),
        industry VARCHAR(50),
        mbti VARCHAR(10),
        interest VARCHAR(30),
        instagram VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        room_code VARCHAR(10) UNIQUE NOT NULL,
        title VARCHAR(100) NOT NULL,
        host_uuid VARCHAR REFERENCES users(uuid),
        host_role VARCHAR(20) DEFAULT 'host_only',
        status VARCHAR(20) DEFAULT 'waiting',
        question_count INTEGER DEFAULT 10,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // 기존 배포 테이블에 question_count 컬럼 없을 경우 추가
    try {
      await client.query(`ALTER TABLE rooms ADD COLUMN question_count INTEGER DEFAULT 10`);
    } catch (e) {
      // 42701 = duplicate_column
      if (e.code !== '42701') throw e;
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS room_state (
        room_id INTEGER PRIMARY KEY REFERENCES rooms(id),
        state_json JSONB,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS survey_responses (
        id SERIAL PRIMARY KEY,
        uuid VARCHAR REFERENCES users(uuid),
        room_id INTEGER REFERENCES rooms(id),
        satisfaction INTEGER,
        revisit BOOLEAN,
        nps INTEGER,
        best_moment TEXT,
        regret TEXT,
        review TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS member_results (
        id SERIAL PRIMARY KEY,
        uuid VARCHAR REFERENCES users(uuid),
        room_id INTEGER REFERENCES rooms(id),
        room_code VARCHAR(10),
        votes_json JSONB,
        match_json JSONB,
        fi_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // UNIQUE 제약 추가 - 이미 존재하면 에러 무시
    try {
      await client.query(`
        ALTER TABLE member_results
        ADD CONSTRAINT member_results_uuid_room_id_key
        UNIQUE (uuid, room_id)
      `);
    } catch (e) {
      // 42710 = duplicate_object (제약/인덱스 이미 존재), 42P07 = duplicate_table
      if (e.code !== '42710' && e.code !== '42P07') throw e;
    }


    console.log('[DB] All tables initialized');
  } catch (err) {
    console.error('[DB] initDB error:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
