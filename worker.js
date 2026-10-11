/* TanveXo API v12 — mandatory channel gate for ALL users, referral credit on gate pass */
const REFERRAL_REWARD = 50, WELCOME_BONUS = 25;
const AD_REWARD = 5, AD_COOLDOWN = 1800, AD_MAX_PER_DAY = 25;
const SPIN_MIN_BET = 50, SPIN_MAX_BET = 5000;
const WD_REQ_ADS = 25, WD_REQ_FRIENDS = 15;
const MIN_WITHDRAW = 1000;
const MAX_ACCOUNTS_PER_DEVICE = 2;
const DAY = 86400;
const EXT_LINK_MIN_STAY = 8;
const DEFAULT_CHANNEL = 'https://t.me/ebtry0';
const BOT_USERNAME = 'tanvexoappbot';
const APP_LINK = 'https://t.me/' + BOT_USERNAME + '/refer';
/* ← BOTH channels are mandatory for every user (bot must be admin in both) */
const REQ_CHANNELS = ['@ebtry0', '@ebisa_emoji'];
const STREAK_REWARDS = [10, 30, 40, 60, 70, 80, 100];
const TASK_TYPES = ['invites','daily','ads','link'];
const gateErr = () => ({ ok: false, gate: true, error: 'Join both channels to continue', channels: REQ_CHANNELS });

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
        daily_streak INTEGER NOT NULL DEFAULT 0, last_daily INTEGER NOT NULL DEFAULT 0, daily_claims INTEGER NOT NULL DEFAULT 0,
        referred_by INTEGER, invited INTEGER NOT NULL DEFAULT 0,
        device_id TEXT, banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT,
        ads_watched INTEGER NOT NULL DEFAULT 0, ads_today INTEGER NOT NULL DEFAULT 0, ad_day TEXT, last_ad INTEGER NOT NULL DEFAULT 0,
        spins INTEGER NOT NULL DEFAULT 0, last_spin INTEGER NOT NULL DEFAULT 0,
        req_ads INTEGER NOT NULL DEFAULT 0, req_friends INTEGER NOT NULL DEFAULT 0, req_spins INTEGER NOT NULL DEFAULT 0,
        welcome INTEGER NOT NULL DEFAULT 0, migrated INTEGER NOT NULL DEFAULT 0,
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
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS spin_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        bet INTEGER NOT NULL, mult REAL NOT NULL, payout INTEGER NOT NULL, created_at INTEGER NOT NULL
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
      for (const a of alters) { try { await env.DB.prepare(a).run(); } catch(e) {} }
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks').first();
      if (!c || c.n === 0) {
        const seed = [
          ['Invite your first friend','invites',250,1],
          ['Invite 5 friends','invites',1000,5],
          ['Watch your first ad','ads',50,1],
          ['Watch 10 ads','ads',300,10],
          ['Claim a daily bonus','daily',25,1],
          ['Join our Channel','link',50,1]
        ];
        for (let i = 0; i < seed.length; i++) {
          await env.DB.prepare('INSERT INTO tasks (title,type,reward,goal,link,active,created_at) VALUES (?,?,?,?,?,1,?)')
            .bind(seed[i][0], seed[i][1], seed[i][2], seed[i][3], seed[i][1] === 'link' ? DEFAULT_CHANNEL : null, t0).run();
        }
      } else {
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

async function botCall(env, method, params) {
  if (!env.BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN not set' };
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {})
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
function isTelegramLink(link) {
  return !!link && /t\.me\//i.test(String(link));
}
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
async function spinHistoryOf(env, id) {
  const { results } = await env.DB.prepare('SELECT bet, mult, payout, created_at FROM spin_history WHERE user_id = ? ORDER BY id DESC LIMIT 12').bind(id).all();
  return (results || []).map(r => ({ bet: r.bet, mult: r.mult, payout: r.payout, ts: r.created_at * 1000 }));
}
async function logAct(env, uid, type, title, amount) {
  try { await env.DB.prepare('INSERT INTO activities (user_id, type, title, amount, created_at) VALUES (?,?,?,?,?)').bind(uid, type, title, amount, now()).run(); } catch(e) {}
}
async function saveRow(env, row) {
  await env.DB.prepare(`UPDATE users SET name=?, username=?, balance=?, total_earned=?,
    daily_streak=?, last_daily=?, daily_claims=?, invited=?,
    device_id=?, banned=?, ban_reason=?,
    ads_watched=?, ads_today=?, ad_day=?, last_ad=?,
    spins=?, last_spin=?, req_ads=?, req_friends=?, req_spins=?, welcome=?, updated_at=? WHERE user_id=?`)
    .bind(row.name, row.username, row.balance, row.total_earned,
      row.daily_streak, row.last_daily, row.daily_claims, row.invited,
      row.device_id || null, row.banned ? 1 : 0, row.ban_reason || null,
      row.ads_watched || 0, row.ads_today || 0, row.ad_day || null, row.last_ad || 0,
      row.spins || 0, row.last_spin || 0, row.req_ads || 0, row.req_friends || 0, row.req_spins || 0, row.welcome ? 1 : 0,
      now(), row.user_id).run();
}
function toClient(row, friends, claimed) {
  return {
    balance: row.balance, totalEarned: row.total_earned,
    referrals: row.invited, friends: friends || [],
    dailyStreak: row.daily_streak, lastDaily: row.last_daily * 1000, dailyClaims: row.daily_claims,
    tasksClaimed: claimed || [],
    adsWatched: row.ads_watched || 0, adsToday: row.ads_today || 0, lastAd: (row.last_ad || 0) * 1000,
    spins: row.spins || 0, lastSpin: (row.last_spin || 0) * 1000,
    reqAds: row.req_ads || 0, reqFriends: row.req_friends || 0,
    activities: row._acts || []
  };
}

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
  /* record referral as PENDING — credited only after the channel gate is passed */
  if (row && !row.banned && refId && refId !== u.id) {
    const exists = await env.DB.prepare('SELECT user_id FROM referrals WHERE user_id = ?').bind(u.id).first();
    if (!exists && !row.referred_by) {
      const referrer = await getRow(env, refId);
      if (referrer && !referrer.banned) {
        await env.DB.prepare('INSERT OR IGNORE INTO referrals (referrer, user_id, name, photo, status, created_at) VALUES (?,?,?,?,\'pending\',?)')
          .bind(refId, u.id, name, u.photo_url || null, t).run();
        await env.DB.prepare('UPDATE users SET referred_by=? WHERE user_id=?').bind(refId, u.id).run();
        row.referred_by = refId;
      }
    }
  }
  if (row) await saveRow(env, row);
  return row;
}

/* credit pending referral (referrer +50, friend +25) — called after channel gate passes */
async function verifyReferral(env, friendId) {
  const row = await getRow(env, friendId);
  if (!row || !row.referred_by) return { ok: true, nothing: true };
  const ref = await env.DB.prepare('SELECT status FROM referrals WHERE user_id = ?').bind(friendId).first();
  if (!ref || (ref.status || 'verified') !== 'pending') return { ok: true, already: true };
  const gate = await joinedAllChannels(env, friendId);
  if (!gate.ok) return { ok: false, channel: gate.channel };
  const referrer = await getRow(env, row.referred_by);
  const t = now();
  if (referrer && !referrer.banned) {
    referrer.balance += REFERRAL_REWARD;
    referrer.total_earned += REFERRAL_REWARD;
    referrer.invited += 1;
    referrer.req_friends = (referrer.req_friends || 0) + 1;
    await saveRow(env, referrer);
    await logAct(env, referrer.user_id, 'ref', 'Friend joined: ' + row.name, REFERRAL_REWARD);
  }
  if (!row.welcome) {
    row.balance += WELCOME_BONUS;
    row.total_earned += WELCOME_BONUS;
    row.welcome = 1;
    await logAct(env, friendId, 'bonus', 'Welcome bonus', WELCOME_BONUS);
  }
  row.updated_at = t;
  await saveRow(env, row);
  await env.DB.prepare("UPDATE referrals SET status='verified' WHERE user_id=?").bind(friendId).run();
  return { ok: true };
}

/* pass the channel gate: mark verified + credit any pending referral */
async function passGate(env, userId) {
  const gate = await joinedAllChannels(env, userId);
  if (!gate.ok) return { ok: false, channel: gate.channel };
  await env.DB.prepare('UPDATE users SET channel_ok=1 WHERE user_id=?').bind(userId).run();
  await verifyReferral(env, userId);
  return { ok: true };
}

async function apiInit(env, tgUser, body) {
  const dev = (body && body.dev) ? String(body.dev).slice(0, 64) : null;
  const ref = parseInt(body && body.ref, 10) || null;
  let row = await ensureUser(env, tgUser, ref, dev);
  if (!row) return { ok: false, error: 'Could not create user' };
  if (row.banned) return bannedResp(row);
  /* MANDATORY channel gate — every user, every platform, once */
  if (!row.channel_ok) {
    const g = await passGate(env, tgUser.id);
    if (!g.ok) return gateErr();
    row = await getRow(env, tgUser.id);
  }
  row._acts = await actsOf(env, tgUser.id);
  return { ok: true, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id)) };
}

/* called by the in-app popup Verify button */
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
  return { ok: true, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id)) };
}

async function apiSync(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found — reopen the app' };
  if (row.banned) return bannedResp(row);
  if (!row.channel_ok) return gateErr();
  const day = new Date().toISOString().slice(0, 10);
  if (row.ad_day !== day) { row.ads_today = 0; row.ad_day = day; }
  row._acts = await actsOf(env, tgUser.id);
  return { ok: true, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id)) };
}

async function apiDaily(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  if (!row.channel_ok) return gateErr();
  const t = now();
  if (t - row.last_daily < DAY) return { ok: false, error: 'Already claimed — come back tomorrow' };
  row.daily_streak = (row.last_daily > 0 && t - row.last_daily < 2 * DAY)
    ? (row.daily_streak >= STREAK_REWARDS.length ? 1 : row.daily_streak + 1) : 1;
  const reward = STREAK_REWARDS[row.daily_streak - 1];
  row.balance += reward; row.total_earned += reward; row.daily_claims += 1;
  row.last_daily = t; row.updated_at = t;
  await saveRow(env, row);
  await logAct(env, tgUser.id, 'daily', 'Daily check-in — day ' + row.daily_streak, reward);
  row._acts = await actsOf(env, tgUser.id);
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
  if (!row.channel_ok) return gateErr();
  const id = parseInt(body.id, 10);
  const t = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  if (!t || !t.active) return { ok: false, error: 'Task not found' };
  const claimed = await claimsOf(env, tgUser.id);
  if (claimed.includes(id)) return { ok: false, error: 'Already claimed' };

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

  await env.DB.prepare('INSERT OR IGNORE INTO task_claims (user_id, task_id, claimed_at) VALUES (?,?,?)').bind(tgUser.id, id, now()).run();
  row.balance += t.reward; row.total_earned += t.reward; row.updated_at = now();
  await saveRow(env, row);
  await logAct(env, tgUser.id, 'task', t.title, t.reward);
  row._acts = await actsOf(env, tgUser.id);
  return { ok: true, reward: t.reward, state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id)) };
}

function spinMult(){ let r = Math.random() * 100; if (r < 55) return 0; if (r < 80) return 1.5; if (r < 92) return 2; return 3; }
async function apiSpin(env, tgUser, body) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  if (!row.channel_ok) return gateErr();
  const bet = Math.floor(parseInt(body && body.bet, 10) || 0);
  if (bet < SPIN_MIN_BET || bet > SPIN_MAX_BET) return { ok: false, error: 'Bet must be ' + SPIN_MIN_BET + '–' + SPIN_MAX_BET + ' ETB' };
  if (row.balance < bet) return { ok: false, error: 'Not enough ETB for that bet' };
  row.balance -= bet;
  const m = spinMult();
  const payout = Math.floor(bet * m);
  row.balance += payout;
  if (payout > bet) row.total_earned += payout - bet;
  row.spins = (row.spins || 0) + 1;
  row.updated_at = now();
  await saveRow(env, row);
  await env.DB.prepare('INSERT INTO spin_history (user_id, bet, mult, payout, created_at) VALUES (?,?,?,?,?)')
    .bind(tgUser.id, bet, m, payout, now()).run();
  if (m === 0) await logAct(env, tgUser.id, 'game', 'Lucky Wheel — bet lost', -bet);
  else await logAct(env, tgUser.id, 'game', 'Lucky Wheel win ×' + m, payout - bet);
  row._acts = await actsOf(env, tgUser.id);
  return { ok: true, mult: m, payout: payout, bet: bet,
    spinHistory: await spinHistoryOf(env, tgUser.id),
    state: toClient(row, await friendsOf(env, tgUser.id), await claimsOf(env, tgUser.id)) };
}

async function apiSpinHistory(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  return { ok: true, history: await spinHistoryOf(env, tgUser.id) };
}

async function apiAd(env, tgUser) {
  const row = await getRow(env, tgUser.id);
  if (!row) return { ok: false, error: 'User not found' };
  if (row.banned) return bannedResp(row);
  if (!row.channel_ok)
