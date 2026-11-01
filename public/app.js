const $ = (s) => document.querySelector(s);
const app = $('#app');
let token = localStorage.getItem('token');
let me = null;
let feedMode = 'following';
let feedMood = '';
const MOODS = { masti: ['Masti', '#ff4f8b'], padhai: ['Padhai', '#6cb6ff'], gussa: ['Gussa', '#ff7a45'], chill: ['Chill', '#2dd4a7'], tagda: ['Tagda', '#ffc93c'] };
const tagify = (s) => s.replace(/(^|\s)#(\w+)/g, (m, sp, t) => `${sp}<button class="tag-link" data-tag="${t}">#${t}</button>`);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (t) => new Date(t.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

const av = (n, big) => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return `<span class="av${big ? ' big' : ''}" style="--h:${h}">${esc(n[0].toUpperCase())}<img src="/avatar/${encodeURIComponent(n)}" alt="" onerror="this.remove()"></span>`; };

let pending = null;
const shrink = (file, max = 900) => new Promise((ok, no) => {
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = img.width * k; c.height = img.height * k;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    ok(c.toDataURL('image/jpeg', 0.75));
  };
  img.onerror = () => no(new Error('Could not read that image.'));
  img.src = URL.createObjectURL(file);
});

function boom(x, y) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  ['#ff4f8b', '#ffc93c', '#2dd4a7', '#6cb6ff'].forEach((col) => {
    for (let i = 0; i < 5; i++) {
      const s = document.createElement('i');
      s.className = 'conf';
      s.style.cssText = `left:${x}px;top:${y}px;background:${col}`;
      document.body.appendChild(s);
      const a = Math.random() * 6.28, d = 50 + Math.random() * 70;
      s.animate([{ transform: 'translate(0,0) rotate(0)', opacity: 1 },
        { transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d + 40}px) rotate(${Math.random() * 540}deg)`, opacity: 0 }],
        { duration: 700 + Math.random() * 300, easing: 'ease-out' }).onfinish = () => s.remove();
    }
  });
}

async function api(url, method = 'GET', body) {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { logout(false); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// ---------- Auth ----------
function showAuth(mode = 'login') {
  $('#bar').hidden = true;
  const isLogin = mode === 'login';
  app.innerHTML = `
    <form class="card auth" id="authForm">
      <h1>Mini<br>Social</h1><span class="tag">Apni baat, apne log.</span>
      <input name="username" placeholder="Username" autocomplete="username" required>
      <input name="password" type="password" placeholder="Password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required>
      <div class="err" id="err"></div>
      <button class="primary" style="width:100%">${isLogin ? 'Log in' : 'Create account'}</button>
      <p class="muted">${isLogin ? 'New here?' : 'Already have an account?'}
        <button type="button" class="link" id="switch">${isLogin ? 'Create account' : 'Log in'}</button></p>
    </form>`;
  $('#switch').onclick = () => showAuth(isLogin ? 'register' : 'login');
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const d = await api(isLogin ? '/login' : '/register', 'POST', { username: f.get('username'), password: f.get('password') });
      token = d.token;
      localStorage.setItem('token', token);
      await start();
    } catch (err) { $('#err').textContent = err.message; }
  };
}

function logout(call = true) {
  if (call && token) api('/logout', 'POST').catch(() => {});
  token = null; me = null;
  localStorage.removeItem('token');
  showAuth();
}

// ---------- Posts ----------
function postHTML(p) {
  return `
  <article class="card" data-id="${p.id}">
    ${MOODS[p.mood] ? `<span class="sticker" style="background:${MOODS[p.mood][1]}">${MOODS[p.mood][0]}</span>` : ''}
    <div class="row">
      <button class="who" data-user="${esc(p.username)}">${av(p.username)}<span>@${esc(p.username)}</span></button>
      <span class="time">${ago(p.created_at)}</span>
    </div>
    ${p.content ? `<p class="content">${tagify(esc(p.content))}</p>` : ''}${p.image ? `<img class="pic" src="${p.image}" alt="Photo posted by @${esc(p.username)}">` : ''}
    <div class="actions">
      <button class="link like ${p.liked ? 'liked' : ''}">${p.liked ? 'Liked' : 'Like'} · ${p.likes}</button>
      <button class="link toggle-comments">Comments · ${p.comments}</button>
      ${p.username === me.username ? '<button class="link del">Delete</button>' : ''}
    </div>
    <div class="comments" hidden></div>
  </article>`;
}

async function loadComments(box, postId) {
  const list = await api(`/posts/${postId}/comments`);
  box.innerHTML = list.map((c) => `<div class="comment"><button class="who" data-user="${esc(c.username)}">@${esc(c.username)}</button> ${esc(c.content)}</div>`).join('') +
    `<form class="comment"><input placeholder="Write a comment" maxlength="200" required><button class="primary">Reply</button></form>`;
  box.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    await api(`/posts/${postId}/comments`, 'POST', { content: e.target.querySelector('input').value });
    await loadComments(box, postId);
  };
}

function wirePosts(container, reload) {
  container.onclick = async (e) => {
    const post = e.target.closest('article');
    const who = e.target.closest('[data-user]');
    try {
      if (who) return showProfile(who.dataset.user);
      const tag = e.target.closest('[data-tag]');
      if (tag) return showSearch('#' + tag.dataset.tag);
      if (!post) return;
      const id = post.dataset.id;
      if (e.target.closest('.like')) { const r = await api(`/posts/${id}/like`, 'POST'); if (r.liked) boom(e.clientX, e.clientY); reload(); }
      else if (e.target.closest('.del')) { if (confirm('Delete this post?')) { await api(`/posts/${id}`, 'DELETE'); reload(); } }
      else if (e.target.closest('.toggle-comments')) {
        const box = post.querySelector('.comments');
        box.hidden = !box.hidden;
        if (!box.hidden) await loadComments(box, id);
      }
    } catch (err) { alert(err.message); }
  };
}

function composer() {
  return `<form class="card" id="newPost">
    <textarea maxlength="280" placeholder="What's on your mind?"></textarea>
    <div class="moods">${Object.entries(MOODS).map(([k, [n, c]]) => `<label class="mood"><input type="radio" name="mood" value="${k}"><span style="--c:${c}">${n}</span></label>`).join('')}</div>
    <img id="prev" class="pic" hidden alt="Photo preview">
    <div class="row" style="margin-top:.5rem"><div class="row"><label class="btn" for="file">+ Photo</label><input id="file" type="file" accept="image/*" hidden><span class="muted" id="cnt">280 left</span></div><button class="primary">Post</button></div>
  </form>`;
}

// ---------- Views ----------
async function showFeed() {
  app.innerHTML = `${composer()}
    <div class="tabs">
      <button data-mode="following" class="${feedMode === 'following' ? 'on' : ''}">Following</button>
      <button data-mode="all" class="${feedMode === 'all' ? 'on' : ''}">Everyone</button>
    </div>
    <div class="moods" id="mf">${[['', 'All'], ...Object.entries(MOODS).map(([k, v]) => [k, v[0]])].map(([k, n]) => `<button class="chip${feedMood === k ? ' on' : ''}" data-m="${k}">${n}</button>`).join('')}</div>
    <div id="posts"></div>
    <div class="card"><b>Trending</b><div class="sugg" id="trend"></div></div>
    <div class="card"><b>People to follow</b><div class="sugg" id="sugg"></div></div>`;
  const load = async () => {
    const posts = await api('/posts?feed=' + feedMode + (feedMood ? '&mood=' + feedMood : ''));
    $('#posts').innerHTML = posts.length ? posts.map(postHTML).join('') :
      `<div class="card muted">Nothing here yet. Write a post or follow someone to fill your feed.</div>`;
  };
  $('#file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { pending = await shrink(f); $('#prev').src = pending; $('#prev').hidden = false; } catch (err) { alert(err.message); }
  };
  $('#newPost').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/posts', 'POST', { content: e.target.querySelector('textarea').value, image: pending, mood: new FormData(e.target).get('mood') }); e.target.reset(); pending = null; $('#prev').hidden = true; $('#cnt').textContent = '280 left'; load(); }
    catch (err) { alert(err.message); }
  };
  $('#mf').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) { feedMood = b.dataset.m; showFeed(); } };
  $('#newPost textarea').oninput = (e) => ($('#cnt').textContent = 280 - e.target.value.length + ' left');
  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { feedMode = b.dataset.mode; showFeed(); }));
  wirePosts($('#posts'), load);
  const sugg = await api('/suggestions');
  $('#sugg').innerHTML = sugg.length ? sugg.map((u) => `<button data-user="${esc(u.username)}">@${esc(u.username)}</button>`).join('') : '<span class="muted">You are following everyone.</span>';
  $('#sugg').onclick = (e) => { const b = e.target.closest('[data-user]'); if (b) showProfile(b.dataset.user); };
  api('/trending').then((t) => {
    $('#trend').innerHTML = t.length ? t.map((x) => `<button data-tag="${esc(x.tag.slice(1))}">${esc(x.tag)} <span class="muted">${x.n}</span></button>`).join('') : '<span class="muted">Use a #hashtag in a post to start a trend.</span>';
  }).catch(() => {});
  $('#trend').onclick = (e) => { const b = e.target.closest('[data-tag]'); if (b) showSearch('#' + b.dataset.tag); };
  load();
}

async function showProfile(username) {
  try {
    const u = await api('/users/' + encodeURIComponent(username));
    app.innerHTML = `
      <section class="card">
        <div class="row"><div class="who-big">${av(u.username, true)}<h2>@${esc(u.username)}</h2></div>
          ${u.isMe ? '' : `<button id="follow" class="${u.isFollowing ? '' : 'primary'}">${u.isFollowing ? 'Unfollow' : 'Follow'}</button>`}
        </div>
        <p id="bio" class="${u.bio ? '' : 'muted'}">${u.bio ? esc(u.bio) : 'No bio yet.'}</p>
        ${u.isMe ? '<button id="editBio">Edit bio</button> <label class="btn" for="avFile">Change photo</label><input id="avFile" type="file" accept="image/*" hidden>' : ''}
        <div class="stats"><div><b>${u.posts}</b>Posts</div><div><b>${u.followers}</b>Followers</div><div><b>${u.following}</b>Following</div></div>
      </section>
      <div id="posts"></div>`;
    const load = async () => {
      const posts = await api('/posts?user=' + encodeURIComponent(username));
      $('#posts').innerHTML = posts.length ? posts.map(postHTML).join('') : `<div class="card muted">No posts yet.</div>`;
    };
    wirePosts($('#posts'), load);
    if ($('#follow')) $('#follow').onclick = async () => { await api(`/users/${encodeURIComponent(username)}/follow`, 'POST'); showProfile(username); };
    if ($('#avFile')) $('#avFile').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { await api('/me/avatar', 'PUT', { image: await shrink(f, 240) }); showProfile(username); } catch (err) { alert(err.message); }
    };
    if ($('#editBio')) $('#editBio').onclick = async () => {
      const bio = prompt('Your bio (up to 160 characters):', u.bio);
      if (bio !== null) { await api('/me', 'PUT', { bio }); showProfile(username); }
    };
    load();
  } catch (err) { app.innerHTML = `<div class="card err">${esc(err.message)}</div>`; }
}

function showSearch(preset = '') {
  app.innerHTML = `<form class="card" id="sf"><input id="q" value="${esc(preset)}" placeholder="Search people or posts" required>
    <button class="primary" style="margin-top:.7rem">Search</button></form><div id="posts"></div>`;
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/search?q=' + encodeURIComponent($('#q').value.trim()));
      $('#posts').innerHTML =
        (r.users.length ? `<div class="card"><b>People</b><div class="sugg">${r.users.map((u) => `<button data-user="${esc(u.username)}">${av(u.username)} @${esc(u.username)}</button>`).join('')}</div></div>` : '') +
        (r.posts.length ? r.posts.map(postHTML).join('') : '<div class="card muted">No posts match that search.</div>');
    } catch (err) { alert(err.message); }
  };
  wirePosts($('#posts'), () => $('#sf').requestSubmit());
  $('#q').focus();
  if (preset) $('#sf').requestSubmit();
}

const badge = (n) => { $('#badge').textContent = n; $('#badge').hidden = !n; };
const poll = () => { if (me) api('/notifications/count').then((d) => badge(d.n)).catch(() => {}); };
setInterval(poll, 20000);

async function showNotifs() {
  try {
    const items = await api('/notifications');
    await api('/notifications/read', 'POST');
    badge(0);
    const text = { like: 'liked your post', comment: 'commented on your post', follow: 'started following you' };
    app.innerHTML = '<div id="nl">' + (items.length ? items.map((n) => `<div class="card note${n.seen ? '' : ' new'}">
      <div class="row"><span><button class="who" data-user="${esc(n.actor)}" style="display:inline-flex">${av(n.actor)}<span>@${esc(n.actor)}</span></button> ${text[n.type]}</span>
      <span class="time">${ago(n.created_at)}</span></div></div>`).join('') : '<div class="card muted">No alerts yet. Post something and people will find you.</div>') + '</div>';
    $('#nl').onclick = (e) => { const b = e.target.closest('[data-user]'); if (b) showProfile(b.dataset.user); };
  } catch (err) { alert(err.message); }
}

async function start() {
  try { me = await api('/me'); } catch { return showAuth(); }
  $('#bar').hidden = false;
  showFeed();
  poll();
}

document.querySelector('[data-go="feed"]').onclick = (e) => { e.preventDefault(); showFeed(); };
document.querySelector('nav [data-go="feed"]').onclick = showFeed;
$('#myProfile').onclick = () => showProfile(me.username);
$('#searchBtn').onclick = () => showSearch();
$('#notifBtn').onclick = showNotifs;
$('#logout').onclick = () => logout();
const setTheme = (t) => { document.documentElement.dataset.theme = t; localStorage.setItem('theme', t); $('#theme').textContent = t === 'dark' ? 'Din' : 'Raat'; };
$('#theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
setTheme(localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
token ? start() : showAuth();
