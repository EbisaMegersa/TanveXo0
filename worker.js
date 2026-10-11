/* TanveXo API v6 — invite-to-earn, ads, atomic channel gate, webhook */
const REFERRAL_REWARD = 100;         /* coins per invited friend */
const AD_REWARD = 15;                /* coins per ad watched */
const AD_COOLDOWN = 1800;            /* seconds between ads (30 min) */
const AD_MAX_PER_DAY = 20;
const MIN_WITHDRAW = 5000;
const MAX_ACCOUNTS_PER_DEVICE = 2;
const DAY = 86400, SPIN_COST = 100;
const DEFAULT_CHANNEL = 'https://t.me/ebtry0';
const BOT_USERNAME = 'tanvexoappbot';
const APP_LINK = 'https://t.me/' + BOT_USERNAME + '/refer';

const STREAK_REWARDS = [10, 25, 50, 75, 100, 150, 250];
const SPIN_PRIZES = [
  { coins:5, w:28 }, { coins:10, w:22 }, { coins:15, w:18 }, { coins:25, w:12 },
  { coins:50, w:10 }, { coins:100, w:6 }, { coins:250, w:3 }, { energy:false, w:1 }
];
/* energy prize no longer exists — map last slot to coins */
SPIN_PRIZES[7] = { coins:500, w:1 };
function pickPrize(){ let r = Math.random()*100, a = 0; for (let i=0;i<SPIN_PRIZES.length;i++){ a += SPIN_PRIZES[i].w; if (r < a) return i; } return 0; }
const TASK_TYPES = ['invites','daily','ads','link'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data, X-Admin-Key, X-Telegram-Bot-Api-Secret-Token',
  'Access-Control-Max-Age': '86400'
};
const j = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const now = () => Math.floor(Date.now() / 1000);
const bannedResp = row => ({ ok: false, error: (row && row.ban_reason) ? row.ban_reason : 'Account banned', locked: true });

let dbReady = null;
function initDb(env) {
  if (!dbReady) {
    dbReady = (async () => {
      const t0 = now();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY, name TEXT, username TEXT,
        balance INTEGER NOT NULL DEFAULT 0, total_earned INTEGER NOT NULL DEFAULT 0,
        taps INTEGER NOT NULL DEFAULT 0, energy REAL NOT NULL DEFAULT 500, energy_ts INTEGER NOT NULL DEFAULT 0,
        boost INTEGER NOT NULL DEFAULT 1, daily_streak INTEGER NOT NULL DEFAULT 0,
        last_daily INTEGER NOT NULL DEFAULT 0, daily_claims INTEGER NOT NULL DEFAULT 0,
        tasks TEXT NOT NULL DEFAULT '[]', channel_clicked INTEGER NOT NULL DEFAULT 0,
        referred_by INTEGER, invited INTEGER NOT NULL DEFAULT 0,
        device_id TEXT, banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT, last_spin INTEGER NOT NULL DEFAULT 0,
        ads_watched INTEGER NOT NULL DEFAULT 0, ads_today INTEGER NOT NULL DEFAULT 0,
        ad_day TEXT, last_ad INTEGER NOT NULL DEFAULT 0,
        migrated INTEGER NOT NULL DEFAULT 0,
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
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT,
        amount INTEGER NOT NULL, method TEXT NOT NULL, address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, processed_at INTEGER
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
        'ALTER TABLE users ADD COLUMN migrated INTEGER NOT NULL DEFAULT 0'
      ];
      for (const a of alters) { try { await env.DB.prepare(a).run(); } catch(e) {} }
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks').first();
      if (!c || c.n === 0) {
        const seed = [
          ['Invite your first friend','invites',250,1],
          ['Invite 5 friends','invites',1000,5],
          ['Watch your first ad','ads',50,1],
          ['Watch 10 ads','ads',300,10],
          ['Claim a daily bonus','daily',25,1],
          ['Join our channel','link',100,1]
        ];
        for (let i = 0; i < seed.length; i++) {
          await env.DB.prepare('INSERT INTO tasks (title,type,reward,goal,link,active,created_at) VALUES (?,?,?,?,?,1,?)')
            .bind(seed[i][0], seed[i][1], seed[i][2], seed[i][3], seed[i][1] === 'link' ? DEFAULT_CHANNEL : null, t0).run();
        }
      } else {
        /* retire old tap-era task types */
        try { await env.DB.prepare("UPDATE tasks SET active = 0 WHERE type IN ('taps','boost')").run(); } catch(e) {}
        try { await env.DB.prepare("UPDATE tasks SET link = ? WHERE type = 'link' AND (link IS NULL OR link = '')").bind(DEFAULT_CHANNEL).run(); } catch(e) {}
      }
    })().catch(e => { dbReady = null; throw e; });
  }
  return dbReady;
}

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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {})
    });
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

const MEMBER_STATUSES = ['creator', 'administrator', 'member', 'restricted'];
async function isMember(env, chat, userId) {
  const r = await botCall(env, 'getChatMember', { chat_id: chat, user_id: userId });
  if (!r || r.ok !== true) {
    const d = (r && r.description) || 'unknown error';
    if (/administrator|rights|admin|not a member of the channel/i.test(d))
      return { ok: false, error: 'Setup error: add the bot as admin in ' + chat, setup: true };
    return { ok: false, error: 'Could not verify — try again in a moment' };
  }
  const m = r.result || {};
  if (m.status === 'restricted') return { ok: m.is_member === true };
  return { ok: MEMBER_STATUSES.includes(m.status) };
}

/* ================= DB HELPERS ================= */
async function getRow(env, id) {
  const r = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?').bind(id).first();
  if (r) r.tasks = JSON.parse(r.tasks || '[]');
  return r || null;
}
async function friendsOf(env, id) {
  const { results } = await env.DB.prepare('SELECT name, created_at FROM referrals WHERE referrer = ? ORDER BY created_at DESC LIMIT 100').bind(id).all();
  return (results || []).map(r => ({ name: r.name || 'Friend', ts: r.created_at * 1000 }));
}
async function claimsOf(env, id) {
  const { results } = await env.DB.prepare('SELECT task_id FROM task_claims WHERE user_id = ?').bind(id).all();
  return (results || []).map(r => r.task_id);
}
async function withdrawalsOf(env, id) {
  const { results } = await env.DB.prepare('SELECT id, amount, method, address, status, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(id).all();
  return (results || []).map(r => ({ id: r.id, amount: r.amount, method: r.method, address: r.address, status: r.status, ts: r.created_at * 1000 }));
}
async function saveRow(env, row) {
  await env.DB.prepare(`UPDATE users SET name=?, username=?, balance=?, total_earned=?, taps=?, energy=?, energy_ts=?,
    boost=?, daily_streak=?, last_daily=?, daily_claims=?, tasks=?, channel_clicked=?, invited=?,
    device_id=?, banned=?, ban_reason=?, last_spin=?, ads_watched=?, ads_today=?, ad_day=?, last_ad=?, migrated=?, updated_at=? WHERE user_id=?`)
    .bind(row.name, row.username, row.balance, row.total_earned, row.taps || 0, row.energy || 500, row.energy_ts || 0,
      row.boost || 1, row.daily_streak, row.last_daily, row.daily_claims, JSON.stringify(row.tasks || []),
      row.channel_clicked ? 1 : 0, row.invited, row.device_id || null, row.banned ? 1 : 0,
      row.ban_reason || null, row.last_spin || 0, row.ads_watched || 0, row.ads_today || 0,
      row.ad_day || null, row.last_ad || 0, row.migrated ? 1 : 0, now(), row.user_id).run();
}
function toClient(row, friends, claimed) {
  return {
    balance: row.balance, totalEarned: row.total_earned,
    referrals: row.invited, dailyStreak: row.daily_streak, lastDaily: row.last_daily * 1000,
    dailyClaims: row.daily_claims,
    tasksClaimed: claimed || [],
    adsWatched: row.ads_watched || 0, adsToday: row.ads_today || 0, lastAd: (row.last_ad || 0) * 1000,
    lastSpin: (row.last_spin || 0) * 1000, friends: friends || []
  };
}

/* create user + credit referral — shared by mini app and webhook */
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
      lockDev ? 'Device limit reached — max ' + MAX_ACCOUNTS_PER_DEVICE + ' accounts per device' : null,
      t, t).run();
  row = await getRow(env, u.id);
  if (row && !row.banned && refId && refId !== u.id) {
    const referrer = await getRow(env, refId);
    if (referrer && !referrer.banned) {
      let allowed = true;
      if (dev) {
        const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE device_id = ? AND referred_by IS NOT NULL').bind(dev).first();
        if (c && c.n >= MAX_ACCOUNTS_PER_DEVICE) allowed = false;
      }
      if (allowed) {
        referrer.balance += REFERRAL_REWARD;
        referrer.total_earned += REFERRAL_REWARD;
        referrer.invited += 1;
        await saveRow(env, referrer);
        await env.DB.prepare('INSERT OR IGNORE INTO referrals (referrer, user_id, name, created_at) VALUES (?, ?, ?, ?)')
          .bind(refId, u.id, name, t).run();
        await env.DB.prepare('UPDATE users SET referred_by=? WHERE user_id=?').bind(refId, u.id).run();
      }
    }
  }
  return row;
}

/* ================= USER API ================= */
async function apiInit(env, tgUser, body) {
  const dev = (body && body.dev) ? String(body.dev).slice(0, 64) : null;
  const ref = parseInt(body && body.ref, 10) || null;
  const row = await ensureUser(env, tgUser, ref, dev);
  if (!row) return { ok: false, error: 'Could not create user' };
  if (row.banned) return bannedResp(row);
  await saveRow(env, row);
  return { ok: true, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id)) };
}

async function apiSync(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found — reopen the app' };
  if (row.banned) return bannedResp(row);
  const day = new Date().toISOString().slice(0, 10);
  if (row.ad_day !== day) { row.ads_today = 0; row.ad_day = day; }
  return { ok: true, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id)) };
}

async function apiDaily(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  const t = now();
  if (t - row.last_daily < DAY) return { ok: false, error: 'Bonus already claimed — come back tomorrow' };
  row.daily_streak = (row.last_daily > 0 && t - row.last_daily < 2 * DAY)
    ? (row.daily_streak >= STREAK_REWARDS.length ? 1 : row.daily_streak + 1) : 1;
  const reward = STREAK_REWARDS[row.daily_streak - 1];
  row.balance += reward; row.total_earned += reward; row.daily_claims += 1;
  row.last_daily = t; row.updated_at = t;
  await saveRow(env, row);
  return { ok: true, reward, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id)) };
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
  const id = parseInt(body.id, 10);
  const t = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  if (!t || !t.active) return { ok: false, error: 'Task not found' };
  const claimed = await claimsOf(env, tgUser.id);
  if (claimed.includes(id)) return { ok: false, error: 'Already claimed' };

  if (t.type === 'link') {
    /* ATOMIC GATE: verify membership and credit in this same request */
    const chat = extractChat(t.link);
    if (!chat) return { ok: false, error: 'Admin: this task needs a public t.me link', notJoined: true };
    const v = await isMember(env, chat, tgUser.id);
    if (!v.ok) return { ok: false, error: v.error || 'You must join the channel first', notJoined: true, setup: !!v.setup };
  } else if (dynProgress(row, t) < t.goal) {
    return { ok: false, error: 'Task not finished yet' };
  }

  await env.DB.prepare('INSERT OR IGNORE INTO task_claims (user_id, task_id, claimed_at) VALUES (?,?,?)').bind(tgUser.id, id, now()).run();
  row.balance += t.reward; row.total_earned += t.reward; row.updated_at = now();
  await saveRow(env, row);
  return { ok: true, reward: t.reward, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id)) };
}

async function apiSpin(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  const t = now();
  const free = t - (row.last_spin || 0) >= DAY;
  if (!free) {
    if (row.balance < SPIN_COST) return { ok: false, error: 'Need ' + (SPIN_COST - row.balance) + ' more coins to spin' };
    row.balance -= SPIN_COST;
  }
  row.last_spin = t;
  const idx = pickPrize();
  const p = SPIN_PRIZES[idx];
  const prize = { index: idx };
  row.balance += p.coins; row.total_earned += p.coins;
  prize.coins = p.coins;
  row.updated_at = t;
  await saveRow(env, row);
  return { ok: true, prize, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id)) };
}

async function apiAd(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  const t = now();
  const day = new Date().toISOString().slice(0, 10);
  if (row.ad_day !== day) { row.ads_today = 0; row.ad_day = day; }
  if (row.ads_today >= AD_MAX_PER_DAY) return { ok: false, error: 'Daily ad limit reached (' + AD_MAX_PER_DAY + '/day) — come back tomorrow' };
  const wait = AD_COOLDOWN - (t - (row.last_ad || 0));
  if (wait > 0) {
    const m = Math.floor(wait / 60), s = wait % 60;
    return { ok: false, error: 'Next ad in ' + m + ':' + String(s).padStart(2, '0') };
  }
  row.ads_watched += 1; row.ads_today += 1; row.last_ad = t;
  row.balance += AD_REWARD; row.total_earned += AD_REWARD; row.updated_at = t;
  await saveRow(env, row);
  return { ok: true, reward: AD_REWARD, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id)) };
}

async function apiWithdraw(env, tgUser, body) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  const amount = Math.floor(parseInt(body.amount, 10) || 0);
  const method = String(body.method || '').trim().slice(0, 40);
  const address = String(body.address || '').trim().slice(0, 120);
  if (!method) return { ok: false, error: 'Choose a withdrawal method' };
  if (address.length < 4) return { ok: false, error: 'Enter your wallet / account details' };
  if (!amount || amount < MIN_WITHDRAW) return { ok: false, error: 'Minimum withdrawal is ' + MIN_WITHDRAW + ' coins' };
  if (amount > row.balance) return { ok: false, error: 'Not enough coins' };
  row.balance -= amount; row.updated_at = now();
  await saveRow(env, row);
  await env.DB.prepare('INSERT INTO withdrawals (user_id, name, amount, method, address, status, created_at) VALUES (?,?,?,?,?,\'pending\',?)')
    .bind(tgUser.id, row.name, amount, method, address, now()).run();
  return { ok: true, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id)) };
}

async function apiWithdrawals(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  return { ok: true, withdrawals: await withdrawalsOf(env, tgUser.id) };
}

/* ================= WEBHOOK (bot commands) ================= */
function esc(s){ return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
async function reply(env, chatId, text, keyboard) {
  const params = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) params.reply_markup = { inline_keyboard: keyboard };
  return botCall(env, 'sendMessage', params);
}
async function handleWebhook(env, update) {
  try {
    const msg = update.message || update.edited_message;
    if (!msg || !msg.from || !msg.text) return;
    const chatId = msg.chat.id;
    const parts = msg.text.trim().split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase();
    const payload = parts[1] || '';

    if (cmd === '/start') {
      const m = String(payload).match(/ref[_-]?(\d+)/i);
      const refId = m ? parseInt(m[1], 10) : null;
      if (refId) await ensureUser(env, msg.from, refId, null);
      else await ensureUser(env, msg.from, null, null);
      const kb = [[{ text: '🎮 Open TanveXo', url: APP_LINK }]];
      if (refId) {
        await reply(env, chatId, '👋 Welcome to <b>TanveXo</b>!\n\n🎁 You were invited by a friend — open the app to start earning.\n\n💰 Invite friends · 📺 Watch ads · ✅ Do tasks · 🎡 Spin · 💸 Withdraw', kb);
      } else {
        await reply(env, chatId, '👋 Welcome to <b>TanveXo</b>!\n\n💰 Invite friends — earn <b>' + REFERRAL_REWARD + ' coins</b> each\n📺 Watch ads for coins\n✅ Complete tasks\n🎡 Spin the lucky wheel\n💸 Withdraw your coins\n\nTap below to start!', kb);
      }
    } else if (cmd === '/balance') {
      const row = await getRow(env, msg.from.id);
      if (!row) await reply(env, chatId, 'You don\'t have an account yet — open the app first!', [[{ text: '🎮 Open TanveXo', url: APP_LINK }]]);
      else await reply(env, chatId, '💰 <b>' + esc(row.name) + '</b>\n\nBalance: <b>' + row.balance + '</b> coins\nFriends invited: <b>' + row.invited + '</b>\nAds watched: <b>' + (row.ads_watched || 0) + '</b>');
    } else if (cmd === '/help') {
      await reply(env, chatId, '<b>TanveXo commands:</b>\n/start — open the app\n/balance — check your coins\n/help — this message');
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
  return { ok: true,
    stats: { users: agg.users, coins: agg.coins, earned: agg.earned, taps: agg.ads || 0, invites: agg.invites, new24: nd ? nd.n : 0 },
    pendingWd: { n: pend ? pend.n : 0, amt: pend ? pend.amt : 0 },
    top: top.results || [], recent: recent.results || [],
    tasks: tasks.results || [], withdrawals: wds.results || [] };
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
    await env.DB.prepare('UPDATE users SET balance = balance + ? WHERE user_id = ?').bind(w.amount, w.user_id).run();
    return { ok: true, result: 'rejected + refunded ' + w.amount + ' coins' };
  }
  return { ok: false, error: 'Unknown action' };
}
async function adminAction(env, body) {
  const id = parseInt(body.userId, 10);
  if (!id) return { ok: false, error: 'userId required' };
  const t = now();
  if (body.action === 'add') {
    await env.DB.prepare('UPDATE users SET balance = MAX(0, balance + ?), updated_at=? WHERE user_id=?').bind(parseInt(body.amount, 10) || 0, t, id).run();
  } else if (body.action === 'set') {
    await env.DB.prepare('UPDATE users SET balance = MAX(0, ?), updated_at=? WHERE user_id=?').bind(parseInt(body.amount, 10) || 0, t, id).run();
  } else if (body.action === 'ban') {
    await env.DB.prepare("UPDATE users SET banned=1, ban_reason='Banned by admin', updated_at=? WHERE user_id=?").bind(t, id).run();
  } else if (body.action === 'unban') {
    await env.DB.prepare('UPDATE users SET banned=0, ban_reason=NULL, updated_at=? WHERE user_id=?').bind(t, id).run();
  } else return { ok: false, error: 'Unknown action' };
  const r = await env.DB.prepare('SELECT user_id, name, balance, banned, ban_reason FROM users WHERE user_id=?').bind(id).first();
  return { ok: true, user: r };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url).pathname;
    if (url === '/') return j({ ok: true, msg: 'TanveXo API v6 is running' });
    let body = {};
    if (request.method === 'POST') { try { body = await request.json(); } catch (e) {} }
    try {
      /* Telegram webhook — no Telegram-mini auth */
      if (url === '/telegram-webhook') {
        if (env.WEBHOOK_SECRET && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET)
          return j({ ok: false, error: 'Unauthorized' }, 401);
        await initDb(env);
        await handleWebhook(env, body);
        return j({ ok: true });
      }
      if (url === '/api/admin/stats') {
        if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401);
        await initDb(env);
        return j(await adminStats(env));
      }
      if (url === '/api/admin/action') {
        if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401);
        await initDb(env);
        return j(await adminAction(env, body));
      }
      if (url === '/api/admin/task_action') {
        if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401);
        await initDb(env);
        return j(await adminTaskAction(env, body));
      }
      if (url === '/api/admin/wd_action') {
        if (!adminOk(request, env)) return j({ ok: false, error: 'Unauthorized' }, 401);
        await initDb(env);
        return j(await adminWdAction(env, body));
      }
      if (request.method !== 'POST') return j({ ok: false, error: 'Use POST' }, 405);
      await initDb(env);
      const initData = request.headers.get('X-Telegram-Init-Data') || '';
      const tgUser = await verifyInitData(initData, env.BOT_TOKEN || '');
      if (!tgUser) return j({ ok: false, error: env.BOT_TOKEN ? 'Auth failed — open the app from Telegram' : 'BOT_TOKEN secret is not set in Worker settings' }, 401);
      switch (url) {
        case '/api/init':        return j(await apiInit(env, tgUser, body));
        case '/api/sync':        return j(await apiSync(env, tgUser));
        case '/api/daily':       return j(await apiDaily(env, tgUser));
        case '/api/tasks':       return j(await apiTasks(env, tgUser));
        case '/api/task':        return j(await apiTask(env, tgUser, body));
        case '/api/spin':        return j(await apiSpin(env, tgUser));
        case '/api/ad':          return j(await apiAd(env, tgUser));
        case '/api/withdraw':    return j(await apiWithdraw(env, tgUser, body));
        case '/api/withdrawals': return j(await apiWithdrawals(env, tgUser));
      }
      return j({ ok: false, error: 'Unknown endpoint' }, 404);
    } catch (e) {
      return j({ ok: false, error: 'Server error: ' + (e && e.message ? e.message : String(e)) }, 500);
    }
  }
};
