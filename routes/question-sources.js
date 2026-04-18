// 질문/주제 팩 파서.
// questions/packs/*.md — 각 파일이 하나의 팩 (메타 + 탐구 질문 + 자유대화 주제)
// admin.js · rooms.js 에서 공용 사용.

const fs = require('fs');
const path = require('path');

const PACKS_DIR = path.join(__dirname, '../questions/packs');

// 한 파일을 파싱해서 팩 객체 반환
function parsePack(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const meta = {};
  const questions = [];
  const topics = [];

  let inFrontmatter = false;
  let frontmatterDone = false;
  let section = null;
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
      if (header.includes('탐구') || /questions/i.test(header)) section = 'questions';
      else if (header.includes('주제') || header.includes('자유') || /topics/i.test(header)) section = 'topics';
      else section = null;
      continue;
    }

    if (section === 'questions') {
      const qMatch = trimmed.match(/^Q(\d+)\.\s+(.+)/);
      if (qMatch) {
        if (currentQ) questions.push(currentQ);
        currentQ = { id: parseInt(qMatch[1], 10), question: qMatch[2], options: [] };
        continue;
      }
      const optMatch = trimmed.match(/^([AB])\.\s+(.+)/);
      if (optMatch && currentQ) {
        currentQ.options.push(`${optMatch[1]}. ${optMatch[2]}`);
      }
    } else if (section === 'topics') {
      if (trimmed.startsWith('- ')) {
        topics.push({ id: topics.length + 1, text: trimmed.slice(2).trim() });
      }
    }
  }
  if (currentQ) questions.push(currentQ);

  return {
    id: meta.id || path.basename(filePath, '.md'),
    title: meta.title || meta.id || '',
    description: meta.description || '',
    icon: meta.icon || '📦',
    recommended: meta.recommended || '',
    tone: meta.tone || '',
    category: meta.category || 'other',
    questions,
    topics,
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

// 하위 호환 — 기본 팩
const DEFAULT_PACK_ID = 'icebreaker';

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
  DEFAULT_PACK_ID,
};
