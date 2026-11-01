const express = require('express');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+, no native build needed
const crypto = require('crypto');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'social.db'));
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, bio TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS likes(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, PRIMARY KEY(user_id, post_id));
CREATE TABLE IF NOT EXISTS follows(follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(follower_id, followee_id));
`);

try { db.exec('ALTER TABLE posts ADD COLUMN image TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN avatar TEXT'); } catch {}
try { db.exec('ALTER TABLE posts ADD COLUMN mood TEXT'); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE, seen INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const verify = (pw, stored) => {
  const a = Buffer.from(hash(pw, stored.split(':')[0]));
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const fail = (res, code, error) => res.status(code).json({ error });

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const row = db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  if (!row) return fail(res, 401, 'Please log in.');
  req.user = row;
  next();
}

const notify = (to, actor, type, postId = null) => {
  if (to !== actor) db.prepare('INSERT INTO notifications(user_id, actor_id, type, post_id) VALUES(?, ?, ?, ?)').run(to, actor, type, postId);
};

// ---- Auth ----
function startSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token, user_id) VALUES(?, ?)').run(token, userId);
  return token;
}
app.post('/api/register', (req, res) => {
  const { username = '', password = '' } = req.body;
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return fail(res, 400, 'Username must be 3-20 letters, numbers or underscores.');
  if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return fail(res, 409, 'That username is taken.');
  const id = db.prepare('INSERT INTO users(username, password) VALUES(?, ?)').run(username, hash(password)).lastInsertRowid;
  res.json({ token: startSession(id), username });
});
app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !verify(password, u.password)) return fail(res, 401, 'Wrong username or password.');
  res.json({ token: startSession(u.id), username: u.username });
});
app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.headers.authorization.replace('Bearer ', ''));
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json(req.user));

// ---- Posts ----
const POST_SQL = `
SELECT p.id, p.content, p.image, p.mood, p.created_at, u.username,
  (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS likes,
  (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comments,
  EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = @me) AS liked
FROM posts p JOIN users u ON u.id = p.user_id`;

app.get('/api/posts', auth, (req, res) => {
  const me = req.user.id;
  let rows;
  if (req.query.user) {
    rows = db.prepare(POST_SQL + ' WHERE u.username = @name ORDER BY p.id DESC').all({ me, name: req.query.user });
  } else if (req.query.feed === 'following') {
    rows = db.prepare(POST_SQL + ' WHERE p.user_id = @me OR p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = @me) ORDER BY p.id DESC').all({ me });
  } else {
    rows = db.prepare(POST_SQL + ' ORDER BY p.id DESC LIMIT 100').all({ me });
  }
  if (req.query.mood) rows = rows.filter((r) => r.mood === req.query.mood);
  res.json(rows.map(r => ({ ...r, liked: !!r.liked })));
});
app.post('/api/posts', auth, (req, res) => {
  const content = (req.body.content || '').trim();
  const image = req.body.image || null;
  if (image && !(/^data:image\/(jpeg|png|webp);base64,/.test(image) && image.length < 3e6)) return fail(res, 400, 'Image must be a JPG, PNG or WebP under 2 MB.');
  if ((!content && !image) || content.length > 280) return fail(res, 400, 'Posts need text (up to 280 characters) or an image.');
  const mood = ['masti', 'padhai', 'gussa', 'chill', 'tagda'].includes(req.body.mood) ? req.body.mood : null;
  db.prepare('INSERT INTO posts(user_id, content, image, mood) VALUES(?, ?, ?, ?)').run(req.user.id, content, image, mood);
  res.json({ ok: true });
});
app.delete('/api/posts/:id', auth, (req, res) => {
  const r = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  r.changes ? res.json({ ok: true }) : fail(res, 404, 'Post not found.');
});
app.post('/api/posts/:id/like', auth, (req, res) => {
  const post = db.prepare('SELECT user_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return fail(res, 404, 'Post not found.');
  const del = db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, req.params.id);
  if (!del.changes) { db.prepare('INSERT INTO likes(user_id, post_id) VALUES(?, ?)').run(req.user.id, req.params.id); notify(post.user_id, req.user.id, 'like', req.params.id); }
  res.json({ liked: !del.changes });
});

// ---- Comments ----
app.get('/api/posts/:id/comments', auth, (req, res) => {
  res.json(db.prepare('SELECT c.id, c.content, c.created_at, u.username FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id').all(req.params.id));
});
app.post('/api/posts/:id/comments', auth, (req, res) => {
  const content = (req.body.content || '').trim();
  if (!content || content.length > 200) return fail(res, 400, 'Comments must be 1-200 characters.');
  const post = db.prepare('SELECT user_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return fail(res, 404, 'Post not found.');
  db.prepare('INSERT INTO comments(post_id, user_id, content) VALUES(?, ?, ?)').run(req.params.id, req.user.id, content);
  notify(post.user_id, req.user.id, 'comment', req.params.id);
  res.json({ ok: true });
});

// ---- Profiles & follows ----
app.get('/api/users/:username', auth, (req, res) => {
  const u = db.prepare('SELECT id, username, bio, created_at FROM users WHERE username = ?').get(req.params.username);
  if (!u) return fail(res, 404, 'User not found.');
  const n = (sql) => db.prepare(sql).get(u.id).n;
  res.json({
    ...u,
    followers: n('SELECT COUNT(*) n FROM follows WHERE followee_id = ?'),
    following: n('SELECT COUNT(*) n FROM follows WHERE follower_id = ?'),
    posts: n('SELECT COUNT(*) n FROM posts WHERE user_id = ?'),
    isFollowing: !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.user.id, u.id),
    isMe: u.id === req.user.id,
  });
});
app.put('/api/me', auth, (req, res) => {
  db.prepare('UPDATE users SET bio = ? WHERE id = ?').run((req.body.bio || '').slice(0, 160), req.user.id);
  res.json({ ok: true });
});
app.post('/api/users/:username/follow', auth, (req, res) => {
  const t = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!t) return fail(res, 404, 'User not found.');
  if (t.id === req.user.id) return fail(res, 400, "You can't follow yourself.");
  const del = db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, t.id);
  if (!del.changes) { db.prepare('INSERT INTO follows(follower_id, followee_id) VALUES(?, ?)').run(req.user.id, t.id); notify(t.id, req.user.id, 'follow'); }
  res.json({ following: !del.changes });
});
app.get('/api/suggestions', auth, (req, res) => {
  res.json(db.prepare('SELECT username FROM users WHERE id != ? AND id NOT IN (SELECT followee_id FROM follows WHERE follower_id = ?) ORDER BY id DESC LIMIT 5').all(req.user.id, req.user.id));
});

// ---- Avatar, search, notifications ----
app.put('/api/me/avatar', auth, (req, res) => {
  const image = req.body.image || '';
  if (!(/^data:image\/(jpeg|png|webp);base64,/.test(image) && image.length < 6e5)) return fail(res, 400, 'Photo must be a JPG, PNG or WebP.');
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(image, req.user.id);
  res.json({ ok: true });
});
app.get('/avatar/:username', (req, res) => {
  const u = db.prepare('SELECT avatar FROM users WHERE username = ?').get(req.params.username);
  const m = u && u.avatar && u.avatar.match(/^data:(image\/\w+);base64,(.*)$/);
  if (!m) return res.sendStatus(404);
  res.type(m[1]).set('Cache-Control', 'no-cache').send(Buffer.from(m[2], 'base64'));
});
app.get('/api/search', auth, (req, res) => {
  const q = '%' + String(req.query.q || '').trim().replace(/[\\%_]/g, '\\$&') + '%';
  const users = db.prepare("SELECT username FROM users WHERE username LIKE ? ESCAPE '\\' LIMIT 10").all(q);
  const posts = db.prepare(POST_SQL + " WHERE p.content LIKE @q ESCAPE '\\' ORDER BY p.id DESC LIMIT 50").all({ me: req.user.id, q });
  res.json({ users, posts: posts.map((r) => ({ ...r, liked: !!r.liked })) });
});
app.get('/api/notifications/count', auth, (req, res) => {
  res.json({ n: db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND seen = 0').get(req.user.id).n });
});
app.get('/api/notifications', auth, (req, res) => {
  res.json(db.prepare('SELECT n.id, n.type, n.post_id, n.seen, n.created_at, u.username AS actor FROM notifications n JOIN users u ON u.id = n.actor_id WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 50').all(req.user.id));
});
app.post('/api/notifications/read', auth, (req, res) => {
  db.prepare('UPDATE notifications SET seen = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

app.get('/api/trending', auth, (req, res) => {
  const counts = {};
  for (const { content } of db.prepare("SELECT content FROM posts WHERE content LIKE '%#%' ORDER BY id DESC LIMIT 300").all()) {
    for (const t of new Set(content.toLowerCase().match(/#\w+/g) || [])) counts[t] = (counts[t] || 0) + 1;
  }
  res.json(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([tag, n]) => ({ tag, n })));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mini Social running at http://localhost:${PORT}`));
