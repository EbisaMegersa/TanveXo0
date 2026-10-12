/* TanveXo API v16 — Code 5
   CHANGES vs v15:
   - Registration screenshots are delivered TO THE ADMIN'S TELEGRAM as a photo
     (sendPhoto multipart) with ✅ Approve / ❌ Reject inline buttons — DB stays as backup
   - /approval command (admin only) lists pending submissions as photos with buttons
   - Admin actions via inline buttons are admin-ID-verified
   - /help now shows the sender's Telegram ID (so you can copy your ADMIN_TELEGRAM_ID)
   - Nav fix was frontend-only; worker otherwise identical to v15 */

/* ================= ECONOMY CONSTANTS ================= */
const REFERRAL_REWARD = 50, WELCOME_BONUS = 25;
const AD_REWARD = 5, AD_COOLDOWN = 3, AD_MAX_PER_DAY = 25;
const WD_REQ_ADS = 25, WD_REQ_FRIENDS = 15;
const MIN_WITHDRAW = 1000;
const MAX_ACCOUNTS_PER_DEVICE = 2;
const DAY = 86400;
const EXT_LINK_MIN_STAY = 8;
const DEFAULT_CHANNEL = 'https://t.me/ebtry0';
const BOT_USERNAME = 'tanvexoappbot';
const APP_LINK = 'https://t.me/' + BOT_USERNAME + '/refer';
const TX_APP_LINK = 'https://www.tanvexoapp.com/home?invite_code=342421';
const REQ_CHANNELS = ['@ebtry0', '@ebisa_emoji'];
const STREAK_REWARDS = [10, 30, 40, 60, 70, 80, 100];
const TASK_TYPES = ['invites', 'daily', 'ads', 'link'];

const gateErr = () => ({ ok: false, gate: true, error: 'Join both channels to continue', channels: REQ_CHANNELS });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data, X-Admin-Key, X-Telegram-Bot-Api-Secret-Token',
  'Access-Control-Max-Age': '86400'
};
const j = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const now = () => Math.floor(Date.now() / 1000);
const bannedResp = row => ({ ok: false, error: (row && row.ban_reason) ? row.ban_reason : 'You are banned', locked: true });

async function run(env, sql, params) {
  const res = await env.DB.prepare(sql).bind.apply(env.DB.prepare(sql), params).run();
  return (res && res.meta && typeof res.meta.changes === 'number') ? res.meta.changes : 0;
}

/* ================= DATABASE ================= */
let dbReady = null;
function initDb(env) {
  if (!dbReady) {
    dbReady = (async () => {
      const t0 = now();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY, name TEXT, username TEXT,
        balance INTEGER NOT NULL DEFAULT 0, total_earned INTEGER NOT NULL DEFAULT 0,
        daily_streak INTEGER NOT NULL DEFAULT 0, last_daily INTEGER NOT NULL DEFAULT 0, daily_claims INTEGER NOT NULL DEFAULT 0,
        referred_by INTEGER, invited INTEGER NOT NULL DEFAULT 0,
        device_id TEXT, banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT,
        ads_watched INTEGER NOT NULL DEFAULT 0, ads_today INTEGER NOT NULL DEFAULT 0, ad_day TEXT, last_ad INTEGER NOT NULL DEFAULT 0,
        req_ads INTEGER NOT NULL DEFAULT 0, req_friends INTEGER NOT NULL DEFAULT 0, req_spins INTEGER NOT NULL DEFAULT 0,
        welcome INTEGER NOT NULL DEFAULT 0, migrated INTEGER NOT NULL DEFAULT 0, channel_ok INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS referrals (
        referrer INTEGER NOT NULL, user_id INTEGER PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, type TEXT NOT NULL,
        reward INTEGER NOT NULL, goal INTEGER NOT NULL DEFAULT 1, link TEXT,
        active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS task_claims (
        user_id INTEGER NOT NULL, task_id INTEGER NOT NULL, claimed_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, task_id)
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS task_clicks (
        user_id INTEGER NOT NULL, task_id INTEGER NOT NULL, clicked_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, task_id)
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT,
        amount INTEGER NOT NULL, method TEXT NOT NULL, address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, processed_at INTEGER
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        type TEXT NOT NULL, title TEXT NOT NULL, amount INTEGER NOT NULL, created_at INTEGER NOT NULL
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, message TEXT NOT NULL,
        stars INTEGER NOT NULL DEFAULT 5, created_at INTEGER NOT NULL
      )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tx_registrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT,
        contact TEXT NOT NULL, screenshot TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL, processed_at INTEGER
      )`).run();
      const alters = [
        'ALTER TABLE users ADD COLUMN device_id TEXT',
        'ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN ban_reason TEXT',
        'ALTER TABLE users ADD COLUMN last_spin INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN ads_watched INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN ads_today INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN ad_day TEXT',
        'ALTER TABLE users ADD COLUMN last_ad INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN spins INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN req_ads INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN req_friends INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN req_spins INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN welcome INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN migrated INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE users ADD COLUMN channel_ok INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE referrals ADD COLUMN photo TEXT',
        "ALTER TABLE referrals ADD COLUMN status TEXT DEFAULT 'pending'"
      ];
      for (const a of alters) { try { await env.DB.prepare(a).run(); } catch (e) {} }
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks').first();
      if (!c || c.n === 0) {
        const seed = [
          ['Invite your first friend', 'invites', 250, 1],
          ['Invite 5 friends', 'invites', 1000, 5],
          ['Watch your first ad', 'ads', 50, 1],
          ['Watch 10 ads', 'ads', 300, 10],
          ['Claim a daily bonus', 'daily', 25, 1],
          ['Join our Channel', 'link', 50, 1]
        ];
        for (let i = 0; i < seed.length; i++) {
          await env.DB.prepare('INSERT INTO tasks (title,type,reward,goal,link,active,created_at) VALUES (?,?,?,?,?,1,?)')
            .bind(seed[i][0], seed[i][1], seed[i][2], seed[i][3], seed[i][1] === 'link' ? DEFAULT_CHANNEL : null, t0).run();
        }
      } else {
        try { await env.DB.prepare("UPDATE tasks SET active = 0 WHERE type IN ('taps','boost')").run(); } catch (e) {}
        try { await env.DB.prepare("UPDATE tasks SET link = ? WHERE type = 'link' AND (link IS NULL OR link = '')").bind(DEFAULT_CHANNEL).run(); } catch (e) {}
      }
    })().catch(e => { dbReady = null; throw e; });
  }
  return dbReady;
}

/* ================= AUTH ================= */
async function verifyInitData(initData, botToken) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash || !botToken) return null;
    p.delete('hash');
    const check = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
    const enc = new TextEncoder();
    const k1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secret = await crypto.subtle.sign('HMAC', k1, enc.encode(botToken));
    const k2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', k2, enc.encode(check));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
    if (hex !== hash) return null;
    const ad = parseInt(p.get('auth_date') || '0', 10);
    if (!ad || now() - ad > 86400) return null;
    const u = JSON.parse(p.get('user') || 'null');
    return u && u.id ? u : null;
  } catch (e) { return null; }
}

/* ================= TELEGRAM BOT API ================= */
async function botCall(env, method, params) {
  if (!env.BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN not set' };
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {})
    });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e && e.message || e) }; }
}

/* Code 5: multipart sendPhoto — sends a base64 screenshot as a real photo */
async function botSendPhotoB64(env, chatId, dataUrl, caption, keyboard) {
  if (!env.BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN not set' };
  try {
    const m = String(dataUrl || '').match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (!m) return { ok: false, description: 'Invalid image data' };
    const mime = m[1];
    const ext = mime.includes('png') ? 'png' : 'jpg';
    const b64 = m[2].replace(/\s/g, '');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append('photo', new Blob([bytes], { type: mime }), 'proof.' + ext);
    fd.append('caption', String(caption || '').slice(0, 1024));
    if (keyboard) fd.append('reply_markup', JSON.stringify({ inline_keyboard: keyboard }));
    const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendPhoto', { method: 'POST', body: fd });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e && e.message || e) }; }
}

function extractChat(link) {
  if (!link) return null;
  const s = String(link).trim();
  if (/^@?[A-Za-z][A-Za-z0-9_]{2,}$/.test(s)) return s.charAt(0) === '@' ? s : '@' + s;
  if (/^-100?\d+$/.test(s)) return s;
  const m = s.match(/t\.me\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{2,})(?:[/?#]|$)/i);
  if (m && !/^joinchat$/i.test(m[1])) return '@' + m[1];
  return null;
}
function isTelegramLink(link) { return !!link && /t\.me\//i.test(String(link)); }

const MEMBER_STATUSES = ['creator', 'administrator', 'member', 'restricted'];
async function isMember(env, chat, userId) {
  const r = await botCall(env, 'getChatMember', { chat_id: chat, user_id: userId });
  if (!r || r.ok !== true) {
    const d = (r && r.description) || '';
    if (/administrator|rights|admin|not a member of the channel/i.test(d))
      return { ok: false, error: 'Setup error: add the bot as admin in ' + chat, setup: true };
    return { ok: false, error: 'Could not verify — try again in a moment' };
  }
  const m = r.result || {};
  if (m.status === 'restricted') return { ok: m.is_member === true };
  return { ok: MEMBER_STATUSES.includes(m.status) };
}
async function joinedAllChannels(env, userId) {
  for (const ch of REQ_CHANNELS) {
    const v = await isMember(env, ch, userId);
    if (!v.ok) return { ok: false, channel: ch };
  }
  return { ok: true };
}

/* ================= DB HELPERS ================= */
async function getRow(env, id) {
  const r = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?').bind(id).first();
  return r || null;
}
async function friendsOf(env, id) {
  const { results } = await env.DB.prepare('SELECT name, photo, status, created_at FROM referrals WHERE referrer = ? ORDER BY created_at DESC LIMIT 100').bind(id).all();
  return (results || []).map(r => ({ name: r.name || 'Friend', photo: r.photo || null, status: r.status || 'verified', ts: r.created_at * 1000 }));
}
async function claimsOf(env, id) {
  const { results } = await env.DB.prepare('SELECT task_id FROM task_claims WHERE user_id = ?').bind(id).all();
  return (results || []).map(r => r.task_id);
}
async function withdrawalsOf(env, id) {
  const { results } = await env.DB.prepare('SELECT id, amount, method, address, status, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(id).all();
  return (results || []).map(r => ({ id: r.id, amount: r.amount, method: r.method, address: r.address, status: r.status, ts: r.created_at * 1000 }));
}
async function actsOf(env, id) {
  const { results } = await env.DB.prepare('SELECT type, title, amount, created_at FROM activities WHERE user_id = ? ORDER BY id DESC LIMIT 15').bind(id).all();
  return (results || []).map(r => ({ type: r.type, title: r.title, amount: r.amount, ts: r.created_at * 1000 }));
}
async function reviewsOf(env) {
  const { results } = await env.DB.prepare('SELECT id, name, message, stars, created_at FROM reviews ORDER BY id DESC LIMIT 15').all();
  return (results || []).map(r => ({ id: r.id, name: r.name, message: r.message, stars: r.stars, ts: r.created_at * 1000 }));
}
async function txMineOf(env, uid) {
  const r = await env.DB.prepare('SELECT id, contact, status, created_at, processed_at FROM tx_registrations WHERE user_id = ? ORDER BY id DESC LIMIT 1').bind(uid).first();
  return r ? { id: r.id, contact: r.contact, status: r.status, ts: r.created_at * 1000 } : null;
}
async function pruneUser(env, uid) {
  if (Math.random() > 0.05) return;
  try {
    await env.DB.prepare('DELETE FROM activities WHERE user_id = ? AND id NOT IN (SELECT id FROM activities WHERE user_id = ? ORDER BY id DESC LIMIT 30)').bind(uid, uid).run();
  } catch (e) {}
}
async function logAct(env, uid, type, title, amount) {
  try {
    await env.DB.prepare('INSERT INTO activities (user_id, type, title, amount, created_at) VALUES (?,?,?,?,?)').bind(uid, type, title, amount, now()).run();
    pruneUser(env, uid);
  } catch (e) {}
}
async function saveRow(env, row) {
  await env.DB.prepare(`UPDATE users SET name=?, username=?, balance=?, total_earned=?,
    daily_streak=?, last_daily=?, daily_claims=?, invited=?,
    device_id=?, banned=?, ban_reason=?,
    ads_watched=?, ads_today=?, ad_day=?, last_ad=?,
    req_ads=?, req_friends=?, req_spins=?, welcome=?, updated_at=? WHERE user_id=?`)
    .bind(row.name, row.username, row.balance, row.total_earned,
      row.daily_streak, row.last_daily, row.daily_claims, row.invited,
      row.device_id || null, row.banned ? 1 : 0, row.ban_reason || null,
      row.ads_watched || 0, row.ads_today || 0, row.ad_day || null, row.last_ad || 0,
      row.req_ads || 0, row.req_friends || 0, row.req_spins || 0, row.welcome ? 1 : 0,
      now(), row.user_id).run();
}
function toClient(row, friends, claimed, txMine) {
  return {
    balance: row.balance, totalEarned: row.total_earned,
    referrals: row.invited, friends: friends || [],
    dailyStreak: row.daily_streak, lastDaily: row.last_daily * 1000, dailyClaims: row.daily_claims,
    tasksClaimed: claimed || [],
    adsWatched: row.ads_watched || 0, adsToday: row.ads_today || 0, lastAd: (row.last_ad || 0) * 1000,
    reqAds: row.req_ads || 0, reqFriends: row.req_friends || 0,
    txRegistration: txMine || null,
    activities: row._acts || []
  };
}

/* ================= USERS ================= */
async function ensureUser(env, u, refId, dev) {
  const t = now();
  let row = await getRow(env, u.id);
  if (row) return row;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Player';
  let lockDev = false;
  if (dev) {
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE device_id = ?').bind(dev).first();
    if (c && c.n >= MAX_ACCOUNTS_PER_DEVICE) lockDev = true;
  }
  await env.DB.prepare(`INSERT OR IGNORE INTO users (user_id, name, username, device_id, banned, ban_reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.id, name, u.username || null, dev || null,
      lockDev ? 1 : 0,
      lockDev ? 'Device limit reached — max ' + MAX_ACCOUNTS_PER_DEVICE + ' accounts per device' : null, t, t).run();
  row = await getRow(env, u.id);
  if (row && !row.banned && refId && refId !== u.id) {
    const exists = await env.DB.prepare('SELECT user_id FROM referrals WHERE user_id = ?').bind(u.id).first();
    if (!exists && !row.referred_by) {
      const referrer = await getRow(env, refId);
      if (referrer && !referrer.banned) {
        await env.DB.prepare("INSERT OR IGNORE INTO referrals (referrer, user_id, name, photo, status, created_at) VALUES (?,?,?,?, 'pending', ?)")
          .bind(refId, u.id, name, u.photo_url || null, t).run();
        await env.DB.prepare('UPDATE users SET referred_by=? WHERE user_id=?').bind(refId, u.id).run();
        row.referred_by = refId;
      }
    }
  }
  if (row) await saveRow(env, row);
  return row;
}

async function verifyReferral(env, friendId) {
  const row = await getRow(env, friendId);
  if (!row || !row.referred_by) return { ok: true, nothing: true };
  const claimed = await run(env, "UPDATE referrals SET status='verified' WHERE user_id = ? AND status = 'pending'", [friendId]);
  if (claimed === 0) return { ok: true, already: true };
  const gate = await joinedAllChannels(env, friendId);
  if (!gate.ok) {
    await run(env, "UPDATE referrals SET status='pending' WHERE user_id = ?", [friendId]);
    return { ok: false, channel: gate.channel };
  }
  await run(env,
    `UPDATE users SET balance = balance + ?, total_earned = total_earned + ?,
       invited = invited + 1, req_friends = req_friends + 1, updated_at = ?
     WHERE user_id = ?`,
    [REFERRAL_REWARD, REFERRAL_REWARD, now(), row.referred_by]);
  await logAct(env, row.referred_by, 'ref', 'Friend joined: ' + row.name, REFERRAL_REWARD);
  const w = await run(env,
    `UPDATE users SET balance = balance + ?, total_earned = total_earned + ?, welcome = 1, updated_at = ?
     WHERE user_id = ? AND welcome = 0`,
    [WELCOME_BONUS, WELCOME_BONUS, now(), friendId]);
  if (w > 0) await logAct(env, friendId, 'bonus', 'Welcome bonus', WELCOME_BONUS);
  return { ok: true };
}

async function passGate(env, userId) {
  const gate = await joinedAllChannels(env, userId);
  if (!gate.ok) return { ok: false, channel: gate.channel };
  await env.DB.prepare('UPDATE users SET channel_ok=1 WHERE user_id=?').bind(userId).run();
  await verifyReferral(env, userId);
  return { ok: true };
}

/* ================= USER API ================= */
async function apiInit(env, tgUser, body) {
  const dev = (body && body.dev) ? String(body.dev).slice(0, 64) : null;
  const ref = parseInt(body && body.ref, 10) || null;
  let row = await ensureUser(env, tgUser, ref, dev);
  if (!row) return { ok: false, error: 'Could not create user' };
  if (row.banned) return bannedResp(row);
  if (!row.channel_ok) {
    const g = await passGate(env, tgUser.id);
    if (!g.ok) return gateErr();
    row = await getRow(env, tgUser.id);
  }
  row._acts = await actsOf(env, tgUser.id);
  return { ok: true, txLink: TX_APP_LINK, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await txMineOf(env, tgUser.id)) };
}

async function apiVerifyChannels(env, tgUser) {
  let row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  if (!row.channel_ok) {
    const g = await passGate(env, tgUser.id);
    if (!g.ok) return gateErr();
    row = await getRow(env, tgUser.id);
  }
  row._acts = await actsOf(env, tgUser.id);
  return { ok: true, txLink: TX_APP_LINK, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await txMineOf(env, tgUser.id)) };
}

async function apiSync(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found — reopen the app' };
  if (row.banned) return bannedResp(row);
  if (!row.channel_ok) return gateErr();
  const day = new Date().toISOString().slice(0, 10);
  if (row.ad_day !== day) {
    await run(env, 'UPDATE users SET ads_today = 0, ad_day = ? WHERE user_id = ? AND (ad_day IS NULL OR ad_day != ?)', [day, tgUser.id, day]);
    row.ads_today = 0; row.ad_day = day;
  }
  row._acts = await actsOf(env, tgUser.id);
  return { ok: true, txLink: TX_APP_LINK, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await txMineOf(env, tgUser.id)) };
}

async function apiDaily(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  if (!row.channel_ok) return gateErr();
  const t = now();
  if (t - row.last_daily < DAY) return { ok: false, error: 'Already claimed — come back tomorrow' };
  const newStreak = (row.last_daily > 0 && t - row.last_daily < 2 * DAY)
    ? (row.daily_streak >= STREAK_REWARDS.length ? 1 : row.daily_streak + 1) : 1;
  const reward = STREAK_REWARDS[newStreak - 1];
  const changes = await run(env,
    `UPDATE users SET balance = balance + ?, total_earned = total_earned + ?,
       daily_streak = ?, daily_claims = daily_claims + 1, last_daily = ?, updated_at = ?
     WHERE user_id = ? AND last_daily = ?`,
    [reward, reward, newStreak, t, t, tgUser.id, row.last_daily]);
  if (changes === 0) return { ok: false, error: 'Already claimed — come back tomorrow' };
  await logAct(env, tgUser.id, 'daily', 'Daily check-in — day ' + newStreak, reward);
  const fresh = await getRow(env, tgUser.id);
  fresh._acts = await actsOf(env, tgUser.id);
  return { ok: true, reward, state: toClient(fresh, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await txMineOf(env, tgUser.id)) };
}

function dynProgress(row, t) {
  switch (t.type) {
    case 'invites': return row.invited;
    case 'daily': return row.daily_claims;
    case 'ads': return row.ads_watched;
    default: return 0;
  }
}
async function apiTasks(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  const { results } = await env.DB.prepare('SELECT id, title, type, reward, goal, link FROM tasks WHERE active = 1 ORDER BY id').all();
  return { ok: true, tasks: results || [] };
}
async function apiTask(env, tgUser, body) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  if (!row.channel_ok) return gateErr();
  const id = parseInt(body.id, 10);
  const t = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  if (!t || !t.active) return { ok: false, error: 'Task not found' };

  if (t.type === 'link') {
    if (body.click) {
      await env.DB.prepare('INSERT OR REPLACE INTO task_clicks (user_id, task_id, clicked_at) VALUES (?,?,?)')
        .bind(tgUser.id, id, now()).run();
      return { ok: true, clicked: true };
    }
    if (isTelegramLink(t.link)) {
      const chat = extractChat(t.link);
      if (!chat) return { ok: false, error: 'Admin: this task needs a public t.me link', notJoined: true };
      const v = await isMember(env, chat, tgUser.id);
      if (!v.ok) return { ok: false, error: v.error || 'You must join the channel first', notJoined: true, setup: !!v.setup };
    } else {
      const click = await env.DB.prepare('SELECT clicked_at FROM task_clicks WHERE user_id = ? AND task_id = ?').bind(tgUser.id, id).first();
      if (!click) return { ok: false, error: 'Tap Start and visit the link first', notJoined: true };
      if (now() - click.clicked_at < EXT_LINK_MIN_STAY)
        return { ok: false, error: 'Stay on the page a few seconds, then tap Verify', notJoined: true };
    }
  } else if (dynProgress(row, t) < t.goal) {
    return { ok: false, error: 'Task not finished yet' };
  }

  const ins = await run(env, 'INSERT OR IGNORE INTO task_claims (user_id, task_id, claimed_at) VALUES (?,?,?)', [tgUser.id, id, now()]);
  if (ins === 0) return { ok: false, error: 'Already claimed' };
  await run(env,
    'UPDATE users SET balance = balance + ?, total_earned = total_earned + ?, updated_at = ? WHERE user_id = ?',
    [t.reward, t.reward, now(), tgUser.id]);
  await logAct(env, tgUser.id, 'task', t.title, t.reward);
  const fresh = await getRow(env, tgUser.id);
  fresh._acts = await actsOf(env, tgUser.id);
  return { ok: true, reward: t.reward, state: toClient(fresh, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await txMineOf(env, tgUser.id)) };
}

async function apiAd(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  if (!row.channel_ok) return gateErr();
  const t = now();
  const day = new Date().toISOString().slice(0, 10);
  await run(env, 'UPDATE users SET ads_today = 0, ad_day = ? WHERE user_id = ? AND (ad_day IS NULL OR ad_day != ?)', [day, tgUser.id, day]);
  const changes = await run(env,
    `UPDATE users SET
       balance = balance + ?, total_earned = total_earned + ?,
       ads_watched = ads_watched + 1, ads_today = ads_today + 1,
       last_ad = ?, req_ads = req_ads + 1, updated_at = ?
     WHERE user_id = ? AND ads_today < ? AND (? - COALESCE(last_ad, 0)) >= ?`,
    [AD_REWARD, AD_REWARD, t, t, tgUser.id, AD_MAX_PER_DAY, t, AD_COOLDOWN]);
  if (changes === 0) {
    const fresh = await getRow(env, tgUser.id);
    if (fresh.ads_today >= AD_MAX_PER_DAY)
      return { ok: false, error: 'Daily ad limit reached (' + AD_MAX_PER_DAY + '/day) — come back tomorrow' };
    const wait = AD_COOLDOWN - (t - (fresh.last_ad || 0));
    return { ok: false, error: wait > 0 ? ('Next ad in ' + wait + 's') : 'Try again in a moment' };
  }
  await logAct(env, tgUser.id, 'ad', 'Ad Watch Reward', AD_REWARD);
  const fresh = await getRow(env, tgUser.id);
  fresh._acts = await actsOf(env, tgUser.id);
  return { ok: true, reward: AD_REWARD, state: toClient(fresh, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await txMineOf(env, tgUser.id)) };
}

async function apiReviews(env) {
  return { ok: true, reviews: await reviewsOf(env) };
}

/* ================= TANVEXO REGISTRATION (Code 5: delivers photo to admin TG) ================= */
function validContact(s) {
  const v = String(s || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return v;
  const digits = v.replace(/[^\d]/g, '');
  if (digits.length >= 7 && digits.length <= 15) return v;
  return null;
}
async function apiTxRegister(env, tgUser, body) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  if (!row.channel_ok) return gateErr();
  const contact = validContact(body.contact);
  const screenshot = String(body.screenshot || '').trim();
  if (!contact) return { ok: false, error: 'Please enter a valid email or phone number', field: 'contact' };
  if (!screenshot || screenshot.length < 10) return { ok: false, error: 'Please attach the registration screenshot', field: 'screenshot' };
  const open = await env.DB.prepare("SELECT id FROM tx_registrations WHERE user_id = ? AND status = 'pending'").bind(tgUser.id).first();
  if (open) return { ok: false, error: 'You already have a pending submission — wait for review' };
  const t = now();
  const r = await env.DB.prepare('INSERT INTO tx_registrations (user_id, name, contact, screenshot, status, created_at) VALUES (?,?,?,?, \'pending\', ?)')
    .bind(tgUser.id, row.name, contact, screenshot, t).run();
  const newId = (r && r.meta && r.meta.last_row_id) ? r.meta.last_row_id : null;
  if (!newId) return { ok: false, error: 'Could not submit — try again' };
  await logAct(env, tgUser.id, 'tx', 'TanveXo registration submitted', 0);
  /* Code 5: deliver the screenshot to the admin's Telegram with action buttons */
  let delivered = false;
  if (env.ADMIN_TELEGRAM_ID) {
    const cap = '🆕 TanveXo registration #' + newId +
      '\n👤 ' + (row.name || 'Player') + ' (ID: ' + tgUser.id + ')' +
      '\n📧 ' + contact +
      '\n🕐 ' + new Date(t * 1000).toLocaleString('en') +
      '\n\nApprove or reject:';
    const kb = [[
      { text: '✅ Approve', callback_data: 'txpaid_' + newId },
      { text: '❌ Reject', callback_data: 'txrej_' + newId }
    ]];
    const sent = await botSendPhotoB64(env, env.ADMIN_TELEGRAM_ID, screenshot, cap, kb);
    delivered = !!(sent && sent.ok);
  }
  return { ok: true, delivered: delivered, txRegistration: { id: newId, contact: contact, status: 'pending', ts: t * 1000 } };
}
async function apiTxMine(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  return { ok: true, txRegistration: await txMineOf(env, tgUser.id) };
}

/* ================= WITHDRAW ================= */
async function apiWithdraw(env, tgUser, body) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  if (!row.channel_ok) return gateErr();
  const amount = Math.floor(parseInt(body.amount, 10) || 0);
  const method = String(body.method || '').trim().slice(0, 40);
  const address = String(body.address || '').trim().slice(0, 120);
  if (!method) return { ok: false, error: 'Choose a withdrawal method' };
  if (address.length < 4) return { ok: false, error: 'Enter your account details' };
  if (!amount || amount < MIN_WITHDRAW) return { ok: false, error: 'Minimum withdrawal is ' + MIN_WITHDRAW + ' ETB' };
  if (amount > row.balance) return { ok: false, error: 'Not enough ETB' };
  if ((row.req_ads || 0) < WD_REQ_ADS || (row.req_friends || 0) < WD_REQ_FRIENDS)
    return { ok: false, error: 'Withdrawals locked — meet the requirements first (Wallet)' };
  const t = now();
  const deduct = env.DB.prepare(
    `UPDATE users SET balance = balance - ?,
       req_ads = MAX(0, req_ads - ?), req_friends = MAX(0, req_friends - ?), updated_at = ?
     WHERE user_id = ? AND balance >= ? AND req_ads >= ? AND req_friends >= ?`
  ).bind(amount, WD_REQ_ADS, WD_REQ_FRIENDS, t, tgUser.id, amount, WD_REQ_ADS, WD_REQ_FRIENDS);
  const ins = env.DB.prepare(
    "INSERT INTO withdrawals (user_id, name, amount, method, address, status, created_at) VALUES (?,?,?,?,?, 'pending', ?)"
  ).bind(tgUser.id, row.name, amount, method, address, t);
  const results = await env.DB.batch([deduct, ins]);
  const okChanges = results && results[0] && results[0].meta && results[0].meta.changes === 1;
  if (!okChanges) {
    const fresh = await getRow(env, tgUser.id);
    if (!fresh) return { ok: false, error: 'User not found' };
    if (amount > fresh.balance) return { ok: false, error: 'Not enough ETB' };
    return { ok: false, error: 'Withdrawals locked — meet the requirements first (Wallet)' };
  }
  await logAct(env, tgUser.id, 'wd', 'Withdrawal — ' + method, -amount);
  const fresh = await getRow(env, tgUser.id);
  fresh._acts = await actsOf(env, tgUser.id);
  return { ok: true, state: toClient(fresh, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id), await txMineOf(env, tgUser.id)) };
}
async function apiWithdrawals(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  return { ok: true, withdrawals: await withdrawalsOf(env, tgUser.id) };
}

/* ================= WEBHOOK ================= */
function esc(s){ return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function isAdminTg(env, tgId) {
  return !!env.ADMIN_TELEGRAM_ID && String(tgId) === String(env.ADMIN_TELEGRAM_ID);
}
async function reply(env, chatId, text, keyboard) {
  const params = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) params.reply_markup = { inline_keyboard: keyboard };
  return botCall(env, 'sendMessage', params);
}
/* send a stored submission (photo + buttons) to the admin chat */
async function sendSubmissionToAdmin(env, sub) {
  const cap = '🆕 TanveXo registration #' + sub.id +
    '\n👤 ' + (sub.name || 'Player') + ' (ID: ' + sub.user_id + ')' +
    '\n📧 ' + sub.contact +
    '\n🕐 ' + new Date(sub.created_at * 1000).toLocaleString('en') +
    '\n\nApprove or reject:';
  const kb = [[
    { text: '✅ Approve', callback_data: 'txpaid_' + sub.id },
    { text: '❌ Reject', callback_data: 'txrej_' + sub.id }
  ]];
  return botSendPhotoB64(env, env.ADMIN_TELEGRAM_ID, sub.screenshot, cap, kb);
}
/* shared approve/reject logic (used by inline buttons AND admin panel is separate) */
async function txProcess(env, id, action) {
  const r = await env.DB.prepare('SELECT * FROM tx_registrations WHERE id = ?').bind(id).first();
  if (!r) return { ok: false, msg: 'Submission not found' };
  if (r.status !== 'pending') return { ok: false, msg: 'Already processed (' + r.status + ')' };
  const t = now();
  if (action === 'paid') {
    await env.DB.prepare("UPDATE tx_registrations SET status = 'paid', processed_at = ? WHERE id = ?").bind(t, id).run();
    return { ok: true, msg: '✅ Registration #' + id + ' approved' };
  }
  if (action === 'reject') {
    await env.DB.prepare("UPDATE tx_registrations SET status = 'rejected', processed_at = ? WHERE id = ?").bind(t, id).run();
    return { ok: true, msg: '❌ Registration #' + id + ' rejected' };
  }
  return { ok: false, msg: 'Unknown action' };
}
async function handleWebhook(env, update) {
  try {
    /* inline button presses (Approve / Reject on the photo) */
    if (update.callback_query) {
      const cq = update.callback_query;
      if (!cq.from) return;
      const data = String(cq.data || '');
      if (data === 'verify') {
        const g = await passGate(env, cq.from.id);
        if (g && g.ok) {
          await botCall(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: '✅ Verified! Welcome to TanveXo' });
          if (cq.message && cq.message.chat) {
            await reply(env, cq.message.chat.id,
              '✅ <b>Verified!</b>\n\nWelcome to TanveXo — let\'s earn together!',
              [[{ text: '🎮 Open TanveXo', url: APP_LINK }]]);
          }
        } else {
          await botCall(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: '❌ You haven\'t joined both channels yet', show_alert: true });
        }
        return;
      }
      /* Code 5: registration approve/reject buttons — admin only */
      if (data.indexOf('txpaid_') === 0 || data.indexOf('txrej_') === 0) {
        if (!isAdminTg(env, cq.from.id)) {
          await botCall(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: '⛔ Admins only', show_alert: true });
          return;
        }
        const id = parseInt(data.split('_')[1], 10);
        const action = data.indexOf('txpaid_') === 0 ? 'paid' : 'reject';
        const res = await txProcess(env, id, action);
        await botCall(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: res.ok ? res.msg : res.msg, show_alert: !res.ok });
        if (res.ok && cq.message && cq.message.chat) {
          /* remove the buttons so it can't be double-pressed */
          try {
            await botCall(env, 'editMessageReplyMarkup', {
              chat_id: cq.message.chat.id, message_id: cq.message.message_id,
              reply_markup: { inline_keyboard: [[{ text: res.msg, callback_data: 'noop' }]] }
            });
          } catch (e) {}
        }
        return;
      }
      if (data === 'noop') {
        await botCall(env, 'answerCallbackQuery', { callback_query_id: cq.id });
        return;
      }
      return;
    }
    const msg = update.message || update.edited_message;
    if (!msg || !msg.from || !msg.text) return;
    const chatId = msg.chat.id;
    const parts = msg.text.trim().split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase();
    const payload = parts[1] || '';
    if (cmd === '/start') {
      const m = String(payload).match(/ref[_-]?(\d+)/i);
      const refId = m ? parseInt(m[1], 10) : null;
      await ensureUser(env, msg.from, refId, null);
      const row = await getRow(env, msg.from.id);
      if (row && !row.channel_ok && !row.banned) {
        const kb = REQ_CHANNELS.map(h => [{ text: '📢 Join ' + h, url: 'https://t.me/' + h.slice(1) }]);
        kb.push([{ text: '✅ I joined — Verify', callback_data: 'verify' }]);
        await reply(env, chatId,
          '👋 Welcome to <b>TanveXo</b>, ' + esc(msg.from.first_name) + '!\n\n📢 Join both channels to unlock the app — required for everyone.\n\n(Invited? Your <b>+' + WELCOME_BONUS + ' ETB</b> welcome bonus unlocks right after.)', kb);
        return;
      }
      await reply(env, chatId,
        '👋 Welcome to <b>TanveXo</b>!\n\n👥 Invite friends — earn <b>' + REFERRAL_REWARD + ' ETB</b> each\n📺 Watch ads · ✅ Tasks · 💸 Withdraw\n\nTap below to start!',
        [[{ text: '🎮 Open TanveXo', url: APP_LINK }]]);
    } else if (cmd === '/balance') {
      const row = await getRow(env, msg.from.id);
      if (!row) await reply(env, chatId, 'You don\'t have an account yet — open the app first!', [[{ text: '🎮 Open TanveXo', url: APP_LINK }]]);
      else await reply(env, chatId, '💰 <b>' + esc(row.name) + '</b>\n\nBalance: <b>' + row.balance + ' ETB</b>\nFriends invited: <b>' + row.invited + '</b>\nAds watched: <b>' + (row.ads_watched || 0) + '</b>');
    } else if (cmd === '/help') {
      /* shows your ID — copy it into the ADMIN_TELEGRAM_ID secret */
      await reply(env, chatId,
        '<b>TanveXo commands:</b>\n/start — open the app\n/balance — check your ETB\n/approval — (admin) pending registrations\n\n🆔 Your Telegram ID: <code>' + msg.from.id + '</code>');
    } else if (cmd === '/approval') {
      /* Code 5: admin lists pending submissions as photos with buttons */
      if (!isAdminTg(env, msg.from.id)) {
        await reply(env, chatId, '⛔ Admins only.');
        return;
      }
      if (!env.ADMIN_TELEGRAM_ID) {
        await reply(env, chatId, '⚠️ Set the <b>ADMIN_TELEGRAM_ID</b> secret in the Worker settings first.');
        return;
      }
      const { results } = await env.DB.prepare("SELECT * FROM tx_registrations WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5").all();
      if (!results || !results.length) {
        await reply(env, chatId, '✅ No pending registrations.');
        return;
      }
      await reply(env, chatId, '📋 <b>' + results.length + ' pending registration(s):</b>');
      for (const sub of results) {
        const sent = await sendSubmissionToAdmin(env, sub);
        if (!sent || !sent.ok) {
          /* photo failed (too large etc.) — fall back to text card with buttons */
          await reply(env, chatId,
            '🆕 Registration #' + sub.id + '\n👤 ' + esc(sub.name) + ' (ID: ' + sub.user_id + ')\n📧 ' + esc(sub.contact) +
            '\n\n⚠️ Photo could not be sent — check it in the admin panel.',
            [[
              { text: '✅ Approve', callback_data: 'txpaid_' + sub.id },
              { text: '❌ Reject', callback_data: 'txrej_' + sub.id }
            ]]);
        }
      }
    } else {
      await reply(env, chatId, 'Tap /start to open TanveXo 🎮');
    }
  } catch (e) { /* never crash the webhook */ }
}

/* ================= ADMIN ================= */
function adminOk(request, env) {
  const key = request.headers.get('X-Admin-Key') || '';
  return !!env.ADMIN_PASSWORD && key.length > 0 && key === env.ADMIN_PASSWORD;
}
async function adminStats(env) {
  const agg = await env.DB.prepare('SELECT COUNT(*) AS users, COALESCE(SUM(balance),0) AS coins, COALESCE(SUM(total_earned),0) AS earned, COALESCE(SUM(invited),0) AS invites, COALESCE(SUM(ads_watched),0) AS ads FROM users').first();
  const nd = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at > ?').bind(now() - 86400).first();
  const top = await env.DB.prepare('SELECT user_id, name, balance, invited, banned, device_id, created_at FROM users ORDER BY balance DESC LIMIT 25').all();
  const recent = await env.DB.prepare('SELECT user_id, name, balance, invited, banned, device_id, created_at FROM users ORDER BY created_at DESC LIMIT 25').all();
  const tasks = await env.DB.prepare('SELECT * FROM tasks ORDER BY id').all();
  const wds = await env.DB.prepare("SELECT * FROM withdrawals ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 50").all();
  const pend = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM withdrawals WHERE status = 'pending'").first();
  const revs = await env.DB.prepare('SELECT * FROM reviews ORDER BY id DESC LIMIT 20').all();
  const txs = await env.DB.prepare("SELECT * FROM tx_registrations ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 50").all();
  const txPend = await env.DB.prepare("SELECT COUNT(*) AS n FROM tx_registrations WHERE status = 'pending'").first();
  return { ok: true,
    stats: { users: agg.users, coins: agg.coins, earned: agg.earned, taps: agg.ads || 0, invites: agg.invites, new24: nd ? nd.n : 0 },
    pendingWd: { n: pend ? pend.n : 0, amt: pend ? pend.amt : 0 },
    pendingTx: txPend ? txPend.n : 0,
    top: top.results || [], recent: recent.results || [],
    tasks: tasks.results || [], withdrawals: wds.results || [],
    reviews: revs.results || [],
    txRegistrations: txs.results || [] };
}
async function adminTxAction(env, body) {
  const id = parseInt(body.id, 10);
  if (!id) return { ok: false, error: 'Registration id required' };
  const res = await txProcess(env, id, body.action === 'delete' ? 'delete' : body.action);
  if (body.action === 'delete') {
    await env.DB.prepare('DELETE FROM tx_registrations WHERE id = ?').bind(id).run();
    return { ok: true, result: 'deleted' };
  }
  if (!res.ok) return { ok: false, error: res.msg };
  return { ok: true, result: body.action };
}
async function adminReviewAction(env, body) {
  const t = now();
  if (body.action === 'add') {
    const name = String(body.name || '').trim().slice(0, 40);
    const message = String(body.message || '').trim().slice(0, 140);
    const stars = Math.max(1, Math.min(5, Math.floor(parseInt(body.stars, 10) || 5)));
    if (!name) return { ok: false, error: 'Name required' };
    if (!message) return { ok: false, error: 'Message required' };
    await env.DB.prepare('INSERT INTO reviews (name, message, stars, created_at) VALUES (?,?,?,?)').bind(name, message, stars, t).run();
    try { await env.DB.prepare('DELETE FROM reviews WHERE id NOT IN (SELECT id FROM reviews ORDER BY id DESC LIMIT 15)').run(); } catch (e) {}
    return { ok: true };
  }
  const id = parseInt(body.id, 10);
  if (!id) return { ok: false, error: 'Review id required' };
  if (body.action === 'delete') { await env.DB.prepare('DELETE FROM reviews WHERE id = ?').bind(id).run(); return { ok: true }; }
  return { ok: false, error: 'Unknown action' };
}
async function adminTaskAction(env, body) {
  const t = now();
  if (body.action === 'add') {
    const title = String(body.title || '').trim().slice(0, 80);
    const type = String(body.type || '');
    const reward = Math.floor(parseInt(body.reward, 10) || 0);
    const goal = Math.max(1, Math.floor(parseInt(body.goal, 10) || 1));
    const link = String(body.link || '').trim().slice(0, 200) || null;
    if (!title) return { ok: false, error: 'Title required' };
    if (!TASK_TYPES.includes(type)) return { ok: false, error: 'Type must be: ' + TASK_TYPES.join(', ') };
    if (reward < 1 || reward > 1000000) return { ok: false, error: 'Reward must be 1..1000000' };
    if (type === 'link' && !link) return { ok: false, error: 'Link tasks need a URL' };
    await env.DB.prepare('INSERT INTO tasks (title, type, reward, goal, link, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .bind(title, type, reward, goal, link, t).run();
    return { ok: true };
  }
  const id = parseInt(body.id, 10);
  if (!id) return { ok: false, error: 'Task id required' };
  if (body.action === 'toggle') { await env.DB.prepare('UPDATE tasks SET active = 1 - active WHERE id = ?').bind(id).run(); return { ok: true }; }
  if (body.action === 'delete') { await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run(); return { ok: true }; }
  if (body.action === 'setlink') {
    const link = String(body.link || '').trim().slice(0, 200);
    await env.DB.prepare('UPDATE tasks SET link = ? WHERE id = ?').bind(link || null, id).run();
    return { ok: true };
  }
  return { ok: false, error: 'Unknown action' };
}
async function adminWdAction(env, body) {
  const id = parseInt(body.id, 10);
  if (!id) return { ok: false, error: 'Withdrawal id required' };
  const w = await env.DB.prepare('SELECT * FROM withdrawals WHERE id = ?').bind(id).first();
  if (!w) return { ok: false, error: 'Withdrawal not found' };
  if (w.status !== 'pending') return { ok: false, error: 'Already processed' };
  const t = now();
  if (body.action === 'paid') {
    await env.DB.prepare("UPDATE withdrawals SET status = 'paid', processed_at = ? WHERE id = ?").bind(t, id).run();
    return { ok: true, result: 'paid' };
  }
  if (body.action === 'reject') {
    await env.DB.prepare("UPDATE withdrawals SET status = 'rejected', processed_at = ? WHERE id = ?").bind(t, id).run();
    await run(env, 'UPDATE users SET balance = balance + ? WHERE user_id = ?', [w.amount, w.user_id]);
    return { ok: true, result: 'rejected + refunded ' + w.amount + ' ETB' };
  }
  return { ok: false, error: 'Unknown action' };
}
async function adminAction(env, body) {
  const id = parseInt(body.userId, 10);
  if (!id) return { ok: false, error: 'userId required' };
  const t = now();
  if (body.action === 'add') {
    await run(env, 'UPDATE users SET balance = MAX(0, balance + ?), updated_at = ? WHERE user_id = ?', [parseInt(body.amount, 10) || 0, t, id]);
  } else if (body.action === 'set') {
    await run(env, 'UPDATE users SET balance = MAX(0, ?), updated_at = ? WHERE user_id = ?', [parseInt(body.amount, 10) || 0, t, id]);
  } else if (body.action === 'ban') {
    await env.DB.prepare("UPDATE users SET banned=1, ban_reason='Banned by admin', updated_at=? WHERE user_id=?").bind(t, id).run();
  } else if (body.action === 'unban') {
    await env.DB.prepare('UPDATE users SET banned=0, ban_reason=NULL, updated_at=? WHERE user_id=?').bind(t, id).run();
  } else return { ok: false, error: 'Unknown action' };
  const r = await env.DB.prepare('SELECT user_id, name, balance, banned, ban_reason FROM users WHERE user_id=?').bind(id).first();
  return { ok: true, user: r };
}

/* ================= ROUTER ================= */
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url).pathname;
    if (url === '/') return j({ ok: true, msg: 'TanveXo API v16 (Code 5) is running' });
    let body = {};
    if (request.method === 'POST') { try { body = await request.json(); } catch (e) {} }
    try {
      if (url === '/telegram-webhook') {
        if (env.WEBHOOK_SECRET && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET)
          return j({ ok: false, error: 'Unauthorized' }, 401);
        await initDb(env);
        await handleWebhook(env, body);
        return j({ ok: true });
      }
      if (url === '/api/admin/stats')        { if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401); await initDb(env); return j(await adminStats(env)); }
      if (url === '/api/admin/action')       { if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401); await initDb(env); return j(await adminAction(env, body)); }
      if (url === '/api/admin/task_action')  { if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401); await initDb(env); return j(await adminTaskAction(env, body)); }
      if (url === '/api/admin/wd_action')    { if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401); await initDb(env); return j(await adminWdAction(env, body)); }
      if (url === '/api/admin/review_action'){ if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401); await initDb(env); return j(await adminReviewAction(env, body)); }
      if (url === '/api/admin/tx_action')    { if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401); await initDb(env); return j(await adminTxAction(env, body)); }
      if (request.method !== 'POST') return j({ ok: false, error: 'Use POST' }, 405);
      await initDb(env);
      const initData = request.headers.get('X-Telegram-Init-Data') || '';
      const tgUser = await verifyInitData(initData, env.BOT_TOKEN || '');
      if (!tgUser) return j({ ok: false, error: env.BOT_TOKEN ? 'Auth failed — open the app from Telegram' : 'BOT_TOKEN secret is not set in Worker settings' }, 401);
      switch (url) {
        case '/api/init':            return j(await apiInit(env, tgUser, body));
        case '/api/verify_channels': return j(await apiVerifyChannels(env, tgUser));
        case '/api/sync':            return j(await apiSync(env, tgUser));
        case '/api/daily':           return j(await apiDaily(env, tgUser));
        case '/api/tasks':           return j(await apiTasks(env, tgUser));
        case '/api/task':            return j(await apiTask(env, tgUser, body));
        case '/api/ad':              return j(await apiAd(env, tgUser));
        case '/api/reviews':         return j(await apiReviews(env));
        case '/api/tx_register':     return j(await apiTxRegister(env, tgUser, body));
        case '/api/tx_my':           return j(await apiTxMine(env, tgUser));
        case '/api/withdraw':        return j(await apiWithdraw(env, tgUser, body));
        case '/api/withdrawals':     return j(await apiWithdrawals(env, tgUser));
      }
      return j({ ok: false, error: 'Unknown endpoint' }, 404);
    } catch (e) {
      return j({ ok: false, error: 'Server error: ' + (e && e.message ? e.message : String(e)) }, 500);
    }
  }
};
