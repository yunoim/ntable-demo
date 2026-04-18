// md 파일에서 탐구 질문 / 자유대화 주제 파싱하는 헬퍼.
// admin.js · rooms.js 에서 공용 사용.

const fs = require('fs');
const path = require('path');

// 반환 포맷: { id, question, options: ["A. ...", "B. ..."] }
// — host/guest 클라이언트가 options 배열을 기대.
function parseQuestions() {
  const filePath = path.join(__dirname, '../questions/season1.md');
  const content = fs.readFileSync(filePath, 'utf-8');
  const questions = [];
  let current = null;
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    const qMatch = trimmed.match(/^Q(\d+)\.\s+(.+)/);
    if (qMatch) {
      if (current) questions.push(current);
      current = { id: parseInt(qMatch[1], 10), question: qMatch[2], options: [] };
      continue;
    }
    const optMatch = trimmed.match(/^([AB])\.\s+(.+)/);
    if (optMatch && current) {
      current.options.push(`${optMatch[1]}. ${optMatch[2]}`);
    }
  }
  if (current) questions.push(current);
  return questions;
}

function parseFreeTopics() {
  const filePath = path.join(__dirname, '../questions/free-topics.md');
  const content = fs.readFileSync(filePath, 'utf-8');
  const topics = [];
  let id = 1;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const text = line.slice(2).trim();
    if (!text) continue;
    topics.push({ id: id++, text });
  }
  return topics;
}

module.exports = { parseQuestions, parseFreeTopics };
