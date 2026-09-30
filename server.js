const express = require('express'), helmet = require('helmet'), cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const multer = require('multer'), pdf = require('pdf-parse'), { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'dev-only-secret';
const UPLOADS = path.join(__dirname, 'storage'); fs.mkdirSync(UPLOADS, { recursive: true });
const db = new DatabaseSync(path.join(__dirname, 'studyvault.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, hash TEXT, createdAt TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS materials(id INTEGER PRIMARY KEY, userId INTEGER, title TEXT, fileName TEXT, storedName TEXT, mimeType TEXT,
  fileSize INTEGER, fileHash TEXT, subject TEXT, chapter TEXT, topic TEXT, materialType TEXT, summary TEXT, source TEXT, sourceGroup TEXT,
  sourceSender TEXT, status TEXT DEFAULT 'PROCESSING', pageCount INTEGER DEFAULT 0, isFavorite INTEGER DEFAULT 0, createdAt TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, materialId INTEGER, userId INTEGER, pageNumber INTEGER, content TEXT);
CREATE INDEX IF NOT EXISTS m_user ON materials(userId, subject, isFavorite, createdAt);
CREATE INDEX IF NOT EXISTS c_user ON chunks(userId, materialId);`);

const fail = (res, s, code, message) => res.status(s).json({ success: false, error: { code, message } });
const app = express();
app.use(helmet({ contentSecurityPolicy: false })); app.use(express.json({ limit: '1mb' })); app.use(cookieParser());
app.use('/api/auth', rateLimit({ windowMs: 15 * 60000, max: 50 }));

const auth = (req, res, next) => {
  try { req.uid = jwt.verify(req.cookies.sv, SECRET).uid; next(); } catch { fail(res, 401, 'UNAUTHORIZED', 'Please log in.'); }
};
const setCookie = (res, uid) => res.cookie('sv', jwt.sign({ uid }, SECRET, { expiresIn: '30d' }), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });

// ---- Auth
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 8) return fail(res, 400, 'INVALID_INPUT', 'Enter a name, a valid email and a password of 8+ characters.');
  try {
    const r = db.prepare('INSERT INTO users(name,email,hash) VALUES(?,?,?)').run(name.trim(), email.toLowerCase(), bcrypt.hashSync(password, 10));
    setCookie(res, r.lastInsertRowid); res.json({ success: true, data: { name } });
  } catch { fail(res, 409, 'EMAIL_TAKEN', 'An account with this email already exists.'); }
});
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get((email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.hash)) return fail(res, 401, 'BAD_CREDENTIALS', 'Email or password is incorrect.');
  setCookie(res, u.id); res.json({ success: true, data: { name: u.name } });
});
app.post('/api/auth/logout', (_, res) => { res.clearCookie('sv'); res.json({ success: true }); });
app.get('/api/auth/me', auth, (req, res) => res.json({ success: true, data: db.prepare('SELECT id,name,email FROM users WHERE id=?').get(req.uid) }));

// ---- Processing (background: runs after the upload response is sent)
const SUBJECTS = { Physics: ['kirchhoff', 'circuit', 'voltage', 'current', 'magnetic', 'optics', 'thermodynamics', 'force', 'semiconductor'],
  Chemistry: ['organic', 'reaction', 'acid', 'molecule', 'bond', 'periodic', 'equilibrium'],
  Mathematics: ['integration', 'derivative', 'matrix', 'theorem', 'calculus', 'equation', 'probability'],
  Biology: ['cell', 'dna', 'enzyme', 'photosynthesis', 'genetics', 'organism'],
  'Computer Science': ['algorithm', 'function', 'database', 'code', 'network', 'array', 'python'] };
const TYPES = [['Question Paper', /question paper|important questions|previous year/i], ['Assignment', /assignment|homework/i], ['Formula Sheet', /formula/i], ['Lecture Notes', /./]];
function classify(text, name) {
  const t = (name + ' ' + text).toLowerCase(); let best = ['General', 0];
  for (const [s, kws] of Object.entries(SUBJECTS)) { const n = kws.reduce((a, k) => a + (t.split(k).length - 1), 0); if (n > best[1]) best = [s, n]; }
  const words = {}; t.replace(/[a-z]{5,}/g, w => (words[w] = (words[w] || 0) + 1));
  const topic = Object.entries(words).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  return { subject: best[0], topic: topic && topic[0].toUpperCase() + topic.slice(1), materialType: TYPES.find(([, r]) => r.test(t))[0] };
}
async function extract(file, mime) {
  if (mime === 'application/pdf') {
    const pages = [];
    await pdf(fs.readFileSync(file), { pagerender: async pg => { const c = await pg.getTextContent(); const s = c.items.map(i => i.str).join(' '); pages.push(s); return s; } });
    return pages;
  }
  if (mime === 'text/plain') return [fs.readFileSync(file, 'utf8')];
  return []; // DOCX/PPTX/images need OCR/converters: see README "Not yet built"
}
const chunkText = (t, n = 900) => { const out = []; for (let i = 0; i < t.length; i += n) out.push(t.slice(i, i + n).trim()); return out.filter(Boolean); };
async function processMaterial(id) {
  const m = db.prepare('SELECT * FROM materials WHERE id=?').get(id);
  try {
    const pages = await extract(path.join(UPLOADS, m.storedName), m.mimeType);
    const all = pages.join('\n'), ins = db.prepare('INSERT INTO chunks(materialId,userId,pageNumber,content) VALUES(?,?,?,?)');
    db.exec('BEGIN');
try { pages.forEach((p, i) => chunkText(p).forEach(c => ins.run(id, m.userId, i + 1, c))); db.exec('COMMIT'); }
catch (e) { db.exec('ROLLBACK'); throw e; }
    const c = classify(all, m.fileName);
    db.prepare('UPDATE materials SET status=?,pageCount=?,subject=?,topic=?,materialType=?,summary=? WHERE id=?')
      .run('READY', pages.length, c.subject, c.topic, c.materialType, all.slice(0, 280), id);
  } catch (e) { console.error(e); db.prepare("UPDATE materials SET status='FAILED' WHERE id=?").run(id); }
}

// ---- Upload
const ALLOWED = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  const f = req.file; if (!f) return fail(res, 400, 'NO_FILE', 'Choose a file to upload.');
  const ext = path.extname(f.originalname).toLowerCase(), mime = ALLOWED[ext];
  if (!mime) return fail(res, 400, 'BAD_TYPE', 'This file type is not supported.');
  if (ext === '.pdf' && f.buffer.subarray(0, 4).toString() !== '%PDF') return fail(res, 400, 'BAD_FILE', 'This file is not a valid PDF.');
  const hash = crypto.createHash('sha256').update(f.buffer).digest('hex');
  const dup = db.prepare('SELECT id,title,createdAt FROM materials WHERE userId=? AND fileHash=?').get(req.uid, hash);
  if (dup && req.body.force !== '1') return res.status(409).json({ success: false, error: { code: 'DUPLICATE', message: 'We found an existing copy.' }, existing: dup });
  const stored = crypto.randomUUID() + ext; fs.writeFileSync(path.join(UPLOADS, stored), f.buffer);
  const r = db.prepare(`INSERT INTO materials(userId,title,fileName,storedName,mimeType,fileSize,fileHash,subject,materialType,source,sourceGroup,sourceSender)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.uid, path.basename(f.originalname, ext), path.basename(f.originalname), stored, mime, f.size, hash, 'General', 'Lecture Notes',
    req.body.source || 'Upload', req.body.sourceGroup || null, req.body.sourceSender || null);
  setImmediate(() => processMaterial(r.lastInsertRowid));
  res.json({ success: true, data: { id: r.lastInsertRowid, status: 'PROCESSING' } });
});

// ---- Materials (every query is scoped to req.uid)
const own = (req, res) => { const m = db.prepare('SELECT * FROM materials WHERE id=? AND userId=?').get(req.params.id, req.uid);
  if (!m) fail(res, 404, 'MATERIAL_NOT_FOUND', 'Material not found.'); return m; };
const pub = ({ storedName, fileHash, ...m }) => m;
app.get('/api/materials', auth, (req, res) => {
  const { subject, type, favorite } = req.query; let q = 'SELECT * FROM materials WHERE userId=?'; const a = [req.uid];
  if (subject) { q += ' AND subject=?'; a.push(subject); } if (type) { q += ' AND materialType=?'; a.push(type); } if (favorite === '1') q += ' AND isFavorite=1';
  res.json({ success: true, data: db.prepare(q + ' ORDER BY createdAt DESC, id DESC').all(...a).map(pub) });
});
app.get('/api/materials/:id', auth, (req, res) => { const m = own(req, res); if (m) res.json({ success: true, data: pub(m) }); });
app.patch('/api/materials/:id', auth, (req, res) => {
  const m = own(req, res); if (!m) return;
  for (const k of ['title', 'subject', 'chapter', 'topic', 'materialType']) if (typeof req.body[k] === 'string') db.prepare(`UPDATE materials SET ${k}=? WHERE id=?`).run(req.body[k].slice(0, 200), m.id);
  res.json({ success: true, data: pub(db.prepare('SELECT * FROM materials WHERE id=?').get(m.id)) });
});
app.post('/api/materials/:id/favorite', auth, (req, res) => { const m = own(req, res); if (!m) return;
  db.prepare('UPDATE materials SET isFavorite=1-isFavorite WHERE id=?').run(m.id); res.json({ success: true, data: { isFavorite: 1 - m.isFavorite } }); });
app.delete('/api/materials/:id', auth, (req, res) => { const m = own(req, res); if (!m) return;
  db.prepare('DELETE FROM chunks WHERE materialId=?').run(m.id); db.prepare('DELETE FROM materials WHERE id=?').run(m.id);
  fs.rmSync(path.join(UPLOADS, m.storedName), { force: true }); res.json({ success: true }); });
app.get('/api/materials/:id/file', auth, (req, res) => { const m = own(req, res); if (!m) return;
  res.type(m.mimeType).sendFile(path.join(UPLOADS, m.storedName)); });

// ---- Search + retrieval (keyword/TF scoring over chunks + metadata)
const STOP = new Set('the a an of to in and or is are for on about me show notes with what how'.split(' '));
const terms = q => q.toLowerCase().match(/[a-z0-9]{2,}/g)?.filter(w => !STOP.has(w)) || [];
function retrieve(uid, q, limit = 5) {
  const ts = terms(q); if (!ts.length) return [];
  const rows = db.prepare(`SELECT c.*, m.title, m.subject FROM chunks c JOIN materials m ON m.id=c.materialId WHERE c.userId=?`).all(uid);
  return rows.map(r => { const t = r.content.toLowerCase(); const s = ts.reduce((a, w) => a + Math.min(t.split(w).length - 1, 5) + (r.title.toLowerCase().includes(w) ? 2 : 0), 0); return { ...r, score: s }; })
    .filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}
app.get('/api/search', auth, (req, res) => {
  const q = String(req.query.q || '').trim(); if (!q) return res.json({ success: true, data: [] });
  const ts = terms(q), seen = new Map();
  for (const m of db.prepare('SELECT * FROM materials WHERE userId=?').all(req.uid)) {
    const meta = [m.title, m.subject, m.chapter, m.topic, m.materialType, m.sourceGroup, m.summary].join(' ').toLowerCase();
    const s = ts.reduce((a, w) => a + (meta.includes(w) ? 3 : 0), 0); if (s) seen.set(m.id, { m: pub(m), score: s });
  }
  for (const r of retrieve(req.uid, q, 30)) { const e = seen.get(r.materialId) || { m: pub(db.prepare('SELECT * FROM materials WHERE id=?').get(r.materialId)), score: 0 };
    e.score += r.score; e.snippet = e.snippet || r.content.slice(0, 160); e.page = e.page || r.pageNumber; seen.set(r.materialId, e); }
  res.json({ success: true, data: [...seen.values()].sort((a, b) => b.score - a.score) });
});

// ---- AI (RAG): retrieve -> answer only from chunks -> cite pages
async function llm(question, chunks) {
  if (!process.env.OPENAI_API_KEY) return chunks.slice(0, 3).map(c => c.content).join('\n\n');
  const ctx = chunks.map((c, i) => `[${i + 1}] ${c.title} p.${c.pageNumber}: ${c.content}`).join('\n');
  const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', messages: [
      { role: 'system', content: "Answer ONLY from the numbered excerpts. If they don't contain the answer, reply exactly: I couldn't find this information in your StudyVault materials." },
      { role: 'user', content: `Excerpts:\n${ctx}\n\nQuestion: ${question}` }] }) });
  return (await r.json()).choices[0].message.content;
}
app.post('/api/ai/ask', auth, async (req, res) => {
  const q = String(req.body.question || '').trim(); if (!q) return fail(res, 400, 'INVALID_INPUT', 'Ask a question.');
  const chunks = retrieve(req.uid, q, 5), NONE = "I couldn't find this information in your StudyVault materials.";
  if (!chunks.length) return res.json({ success: true, data: { answer: NONE, sources: [] } });
  try {
    const answer = await llm(q, chunks);
    const sources = answer.startsWith("I couldn't") ? [] : [...new Map(chunks.map(c => [c.materialId + ':' + c.pageNumber, { materialId: c.materialId, title: c.title, page: c.pageNumber }])).values()];
    res.json({ success: true, data: { answer, sources } });
  } catch { fail(res, 502, 'AI_ERROR', 'The AI service is unavailable. Please try again.'); }
});

app.get('/api/stats', auth, (req, res) => res.json({ success: true, data: {
  total: db.prepare('SELECT COUNT(*) n FROM materials WHERE userId=?').get(req.uid).n,
  processing: db.prepare("SELECT COUNT(*) n FROM materials WHERE userId=? AND status='PROCESSING'").get(req.uid).n,
  subjects: db.prepare('SELECT subject name, COUNT(*) count FROM materials WHERE userId=? GROUP BY subject').all(req.uid) } }));

app.use(express.static(path.join(__dirname, 'public')));
app.use((err, _q, res, _n) => { console.error(err); fail(res, err.code === 'LIMIT_FILE_SIZE' ? 413 : 500, 'SERVER_ERROR', err.code === 'LIMIT_FILE_SIZE' ? 'Upload failed. The file may be too large.' : 'Something went wrong. Please try again.'); });
app.listen(process.env.PORT || 3000, () => console.log('StudyVault on http://localhost:' + (process.env.PORT || 3000)));
