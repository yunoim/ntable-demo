// 질문/주제 팩 파서.
// questions/packs/*.md — 각 파일이 하나의 팩 (메타 + 탐구 질문 + 자유대화 주제)
// admin.js · rooms.js 에서 공용 사용.
//
// 3-tier 구조 (2026-04-20 확장):
// - 탐구: `## 탐구 질문 - Warm-up` / `- Preference` / `- Deep`
// - 자유대화: `## 자유대화 주제 - 물어보기` / `- 꺼내기` / `- 상상하기`
// - 하위호환: 구 단일 섹션(`## 탐구 질문`, `## 자유대화 주제`)은 tier 미지정으로 수집됨

const fs = require('fs');
const path = require('path');

const PACKS_DIR = path.join(__dirname, '../questions/packs');

// 헤더 텍스트에서 tier / topic group 식별
function detectQuestionTier(header) {
  const h = header.toLowerCase();
  if (h.includes('warm') || h.includes('surface') || h.includes('워밍')) return 'surface';
  if (h.includes('preference') || h.includes('선호')) return 'preference';
  if (h.includes('deep') || h.includes('깊은') || h.includes('심화')) return 'deep';
  return null;
}
function detectTopicGroup(header) {
  const h = header.toLowerCase();
  if (h.includes('물어') || h.includes('ask')) return 'ask';
  if (h.includes('꺼내') || h.includes('share')) return 'share';
  if (h.includes('상상') || h.includes('imagine')) return 'imagine';
  return null;
}

// 한 파일을 파싱해서 팩 객체 반환
function parsePack(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const meta = {};
  const questions = [];
  const topics = [];

  let inFrontmatter = false;
  let frontmatterDone = false;
  let section = null;       // 'questions' | 'topics' | null
  let currentTier = null;   // 'surface' | 'preference' | 'deep' | null
  let currentGroup = null;  // 'ask' | 'share' | 'imagine' | null
  let currentQ = null;

  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();

    // Frontmatter (--- 블록)
    if (!frontmatterDone) {
      if (trimmed === '---') {
        if (!inFrontmatter) { inFrontmatter = true; continue; }
        frontmatterDone = true;
        inFrontmatter = false;
        continue;
      }
      if (inFrontmatter) {
        const m = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+)$/);
        if (m) meta[m[1]] = m[2].trim();
        continue;
      }
    }

    // 섹션 헤더 전환
    if (trimmed.startsWith('## ')) {
      if (currentQ) { questions.push(currentQ); currentQ = null; }
      const header = trimmed.slice(3);
      if (header.includes('탐구') || /questions/i.test(header)) {
        section = 'questions';
        currentTier = detectQuestionTier(header);
      } else if (header.includes('주제') || header.includes('자유') || /topics/i.test(header)) {
        section = 'topics';
        currentGroup = detectTopicGroup(header);
      } else {
        section = null;
        currentTier = null;
        currentGroup = null;
      }
      continue;
    }

    if (section === 'questions') {
      const qMatch = trimmed.match(/^Q(\d+)\.\s+(.+)/);
      if (qMatch) {
        if (currentQ) questions.push(currentQ);
        currentQ = {
          id: questions.length + 1,
          tier: currentTier,
          question: qMatch[2],
          options: [],
        };
        continue;
      }
      const optMatch = trimmed.match(/^([AB])\.\s+(.+)/);
      if (optMatch && currentQ) {
        currentQ.options.push(`${optMatch[1]}. ${optMatch[2]}`);
      }
    } else if (section === 'topics') {
      if (trimmed.startsWith('- ')) {
        topics.push({
          id: topics.length + 1,
          group: currentGroup,
          text: trimmed.slice(2).trim(),
        });
      }
    }
  }
  if (currentQ) questions.push(currentQ);

  // tier / group 별 풀로 재구성 (편집 UI·방 생성 시드 에서 사용)
  const questionsByTier = {
    surface: questions.filter(q => q.tier === 'surface'),
    preference: questions.filter(q => q.tier === 'preference'),
    deep: questions.filter(q => q.tier === 'deep'),
  };
  const topicsByGroup = {
    ask: topics.filter(t => t.group === 'ask'),
    share: topics.filter(t => t.group === 'share'),
    imagine: topics.filter(t => t.group === 'imagine'),
  };

  return {
    id: meta.id || path.basename(filePath, '.md'),
    title: meta.title || meta.id || '',
    description: meta.description || '',
    icon: meta.icon || '📦',
    recommended: meta.recommended || '',
    tone: meta.tone || '',
    category: meta.category || 'other',
    questions,
    questionsByTier,
    topics,
    topicsByGroup,
  };
}

function loadAllPacks() {
  if (!fs.existsSync(PACKS_DIR)) return [];
  const files = fs.readdirSync(PACKS_DIR).filter(f => f.endsWith('.md'));
  return files.map(f => parsePack(path.join(PACKS_DIR, f)));
}

// 팩 목록 (메타만 — 질문·주제는 제외)
function listPacks() {
  return loadAllPacks().map(p => ({
    id: p.id,
    title: p.title,
    description: p.description,
    icon: p.icon,
    recommended: p.recommended,
    tone: p.tone,
    category: p.category,
    question_count: p.questions.length,
    topic_count: p.topics.length,
  }));
}

function getPack(packId) {
  if (!packId) return null;
  const safeId = String(packId).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(PACKS_DIR, `${safeId}.md`);
  if (!fs.existsSync(file)) return null;
  return parsePack(file);
}

// ── 방 생성 시 랜덤 추출 헬퍼 ─────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// tier 비율 분배 — count 를 surface/preference/deep 으로 나눔 (preference 우선)
function distributeTiers(count) {
  const base = Math.floor(count / 3);
  const remainder = count - base * 3;
  const dist = { surface: base, preference: base, deep: base };
  if (remainder >= 1) dist.preference += 1;
  if (remainder >= 2) dist.surface += 1;
  return dist;
}

// 팩 + question_count 로 실제 방에 심을 질문 배열 생성
// 반환: 풀 전체 (각 tier 내 셔플) + 앞에서부터 enabled 분배 (dist 만큼 true, 나머지 false)
// tier 순서: surface → preference → deep (tier 간 순서는 유지 — arc 보존)
function buildRoomQuestions(pack, count) {
  if (!pack || !pack.questionsByTier) {
    // 하위호환: tier 풀 없으면 전체 배열을 count 만큼 앞부분 enabled
    const all = [...(pack?.questions || [])];
    return all.map((q, i) => ({
      id: i + 1,
      tier: q.tier || null,
      question: q.question,
      options: q.options,
      enabled: i < count,
    }));
  }
  const dist = distributeTiers(count);
  const out = [];
  let nextId = 1;
  for (const tier of ['surface', 'preference', 'deep']) {
    const pool = shuffle([...(pack.questionsByTier[tier] || [])]);
    pool.forEach((q, idx) => {
      out.push({
        id: nextId++,
        tier,
        question: q.question,
        options: q.options,
        enabled: idx < dist[tier],
      });
    });
  }
  return out;
}

// 팩 → 방 자유대화 topics: 전체 풀 + enabled 초기값 true
// group 순서: ask → share → imagine (각 그룹 내 셔플)
function buildRoomTopics(pack) {
  if (!pack || !pack.topicsByGroup) {
    const all = [...(pack?.topics || [])];
    return all.map((t, i) => ({
      id: i + 1,
      group: t.group || null,
      text: t.text,
      enabled: true,
    }));
  }
  const out = [];
  let nextId = 1;
  for (const group of ['ask', 'share', 'imagine']) {
    const pool = shuffle([...(pack.topicsByGroup[group] || [])]);
    pool.forEach(t => {
      out.push({
        id: nextId++,
        group,
        text: t.text,
        enabled: true,
      });
    });
  }
  return out;
}

// 하위 호환 — 기본 팩
const DEFAULT_PACK_ID = 'icebreaker';

// 팩별 마무리 단계 (closing_steps)
// - 'mvp'           : MVP 투표 + 발표
// - 'match'         : 사랑의 작대기 + 매칭 발표
// - 'explore-result': 라운드별 탐구 결과 카드
// 빈 배열이면 closing 단계 없이 모임 종료
const PACK_FLOW_DEFAULTS = {
  couples: [],                                // 1:1 — closing-explore-result 자동
  icebreaker: ['mvp'],                        // 첫만남 — MVP 만
  'friends-reunion': ['explore-result'],      // 오랜만 — 탐구 결과 카드
  dating: ['mvp', 'match'],                   // 연애 — MVP + 작대기
  teambuilding: ['mvp', 'explore-result'],    // 팀빌딩 — MVP + 결과
  'playlist-share': ['mvp', 'explore-result'],// 플리 공유회 — BEST 플리 투표 + 탐구 결과
  'nights-stories': ['mvp'],                  // 나의 이야기 찾기 — 오늘의 주인공만
};

function getPackFlow(packId) {
  if (PACK_FLOW_DEFAULTS[packId]) return PACK_FLOW_DEFAULTS[packId];
  return ['mvp']; // 미정의 팩 기본값
}

// 시리즈 메타 (상위 브랜드 레이어) — ntable 컨텐츠 라인업
// 각 pack 은 series 필드로 연결. status='skeleton' 은 create UI 에 '준비 중' 으로 노출.
const SERIES = {
  'ntable-nights':  { label: 'ntable Nights',  icon: '🌙', tagline: '대화·창작 소모임 (주 1회)',          max_people: 8, status: 'active' },
  'ntable-plays':   { label: 'ntable Plays',   icon: '🎵', tagline: '음악 공유·연주 대회 (월 1회)',        max_people: 8, status: 'active' },
  'ntable-draws':   { label: 'ntable Draws',   icon: '🎨', tagline: '시·그림 창작 대회 (월 1회)',          max_people: 8, status: 'skeleton' },
  'ntable-pitches': { label: 'ntable Pitches', icon: '💼', tagline: '아이디어·포폴 대회 (월 1회)',         max_people: 8, status: 'skeleton' },
  'ntable-games':   { label: 'ntable Games',   icon: '💪', tagline: '운동 기록 대회 (월 1회)',            max_people: 8, status: 'skeleton' },
};

function getSeries(id) { return SERIES[id] || null; }
function listSeries() { return Object.entries(SERIES).map(([id, s]) => ({ id, ...s })); }

// 컨텐츠 타입 enum (메인 컨텐츠 5단계 성격)
const CONTENT_KIND = {
  conversation: '대화·활동 (제출물 없음)',
  playlist:     '플레이리스트 공유 (URL)',
  performance:  '실연 (앱은 대기·반응만)',
  creation:     '창작물 제출 (이미지·링크) [skeleton]',
  pitch:        '발표 + 심사 점수 [skeleton]',
  record:       '기록 측정 숫자 입력 [skeleton]',
};

// 팩별 UX 정책 (wizard 수집 · 카드 노출 · 결과 페이지 섹션 · 인스타 교환)
// Read-time 에 /api/rooms/:code · /api/result 응답으로 내려줌 (스냅샷 저장 X).
// 호스트가 display_fields 추가·hide_* 토글로 사용자별 override 가능.
const WIZARD_FIELDS_ALL = ['nickname', 'emoji', 'gender', 'birth_year', 'region', 'industry', 'mbti', 'interest', 'instagram'];
const DISPLAY_FIELDS_ALL = ['birth_year', 'region', 'industry', 'mbti', 'interest'];
const RESULT_SECTIONS_ALL = ['ai_personality', 'couple_love', 'couple_card', 'best_match', 'mutual_pairs', 'mvp', 'explore_result', 'summary'];

// skip_free_chat: true 면 탐구(explore) → 자유대화(free) 건너뛰고 바로 마무리(ending).
// wizard_fields: 게스트가 입장 마법사에서 수집하는 필드.
// display_fields_default: 결과카드·참가자카드에 보이는 필드 기본값 (호스트 override 가능).
// result_sections: 결과 페이지에서 렌더될 섹션 화이트리스트.
const PACK_DEFAULTS = {
  // 커플/듀오 — 닉·이모지·MBTI·출생연도만. 자유대화 skip · 매칭·MVP·인스타 없음.
  // 결과: 개인 성향(ai_personality) + 연애 분석(couple_love: MBTI궁합 + 탐구답변 기반) + 커플 카드(couple_card) + 탐구결과 + 요약.
  couples: {
    series: null, // 독립 카테고리 — 시리즈 밖의 2인 전용
    content_kind: 'conversation',
    wizard_fields: ['nickname', 'emoji', 'gender', 'mbti', 'birth_year'],
    display_fields_default: ['birth_year', 'mbti'],
    result_sections: ['ai_personality', 'couple_love', 'couple_card', 'explore_result'],
    skip_free_chat: true,
    insta_exchange_enabled: false,
    best_match_enabled: false,
    mvp_enabled: false,
    match_pairs_enabled: false,
    labels: {
      page2_card_title: '💘 우리 연애 케미',
      best_match_eyebrow: '우리만의 케미',
    },
  },
  // 소개팅/연애 — 전체 필드, 매칭 + 인스타 교환 핵심.
  dating: {
    series: 'ntable-nights',
    content_kind: 'conversation',
    wizard_fields: ['nickname', 'emoji', 'gender', 'birth_year', 'region', 'industry', 'mbti', 'interest', 'instagram'],
    display_fields_default: ['birth_year', 'region', 'industry', 'interest'],
    result_sections: ['ai_personality', 'best_match', 'mutual_pairs', 'explore_result', 'summary'],
    skip_free_chat: false,
    insta_exchange_enabled: true,
    best_match_enabled: true,
    mvp_enabled: true,
    match_pairs_enabled: true,
    labels: {
      page2_card_title: '💘 베스트 매칭',
      best_match_eyebrow: '오늘의 인연',
    },
  },
  // 처음 만나는 사이 — MVP 중심. 인스타·작대기 제외.
  icebreaker: {
    series: 'ntable-nights',
    content_kind: 'conversation',
    wizard_fields: ['nickname', 'emoji', 'gender', 'birth_year', 'region', 'industry', 'mbti', 'interest'],
    display_fields_default: ['birth_year', 'region', 'industry', 'interest'],
    result_sections: ['ai_personality', 'best_match', 'mvp', 'explore_result', 'summary'],
    skip_free_chat: false,
    insta_exchange_enabled: false,
    best_match_enabled: true,
    mvp_enabled: true,
    match_pairs_enabled: false,
    labels: {
      page2_card_title: '🤝 베스트 매칭',
      best_match_eyebrow: '나와 가장 잘 맞았던 사람',
    },
  },
  // 오랜만 — 이미 아는 사이. (2026-04-24 남산엔테이블 '나만의 플리 공유회' 를 위해 create 노출 일시 중단.
  //  코드는 유지 — create.html ROOM_KITS 주석만 처리해서 UI 에서만 제외.)
  'friends-reunion': {
    series: 'ntable-nights',
    content_kind: 'conversation',
    wizard_fields: ['nickname', 'emoji', 'birth_year', 'mbti'],
    display_fields_default: ['birth_year', 'mbti'],
    result_sections: ['ai_personality', 'explore_result', 'summary'],
    skip_free_chat: false,
    insta_exchange_enabled: false,
    best_match_enabled: false,
    mvp_enabled: false,
    match_pairs_enabled: false,
    labels: {
      page2_card_title: '✨ 오늘 또 가까워진 사람',
      best_match_eyebrow: '오늘 다시 통한 사람',
    },
  },
  // 나의 이야기 찾기 — 대화형 Nights 시리즈. 내면·관계·선택 테마 A/B 10문항 + 자유대화.
  // icebreaker 와 유사한 구조 but 질문은 내면·성찰 톤. MVP(오늘의 주인공) 로 마무리.
  'nights-stories': {
    series: 'ntable-nights',
    content_kind: 'conversation',
    wizard_fields: ['nickname', 'emoji', 'gender', 'birth_year', 'mbti', 'interest'],
    display_fields_default: ['birth_year', 'mbti', 'interest'],
    result_sections: ['ai_personality', 'best_match', 'mvp', 'explore_result', 'summary'],
    skip_free_chat: false,
    insta_exchange_enabled: false,
    best_match_enabled: true,
    mvp_enabled: true,
    match_pairs_enabled: false,
    labels: {
      page2_card_title: '🌙 비슷한 이야기를 가진 사람',
      best_match_eyebrow: '나와 비슷한 이야기',
    },
  },
  // 나만의 플리 공유회 — 대회형 포맷. playlist_links 테이블 별도 수집(관심사와 분리).
  // BEST 플리 투표(MVP 재활용) + 인스타 교환 + 음악 테마 5문항 탐구.
  'playlist-share': {
    series: 'ntable-plays',
    content_kind: 'playlist',
    wizard_fields: ['nickname', 'emoji', 'mbti', 'playlist', 'instagram'],
    display_fields_default: ['mbti', 'playlist'],
    result_sections: ['ai_personality', 'best_match', 'mvp', 'explore_result', 'summary'],
    skip_free_chat: false,
    insta_exchange_enabled: true,
    best_match_enabled: true,
    mvp_enabled: true,
    match_pairs_enabled: false,
    labels: {
      page2_card_title: '🎵 오늘의 BEST 플리',
      best_match_eyebrow: '음악 취향이 비슷한 사람',
    },
  },
  // 팀빌딩 — 업종·관심사 중심. MVP 만. 매칭·인스타 없음.
  teambuilding: {
    series: 'ntable-nights',
    content_kind: 'conversation',
    wizard_fields: ['nickname', 'emoji', 'industry', 'mbti', 'interest'],
    display_fields_default: ['industry', 'mbti', 'interest'],
    result_sections: ['ai_personality', 'mvp', 'explore_result', 'summary'],
    skip_free_chat: false,
    insta_exchange_enabled: false,
    best_match_enabled: false,
    mvp_enabled: true,
    match_pairs_enabled: false,
    labels: {
      page2_card_title: '🎯 오늘의 주인공',
      best_match_eyebrow: '비슷한 답을 고른 동료',
    },
  },
};

function getPackDefaults(packId) {
  return PACK_DEFAULTS[packId] || PACK_DEFAULTS[DEFAULT_PACK_ID];
}

function parseQuestions() {
  return getPack(DEFAULT_PACK_ID)?.questions || [];
}

function parseFreeTopics() {
  return getPack(DEFAULT_PACK_ID)?.topics || [];
}

module.exports = {
  parsePack,
  loadAllPacks,
  listPacks,
  getPack,
  parseQuestions,
  parseFreeTopics,
  buildRoomQuestions,
  buildRoomTopics,
  distributeTiers,
  DEFAULT_PACK_ID,
  PACK_FLOW_DEFAULTS,
  getPackFlow,
  PACK_DEFAULTS,
  getPackDefaults,
  WIZARD_FIELDS_ALL,
  DISPLAY_FIELDS_ALL,
  RESULT_SECTIONS_ALL,
  SERIES,
  getSeries,
  listSeries,
  CONTENT_KIND,
};
