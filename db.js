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
        interest VARCHAR(200),
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

    // 호스트 화면 형태 — 'mobile' | 'presenter' (큰 화면)
    try {
      await client.query(`ALTER TABLE rooms ADD COLUMN display_mode VARCHAR(20) DEFAULT 'mobile'`);
    } catch (e) {
      if (e.code !== '42701') throw e;
    }

    // 게스트 사진 업로드 허용 여부 (호스트가 결정)
    try {
      await client.query(`ALTER TABLE rooms ADD COLUMN photo_enabled BOOLEAN DEFAULT TRUE`);
    } catch (e) {
      if (e.code !== '42701') throw e;
    }

    // 지역 세부 (서울만 구 단위 노출 여부)
    try {
      await client.query(`ALTER TABLE rooms ADD COLUMN region_detail BOOLEAN DEFAULT FALSE`);
    } catch (e) {
      if (e.code !== '42701') throw e;
    }

    // 팩별 마무리 단계 — JSONB 배열 (예: ["mvp","match"], [], ["explore-result"])
    try {
      await client.query(`ALTER TABLE rooms ADD COLUMN closing_steps JSONB DEFAULT '["mvp"]'::jsonb`);
    } catch (e) {
      if (e.code !== '42701') throw e;
    }

    // 자유대화 구성 (호스트가 방 생성 시 결정)
    // - free_chat_timer_minutes: 0 = 타이머 없음 / N분 = N분 카운트다운
    // - free_chat_chat_enabled: 익명채팅 입력창 노출 여부
    // - free_chat_topic_card_enabled: 주제카드 분배 가능 여부
    try { await client.query(`ALTER TABLE rooms ADD COLUMN free_chat_timer_minutes INTEGER DEFAULT 15`); } catch (e) { if (e.code !== '42701') throw e; }
    try { await client.query(`ALTER TABLE rooms ADD COLUMN free_chat_chat_enabled BOOLEAN DEFAULT TRUE`); } catch (e) { if (e.code !== '42701') throw e; }
    try { await client.query(`ALTER TABLE rooms ADD COLUMN free_chat_topic_card_enabled BOOLEAN DEFAULT TRUE`); } catch (e) { if (e.code !== '42701') throw e; }

    // 인스타그램 수집 — 호스트가 toggle 가능. wizard에서 인스타 step 노출 여부.
    // create 시 dating·icebreaker 팩만 default true.
    try { await client.query(`ALTER TABLE rooms ADD COLUMN instagram_collect BOOLEAN DEFAULT FALSE`); } catch (e) { if (e.code !== '42701') throw e; }

    // 모임 시각 — 호스트가 create.html에서 입력 (선택). QR/카카오 공유 텍스트에 노출.
    try { await client.query(`ALTER TABLE rooms ADD COLUMN meeting_at TIMESTAMPTZ`); } catch (e) { if (e.code !== '42701') throw e; }

    // 아바타 이모지 — 사진 안 올린 사용자를 위한 대안 (토끼/호랑이/여우 등). users + room_members 양쪽
    try { await client.query(`ALTER TABLE users ADD COLUMN emoji VARCHAR(8)`); } catch (e) { if (e.code !== '42701') throw e; }
    try { await client.query(`ALTER TABLE room_members ADD COLUMN emoji VARCHAR(8)`); } catch (e) { if (e.code !== '42701') throw e; }

    // interest 길이 확장 — 기존 VARCHAR(30)는 6개+ 멀티 선택 시 초과 (운동, 독서, 음식, 등산, 사진, 공연 + 직접 입력)
    try { await client.query(`ALTER TABLE users ALTER COLUMN interest TYPE VARCHAR(200)`); } catch (e) { if (e.code !== '42701' && e.code !== '42703') throw e; }
    try { await client.query(`ALTER TABLE room_members ALTER COLUMN interest TYPE VARCHAR(200)`); } catch (e) { if (e.code !== '42701' && e.code !== '42703') throw e; }

    // 카드 비공개 (입력+숨김) — 멤버별로 매칭에는 사용되지만 게스트 카드에는 안 보이게 마스킹
    try { await client.query(`ALTER TABLE room_members ADD COLUMN hide_birth_year BOOLEAN DEFAULT FALSE`); } catch (e) { if (e.code !== '42701') throw e; }
    try { await client.query(`ALTER TABLE room_members ADD COLUMN hide_region BOOLEAN DEFAULT FALSE`); } catch (e) { if (e.code !== '42701') throw e; }
    try { await client.query(`ALTER TABLE room_members ADD COLUMN hide_industry BOOLEAN DEFAULT FALSE`); } catch (e) { if (e.code !== '42701') throw e; }
    try { await client.query(`ALTER TABLE room_members ADD COLUMN hide_interest BOOLEAN DEFAULT FALSE`); } catch (e) { if (e.code !== '42701') throw e; }
    try { await client.query(`ALTER TABLE room_members ADD COLUMN hide_instagram BOOLEAN DEFAULT FALSE`); } catch (e) { if (e.code !== '42701') throw e; }

    // users.nickname — 방별 익명 구조로 전환되며 더 이상 unique·required 아님
    // (호환성 위해 컬럼 자체는 유지)
    try { await client.query(`ALTER TABLE users ALTER COLUMN nickname DROP NOT NULL`); } catch (_) {}
    try { await client.query(`ALTER TABLE users DROP CONSTRAINT users_nickname_key`); } catch (_) {}

    // 일반 사용자 OAuth (Google / Kakao) — 익명 + 편의 hybrid
    try { await client.query(`ALTER TABLE users ADD COLUMN google_sub VARCHAR UNIQUE`); } catch (e) { if (e.code !== '42701') throw e; }
    try { await client.query(`ALTER TABLE users ADD COLUMN kakao_sub VARCHAR UNIQUE`); } catch (e) { if (e.code !== '42701') throw e; }
    try { await client.query(`ALTER TABLE users ADD COLUMN email VARCHAR(200)`); } catch (e) { if (e.code !== '42701') throw e; }
    try { await client.query(`ALTER TABLE users ADD COLUMN name VARCHAR(100)`); } catch (e) { if (e.code !== '42701') throw e; }
    try { await client.query(`ALTER TABLE users ADD COLUMN picture VARCHAR(500)`); } catch (e) { if (e.code !== '42701') throw e; }
    try { await client.query(`ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP`); } catch (e) { if (e.code !== '42701') throw e; }

    // user_sessions — OAuth 토큰 보관 (admin_sessions와 동일 패턴)
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        token VARCHAR PRIMARY KEY,
        user_uuid VARCHAR NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        expires_at TIMESTAMP NOT NULL,
        ip VARCHAR(50),
        user_agent VARCHAR(500),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // 일회성 리셋 — Railway env RESET_DB=1 설정 시 모든 사용자/방 데이터 비움.
    // 리셋 후 Railway env 에서 RESET_DB 제거 권장 (다음 재배포 시 또 비우지 않게).
    if (process.env.RESET_DB === '1') {
      console.warn('[db] ⚠️ RESET_DB=1 — TRUNCATE users/rooms/room_members/... (admin_users 유지)');
      await client.query(`
        TRUNCATE
          room_members,
          member_results,
          survey_responses,
          room_state,
          rooms,
          users
        RESTART IDENTITY CASCADE
      `);
      console.warn('[db] ✓ truncate complete. Remove RESET_DB env to prevent next-restart wipe.');
    }

    // room_members — 방별 닉네임/프로필 스냅샷 (방 종료 시 CASCADE 자동 삭제)
    // 같은 uuid 도 다른 방에서 다른 닉네임 가능. 같은 방 안에서 nickname unique.
    await client.query(`
      CREATE TABLE IF NOT EXISTS room_members (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        uuid VARCHAR NOT NULL,
        nickname VARCHAR(20) NOT NULL,
        gender VARCHAR(10),
        birth_year INTEGER,
        region VARCHAR(50),
        industry VARCHAR(50),
        mbti VARCHAR(10),
        interest VARCHAR(200),
        instagram VARCHAR(50),
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(room_id, nickname),
        UNIQUE(room_id, uuid)
      )
    `);

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

    // insta_selects — 결과 페이지 이후 '인스타 교환' 전용. 선택은 single-direction committed (취소 없음).
    // 상호 선택(양방향 레코드 2건) 시에만 양쪽 instagram 공개.
    await client.query(`
      CREATE TABLE IF NOT EXISTS insta_selects (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        selector_uuid VARCHAR NOT NULL,
        target_uuid VARCHAR NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(room_id, selector_uuid, target_uuid)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_insta_selects_room ON insta_selects(room_id)
    `);

    // playlist_links — playlist-share 팩 전용 플레이리스트 URL.
    // interest 필드 재활용 대신 방별 별도 테이블로 분리 (관심사와 혼동·마이그레이션 리스크 제거).
    await client.query(`
      CREATE TABLE IF NOT EXISTS playlist_links (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        uuid VARCHAR NOT NULL,
        url TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(room_id, uuid)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_playlist_links_room ON playlist_links(room_id)
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
