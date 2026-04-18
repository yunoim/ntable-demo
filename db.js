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

    // 방별 커스텀 질문/주제 jsonb — 생성 시점 md 스냅샷 + 호스트 편집분
    try {
      await client.query(`ALTER TABLE rooms ADD COLUMN questions_json JSONB`);
    } catch (e) {
      if (e.code !== '42701') throw e;
    }
    try {
      await client.query(`ALTER TABLE rooms ADD COLUMN free_topics_json JSONB`);
    } catch (e) {
      if (e.code !== '42701') throw e;
    }
    // 팩 식별자 — 분석/리포팅용
    try {
      await client.query(`ALTER TABLE rooms ADD COLUMN pack_id VARCHAR(40)`);
    } catch (e) {
      if (e.code !== '42701') throw e;
    }

    // 게스트 카드에 표시할 필드 (호스트가 방 생성 시 결정)
    // display_fields: ["birth_year","region","industry","interest"] 중 호스트 선택
    // birth_year_format: 'exact' (1990) | 'decade_half' (30초/30중/30후)
    try {
      await client.query(`ALTER TABLE rooms ADD COLUMN display_fields JSONB DEFAULT '["birth_year","region","industry","interest"]'::jsonb`);
    } catch (e) {
      if (e.code !== '42701') throw e;
    }
    try {
      await client.query(`ALTER TABLE rooms ADD COLUMN birth_year_format VARCHAR(20) DEFAULT 'exact'`);
    } catch (e) {
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

    // survey_responses 업그레이드 — 호스트 평가·카테고리 태그·UNIQUE
    try {
      await client.query(`ALTER TABLE survey_responses ADD COLUMN host_rating INTEGER`);
    } catch (e) { if (e.code !== '42701') throw e; }
    try {
      await client.query(`ALTER TABLE survey_responses ADD COLUMN host_comment TEXT`);
    } catch (e) { if (e.code !== '42701') throw e; }
    try {
      await client.query(`ALTER TABLE survey_responses ADD COLUMN liked_tags JSONB`);
    } catch (e) { if (e.code !== '42701') throw e; }
    try {
      await client.query(`
        ALTER TABLE survey_responses
        ADD CONSTRAINT survey_responses_uuid_room_id_key
        UNIQUE (uuid, room_id)
      `);
    } catch (e) { if (e.code !== '42710' && e.code !== '42P07') throw e; }

    // room_connections — 후기 단계의 "또 만나고 싶은 사람" (동성·이성 무관)
    await client.query(`
      CREATE TABLE IF NOT EXISTS room_connections (
        id SERIAL PRIMARY KEY,
        room_id INTEGER REFERENCES rooms(id),
        from_uuid VARCHAR REFERENCES users(uuid),
        to_uuid VARCHAR REFERENCES users(uuid),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (room_id, from_uuid, to_uuid)
      )
    `);

    // admin_users — Google OAuth 화이트리스트
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        google_sub VARCHAR(64) UNIQUE,
        name VARCHAR(100),
        picture TEXT,
        role VARCHAR(20) NOT NULL DEFAULT 'tenant_admin',
        tenant_id VARCHAR(40),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        last_login_at TIMESTAMP
      )
    `);

    // admin_sessions — OAuth 로그인 후 발급되는 세션 토큰
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token VARCHAR(128) PRIMARY KEY,
        admin_id INTEGER REFERENCES admin_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMP NOT NULL,
        ip VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Bootstrap super_admin — skb.yunho.im@gmail.com
    await client.query(
      `INSERT INTO admin_users (email, role, active)
       VALUES ($1, 'super_admin', true)
       ON CONFLICT (email) DO UPDATE SET role = 'super_admin', active = true`,
      ['skb.yunho.im@gmail.com']
    );

    console.log('[DB] All tables initialized');
  } catch (err) {
    console.error('[DB] initDB error:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
