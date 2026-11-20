'use strict';
// Dashboard sign-in: users (data/users.json, scrypt-hashed passwords), email OTP as second step,
// sessions, lockouts, forced password change, and the admin "Users" API.
// No self-registration: only an admin can add users from the dashboard.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');
const { logger } = require('./logger');
const { sendMail } = require('./mailer');

const OTP_MINUTES = 5;
const MAX_LOGIN_FAILS = 5;
const LOCK_MINUTES = 15;
const MAX_OTP_TRIES = 5;
const MAX_OTP_SENDS = 3;
const RESEND_SECONDS = 30;
const MIN_PASSWORD = 10;

// ---------- users store ----------
const FILE = () => path.join(config.dataDir, 'users.json');
let USERS = null;
function users() {
  if (!USERS) {
    try {
      USERS = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    } catch {
      USERS = [];
    }
  }
  return USERS;
}
function saveUsers() {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE() + '.tmp', JSON.stringify(USERS, null, 2), { mode: 0o600 });
  fs.renameSync(FILE() + '.tmp', FILE());
}
const find = (name) => users().find((u) => u.user.toLowerCase() === String(name || '').trim().toLowerCase());
const activeAdmins = () => users().filter((u) => u.role === 'admin' && !u.disabled);

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
function checkPw(u, pw) {
  if (!u || !u.hash) {
    crypto.scryptSync('dummy', 'dummysalt', 64); // same time whether or not the user exists
    return false;
  }
  const h = crypto.scryptSync(String(pw || ''), u.salt, 64);
  const s = Buffer.from(u.hash, 'hex');
  return h.length === s.length && crypto.timingSafeEqual(h, s);
}
function tempPassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  const b = crypto.randomBytes(14);
  for (let i = 0; i < 14; i++) s += abc[b[i] % abc.length];
  return s;
}
function passwordProblem(user, pw) {
  if (String(pw).length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (String(pw).toLowerCase().includes(String(user).toLowerCase())) return 'Password must not contain the username.';
  return null;
}
const validEmail = (e) => /^[^\s@,:]+@[^\s@,:]+\.[^\s@,:]+$/.test(String(e || ''));
const mask = (e) => String(e).replace(/^(.)(.*)(@.*)$/, (m, a, b, c) => a + '*'.repeat(Math.min(6, b.length)) + c);
const smtpReady = () => !!(config.alerts.smtp.host && (config.alerts.emailFrom || config.alerts.smtp.user));
const otpOn = () => config.server.loginOtp !== false;

// First start: create the admin users listed in .env (DASHBOARD_USERS=user:password:email). After that, users.json is used.
function bootstrap() {
  if (users().length || !config.server.users.length) return;
  const now = new Date().toISOString();
  for (const e of config.server.users) {
    if (find(e.user)) continue;
    USERS.push({ user: e.user, email: e.email || '', role: 'admin', ...hashPw(e.pass), mustChange: false, disabled: false, createdAt: now, createdBy: '.env' });
  }
  saveUsers();
  logger.info('users_bootstrapped', { users: USERS.map((u) => u.user) });
}
bootstrap();
const enabled = () => users().length > 0;

// ---------- sessions, pending OTP, lockouts ----------
const SESS = new Map(); // id -> { user, exp }
const PEND = new Map(); // id -> { user, code, exp, tries, sends, sentAt, ip }
const FAILS = new Map(); // ip -> { n, until }

function clientIp(req) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if ((ip === '127.0.0.1' || ip === '::1') && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return ip;
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const cookie = (name, val, maxAge) => `${name}=${val}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
function killSessions(name) {
  for (const [k, s] of SESS) if (s.user.toLowerCase() === String(name).toLowerCase()) SESS.delete(k);
}
// The signed-in user (fresh from users.json), or null
function currentUser(req) {
  const id = cookies(req).yk_sess;
  const s = id && SESS.get(id);
  if (!s) return null;
  if (s.exp < Date.now()) {
    SESS.delete(id);
    return null;
  }
  const u = find(s.user);
  if (!u || u.disabled) {
    SESS.delete(id);
    return null;
  }
  return u;
}
function locked(ip) {
  const f = FAILS.get(ip);
  return f && f.n >= MAX_LOGIN_FAILS && f.until > Date.now();
}
function fail(ip) {
  const f = FAILS.get(ip);
  const cur = f && f.until > Date.now() ? f : { n: 0 };
  FAILS.set(ip, { n: cur.n + 1, until: Date.now() + LOCK_MINUTES * 60000 });
}
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of SESS) if (s.exp < now) SESS.delete(k);
  for (const [k, p] of PEND) if (p.exp < now) PEND.delete(k);
  for (const [k, f] of FAILS) if (f.until < now) FAILS.delete(k);
}, 600000).unref();

// ---------- pages ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"/><path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87"/><path d="M3 3l18 18"/></svg>';
// Password field with show/hide (eye) button
const pwField = (id, name, label, auto, extra = '') =>
  `<div class="fld"><label for="${id}">${label}</label><div class="pw"><input id="${id}" name="${name}" type="password" autocomplete="${auto}" required ${extra}><button type="button" class="eye" data-eye="${id}" aria-label="Show password" title="Show password">${EYE}</button></div></div>`;
function page(title, sub, body, msg, ok) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · YK Sync</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap">
<style>:root{--g-blue:#1a73e8;--g-blue-h:#1b66c9;--ink:#202124;--ink-2:#5f6368;--line:#dadce0;--bg:#f0f4f9;--card:#fff;--err:#d93025;--ok:#1e8e3e}
@media(prefers-color-scheme:dark){:root{--g-blue:#8ab4f8;--g-blue-h:#aecbfa;--ink:#e3e3e3;--ink-2:#9aa0a6;--line:#444746;--bg:#131314;--card:#1e1f20;--err:#f28b82;--ok:#81c995}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;min-height:100vh;font:14px/1.5 "Poppins","Roboto",system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
main{flex:1;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:420px;max-width:100%;background:var(--card);padding:44px 40px;border:1px solid var(--line);border-radius:28px}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.mark{width:36px;height:36px;border-radius:10px;background:conic-gradient(from -45deg,#4285f4,#34a853,#fbbc05,#ea4335,#4285f4);color:#fff;display:grid;place-items:center;font-size:13px;font-weight:500;box-shadow:inset 0 0 0 2px rgba(255,255,255,.18)}
.logo b{font-weight:500;font-size:16px;color:var(--ink-2)}
h1{font-size:26px;font-weight:400;margin:0 0 6px;color:var(--ink);letter-spacing:-.01em}
p.sub{margin:0 0 20px;font-size:15px;color:var(--ink-2)}
.fld{margin-top:18px;position:relative}
label{display:block;font-size:12px;color:var(--ink-2);margin-bottom:7px;font-weight:500}
input{width:100%;height:52px;border:1px solid var(--line);padding:0 16px;font:inherit;font-size:16px;background:transparent;color:var(--ink);border-radius:8px;transition:border-color .15s,box-shadow .15s}
input:hover{border-color:var(--ink-2)}
input:focus{outline:0;border-color:var(--g-blue);box-shadow:inset 0 0 0 1px var(--g-blue)}
input.code{font-size:26px;letter-spacing:.4em;text-align:center;font-variant-numeric:tabular-nums}
.pw input{padding-right:52px}
.eye{position:absolute;right:8px;bottom:8px;width:36px;height:36px;border:0;background:transparent;color:var(--ink-2);cursor:pointer;display:grid;place-items:center;border-radius:50%}
.eye:hover{background:rgba(95,99,104,.12)}.eye:focus-visible{outline:2px solid var(--g-blue)}
.hint{font-size:12px;color:var(--ink-2);margin-top:7px}
.actions{display:flex;justify-content:flex-end;align-items:center;margin-top:28px;gap:8px}
.btn{min-width:96px;height:40px;padding:0 24px;border:0;background:var(--g-blue);color:#fff;font:inherit;font-size:14px;font-weight:500;cursor:pointer;border-radius:999px;transition:background-color .15s,box-shadow .15s}
@media(prefers-color-scheme:dark){.btn{color:#062e6f}}
.btn:hover{background:var(--g-blue-h);box-shadow:0 1px 3px rgba(60,64,67,.3)}
.btn:focus-visible{outline:2px solid var(--g-blue);outline-offset:2px}
.btn.sec{background:transparent;color:var(--g-blue);border:1px solid var(--line)}.btn.sec:hover{background:rgba(26,115,232,.08);box-shadow:none}
.link{background:none;border:0;color:var(--g-blue);font:inherit;font-size:14px;font-weight:500;cursor:pointer;padding:0;border-radius:4px}.link:hover{text-decoration:underline}
.row{display:flex;justify-content:space-between;align-items:center;margin-top:18px;font-size:13px;color:var(--ink-2)}
.msg{font-size:14px;color:var(--err);margin:2px 0;display:flex;align-items:center;gap:6px}.msg.ok{color:var(--ok)}
footer{display:flex;justify-content:center;gap:16px;padding:16px 20px;font-size:12px;color:var(--ink-2)}
@media(max-width:600px){.card{border:0;padding:28px 22px;border-radius:0}body{background:var(--card)}}</style></head>
<body><main><div class="card"><div class="logo"><span class="mark">YK</span><b>YK Sync</b></div><h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}${msg ? `<div class="msg${ok ? ' ok' : ''}" role="alert">${esc(msg)}</div>` : ''}${body}</div></main>
<footer><span>Autoline → Shopify sync · Y.K. Almoayyed &amp; Sons</span></footer>
<script>document.addEventListener('click',function(e){var b=e.target.closest('[data-eye]');if(!b)return;var i=document.getElementById(b.getAttribute('data-eye'));var show=i.type==='password';i.type=show?'text':'password';b.innerHTML=show?${JSON.stringify(EYE_OFF)}:${JSON.stringify(EYE)};b.setAttribute('aria-label',show?'Hide password':'Show password');b.title=show?'Hide password':'Show password';i.focus();});</script>
</body></html>`;
}
const loginPage = (msg) =>
  page('Sign in', 'Autoline → Shopify sync dashboard', `<form method="post" action="/login">
<div class="fld"><label for="u">Username</label><input id="u" name="user" autocomplete="username" required autofocus></div>
${pwField('p', 'pass', 'Password', 'current-password')}
<div class="actions"><button class="btn" type="submit">Sign in</button></div></form>`, msg);
const verifyPage = (p, msg, ok) =>
  page('Enter code', `We emailed a code to <b>${esc(mask(find(p.user).email))}</b>. Please enter the code to sign in. It is valid for ${OTP_MINUTES} minutes.`, `<form method="post" action="/verify">
<div class="fld"><label for="c">Code</label><input id="c" class="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="••••••" required autofocus></div>
<div class="actions"><button class="btn" type="submit">Verify</button></div></form>
<form method="post" action="/verify" class="row"><span>Didn't receive it? Check your junk folder.</span><button class="link" name="resend" value="1">Send a new code</button></form>
<form method="post" action="/logout" class="row"><span></span><button class="link">Sign in with a different account</button></form>`, msg, ok);
const changePage = (u, msg) =>
  page(u.mustChange ? 'Update your password' : 'Change password', u.mustChange ? 'You need to set your own password because this is the first time you are signing in.' : 'Signed in as <b>' + esc(u.user) + '</b>', `<form method="post" action="/change-password">
${pwField('o', 'current', 'Current password', 'current-password', 'autofocus')}
${pwField('n', 'next', 'New password', 'new-password', `minlength="${MIN_PASSWORD}"`)}
<div class="hint">At least ${MIN_PASSWORD} characters, and it must not contain your username.</div>
${pwField('r', 'repeat', 'Confirm new password', 'new-password')}
<div class="actions">${u.mustChange ? '' : '<a class="btn sec" href="/" style="display:inline-grid;place-items:center;text-decoration:none">Cancel</a>'}<button class="btn" type="submit">Save</button></div></form>
${u.mustChange ? '<form method="post" action="/logout" class="row"><span></span><button class="link">Sign out</button></form>' : ''}`, msg);

function html(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(body);
}
function redirect(res, to, headers = {}) {
  res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...headers });
  res.end();
}
function readForm(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e4) req.destroy(); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(d))));
    req.on('error', () => resolve({}));
  });
}

function startSession(res, u, ip) {
  const id = crypto.randomBytes(32).toString('hex');
  const hours = Math.max(1, config.server.sessionHours || 12);
  SESS.set(id, { user: u.user, exp: Date.now() + hours * 3600000 });
  u.lastLoginAt = new Date().toISOString();
  u.lastLoginIp = ip;
  saveUsers();
  logger.info('login_ok', { ip, user: u.user });
  redirect(res, u.mustChange ? '/change-password' : '/', { 'Set-Cookie': [cookie('yk_sess', id, hours * 3600), cookie('yk_pend', '', 0)] });
}
// Google/Material-style HTML email. Inline styles only (email clients ignore <style>/JS).
function emailShell(title, inner, footerNote) {
  return `<div style="margin:0;padding:32px 16px;background:#f6f8fc;font-family:'Poppins','Roboto','Segoe UI',Arial,sans-serif;color:#202124;-webkit-font-smoothing:antialiased;">
<div style="max-width:460px;margin:0 auto;background:#ffffff;border:1px solid #e3e6eb;border-radius:16px;overflow:hidden;">
<div style="padding:26px 32px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;"><div style="width:34px;height:34px;border-radius:9px;background:#1a73e8;color:#ffffff;text-align:center;line-height:34px;font-weight:700;font-size:13px;font-family:Arial,sans-serif;">YK</div></td>
<td style="vertical-align:middle;padding-left:12px;font-weight:600;color:#5f6368;font-size:15px;">YK Sync</td>
</tr></table>
</div>
<div style="padding:4px 32px 28px;">${inner}</div>
${footerNote ? `<div style="border-top:1px solid #eef0f3;padding:16px 32px;background:#fafbfc;color:#80868b;font-size:12px;line-height:1.6;">${footerNote}</div>` : ''}
</div>
<p style="text-align:center;color:#9aa0a6;font-size:11px;margin:18px 0 0;">Autoline &rarr; Shopify sync &middot; Y.K. Almoayyed &amp; Sons</p>
</div>`;
}
async function sendOtp(p, ip) {
  const u = find(p.user);
  p.code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  p.exp = Date.now() + OTP_MINUTES * 60000;
  p.tries = 0;
  p.sends = (p.sends || 0) + 1;
  p.sentAt = Date.now();
  const when = new Date().toUTCString();
  const inner =
    `<h1 style="font-size:22px;font-weight:600;margin:16px 0 4px;color:#202124;">Your sign-in code</h1>` +
    `<p style="color:#5f6368;font-size:14px;margin:0 0 20px;">Enter this code to sign in to the dashboard.</p>` +
    `<div style="background:#f0f4f9;border:1px solid #e3e6eb;border-radius:12px;padding:20px;text-align:center;margin:0 0 16px;">` +
    `<div style="font-size:36px;font-weight:700;letter-spacing:10px;color:#1a73e8;font-family:'Roboto Mono',Consolas,monospace;">${p.code}</div></div>` +
    `<p style="color:#5f6368;font-size:13px;margin:0;">This code is valid for ${OTP_MINUTES} minutes and can be used once. You can also copy it from the email subject line.</p>`;
  const footer = `Sign-in attempt for <b style="color:#5f6368;">${esc(u.user)}</b> from IP ${esc(ip)}<br>on ${esc(when)}.<br>If this wasn't you, someone may know your password &mdash; please ask your administrator to reset it.`;
  await sendMail({
    to: u.email,
    fromName: 'Shopify Autoline Sync',
    subject: `YK Sync sign-in code: ${p.code}`,
    text: `Your sign-in code for the YK Sync dashboard is:\n\n    ${p.code}\n\nIt is valid for ${OTP_MINUTES} minutes and can be used once.\n\nSign-in attempt for user "${u.user}" from IP ${ip} at ${when}.\nIf this was not you, someone knows your password: please ask your administrator to reset it.`,
    html: emailShell('Your sign-in code', inner, footer),
  });
  logger.info('login_otp_sent', { user: u.user, ip, to: mask(u.email) });
}

// ---------- page routes (/login, /verify, /logout, /change-password) ----------
// Returns true when the request was handled here.
async function handlePages(req, res, url) {
  const ip = clientIp(req);
  const p = url.pathname;

  if (p === '/logout' && req.method === 'POST') {
    const c = cookies(req);
    if (c.yk_sess) SESS.delete(c.yk_sess);
    if (c.yk_pend) PEND.delete(c.yk_pend);
    redirect(res, '/login', { 'Set-Cookie': [cookie('yk_sess', '', 0), cookie('yk_pend', '', 0)] });
    return true;
  }

  if (p === '/login') {
    if (req.method === 'GET') {
      if (currentUser(req)) redirect(res, '/');
      else html(res, 200, loginPage(''));
      return true;
    }
    if (req.method !== 'POST') return false;
    if (locked(ip)) {
      logger.warn('login_locked', { ip });
      html(res, 429, loginPage(`Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.`));
      return true;
    }
    const form = await readForm(req);
    const u = find(form.user);
    const ok = checkPw(u, form.pass);
    if (!ok || u.disabled) {
      fail(ip);
      logger.warn('login_failed', { ip, user: String(form.user || '').slice(0, 40), reason: ok ? 'disabled' : 'wrong password' });
      html(res, 401, loginPage('Wrong username or password.'));
      return true;
    }
    if (!otpOn()) {
      FAILS.delete(ip);
      startSession(res, u, ip);
      return true;
    }
    if (!validEmail(u.email)) {
      logger.warn('login_no_email', { ip, user: u.user });
      html(res, 403, loginPage('No email is set for this user, so the sign-in code cannot be sent. Ask your administrator.'));
      return true;
    }
    if (!smtpReady()) {
      logger.error('login_smtp_missing', { user: u.user });
      html(res, 503, loginPage('Email is not configured on the server, so the sign-in code cannot be sent.'));
      return true;
    }
    FAILS.delete(ip);
    const id = crypto.randomBytes(32).toString('hex');
    const pend = { user: u.user, ip };
    try {
      await sendOtp(pend, ip);
    } catch (e) {
      logger.error('login_otp_send_failed', { user: u.user, error: e.message });
      html(res, 503, loginPage('Could not send the sign-in code. Try again in a minute.'));
      return true;
    }
    PEND.set(id, pend);
    redirect(res, '/verify', { 'Set-Cookie': cookie('yk_pend', id, OTP_MINUTES * 60 + 60) });
    return true;
  }

  if (p === '/verify') {
    const id = cookies(req).yk_pend;
    const pend = id && PEND.get(id);
    if (!pend || !find(pend.user)) {
      if (req.method === 'POST') await readForm(req);
      redirect(res, '/login');
      return true;
    }
    if (req.method === 'GET') {
      html(res, 200, verifyPage(pend, ''));
      return true;
    }
    if (req.method !== 'POST') return false;
    const form = await readForm(req);
    if (form.resend) {
      const wait = Math.ceil((pend.sentAt + RESEND_SECONDS * 1000 - Date.now()) / 1000);
      if (wait > 0) html(res, 429, verifyPage(pend, `Please wait ${wait} seconds before asking for a new code.`));
      else if (pend.sends >= MAX_OTP_SENDS) {
        PEND.delete(id);
        html(res, 429, loginPage('Too many codes requested. Sign in again.'), { 'Set-Cookie': cookie('yk_pend', '', 0) });
      } else {
        try {
          await sendOtp(pend, ip);
          html(res, 200, verifyPage(pend, 'A new code was sent.', true));
        } catch (e) {
          logger.error('login_otp_send_failed', { user: pend.user, error: e.message });
          html(res, 503, verifyPage(pend, 'Could not send the code. Try again in a minute.'));
        }
      }
      return true;
    }
    if (pend.exp < Date.now()) {
      PEND.delete(id);
      html(res, 401, loginPage('The code expired. Sign in again.'), { 'Set-Cookie': cookie('yk_pend', '', 0) });
      return true;
    }
    const code = String(form.code || '').replace(/\D/g, '');
    const good = code.length === 6 && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(pend.code));
    if (!good) {
      pend.tries++;
      logger.warn('login_otp_wrong', { ip, user: pend.user, tries: pend.tries });
      if (pend.tries >= MAX_OTP_TRIES) {
        PEND.delete(id);
        fail(ip);
        html(res, 401, loginPage('Too many wrong codes. Sign in again.'), { 'Set-Cookie': cookie('yk_pend', '', 0) });
      } else html(res, 401, verifyPage(pend, `Wrong code. ${MAX_OTP_TRIES - pend.tries} tries left.`));
      return true;
    }
    PEND.delete(id);
    const u = find(pend.user);
    if (!u || u.disabled) {
      redirect(res, '/login', { 'Set-Cookie': cookie('yk_pend', '', 0) });
      return true;
    }
    startSession(res, u, ip);
    return true;
  }

  if (p === '/change-password') {
    const u = currentUser(req);
    if (!u) {
      if (req.method === 'POST') await readForm(req);
      redirect(res, '/login');
      return true;
    }
    if (req.method === 'GET') {
      html(res, 200, changePage(u, ''));
      return true;
    }
    if (req.method !== 'POST') return false;
    const form = await readForm(req);
    if (!checkPw(u, form.current)) {
      logger.warn('password_change_failed', { ip, user: u.user, reason: 'wrong current password' });
      html(res, 401, changePage(u, 'Current password is wrong.'));
      return true;
    }
    const prob = passwordProblem(u.user, form.next) || (form.next !== form.repeat ? 'The new passwords do not match.' : null) || (checkPw(u, form.next) ? 'Choose a password different from the current one.' : null);
    if (prob) {
      html(res, 400, changePage(u, prob));
      return true;
    }
    Object.assign(u, hashPw(form.next), { mustChange: false, passwordChangedAt: new Date().toISOString() });
    saveUsers();
    // Sign out other browsers of this user, keep this one
    const mine = cookies(req).yk_sess;
    for (const [k, s] of SESS) if (k !== mine && s.user.toLowerCase() === u.user.toLowerCase()) SESS.delete(k);
    logger.info('password_changed', { ip, user: u.user });
    redirect(res, '/');
    return true;
  }
  return false;
}

// ---------- Users API (admin only) ----------
const pub = (u) => ({ user: u.user, email: u.email, role: u.role, disabled: !!u.disabled, mustChange: !!u.mustChange, createdAt: u.createdAt, createdBy: u.createdBy, lastLoginAt: u.lastLoginAt || null, lastLoginIp: u.lastLoginIp || null });
function listUsers() {
  return users().map(pub);
}
async function userAction(me, body, req) {
  const a = body.action;
  const name = String(body.user || '').trim();
  const by = me ? me.user : 'admin-token';
  if (a === 'add') {
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(name)) return { error: 'Username: 3-32 letters, numbers, dot, dash or underscore.' };
    if (find(name)) return { error: 'This username already exists.' };
    if (!validEmail(body.email)) return { error: 'Enter a valid email address.' };
    const role = body.role === 'admin' ? 'admin' : 'viewer';
    const temp = tempPassword();
    USERS.push({ user: name, email: String(body.email).trim(), role, ...hashPw(temp), mustChange: true, disabled: false, createdAt: new Date().toISOString(), createdBy: by });
    saveUsers();
    logger.info('user_added', { user: name, role, by });
    let mailed = false;
    if (smtpReady()) {
      const link = `http://${req.headers.host || 'localhost'}/login`;
      try {
        const winner =
          `<h1 style="font-size:22px;font-weight:600;margin:16px 0 4px;color:#202124;">Welcome to YK Sync</h1>` +
          `<p style="color:#5f6368;font-size:14px;margin:0 0 20px;">An account was created for you on the Autoline &rarr; Shopify sync dashboard.</p>` +
          `<div style="background:#f0f4f9;border:1px solid #e3e6eb;border-radius:12px;padding:16px 18px;margin:0 0 20px;font-size:14px;">` +
          `<div style="color:#5f6368;">Username</div><div style="font-weight:600;font-size:16px;margin-top:2px;">${esc(name)}</div></div>` +
          `<a href="${esc(link)}" style="display:inline-block;background:#1a73e8;color:#ffffff;text-decoration:none;font-weight:500;font-size:14px;padding:11px 24px;border-radius:999px;">Open sign-in page</a>` +
          `<p style="color:#5f6368;font-size:13px;margin:20px 0 0;">Your temporary password will be shared with you separately by <b style="color:#5f6368;">${esc(by)}</b>. At your first sign-in you'll receive a code by email and be asked to set your own password.</p>`;
        await sendMail({
          to: String(body.email).trim(),
          fromName: 'Shopify Autoline Sync',
          subject: 'Your YK Sync dashboard account',
          text: `An account was created for you on the YK Sync (Autoline → Shopify) dashboard.\n\nUsername: ${name}\nSign in: ${link}\n\nYour temporary password will be shared with you separately by ${by}. At the first sign-in you will receive a code by email and you will be asked to set your own password.`,
          html: emailShell('Your YK Sync account', winner, ''),
        });
        mailed = true;
      } catch (e) {
        logger.warn('user_welcome_mail_failed', { user: name, error: e.message });
      }
    }
    return { ok: true, user: name, tempPassword: temp, mailed };
  }
  const u = find(name);
  if (!u) return { error: 'User not found.' };
  const self = me && me.user.toLowerCase() === u.user.toLowerCase();
  const lastAdmin = u.role === 'admin' && !u.disabled && activeAdmins().length <= 1;
  if (a === 'reset') {
    const temp = tempPassword();
    Object.assign(u, hashPw(temp), { mustChange: true });
    saveUsers();
    killSessions(u.user);
    logger.info('user_password_reset', { user: u.user, by });
    return { ok: true, user: u.user, tempPassword: temp };
  }
  if (a === 'disable' || a === 'enable') {
    if (a === 'disable' && self) return { error: 'You cannot disable your own account.' };
    if (a === 'disable' && lastAdmin) return { error: 'At least one active admin is needed.' };
    u.disabled = a === 'disable';
    saveUsers();
    if (u.disabled) killSessions(u.user);
    logger.info('user_' + a + 'd', { user: u.user, by });
    return { ok: true };
  }
  if (a === 'update') {
    if (body.email !== undefined && !validEmail(body.email)) return { error: 'Enter a valid email address.' };
    const role = body.role === 'admin' ? 'admin' : body.role === 'viewer' ? 'viewer' : u.role;
    if (role !== 'admin' && lastAdmin) return { error: 'At least one active admin is needed.' };
    if (body.email !== undefined) u.email = String(body.email).trim();
    u.role = role;
    saveUsers();
    logger.info('user_updated', { user: u.user, role, by });
    return { ok: true };
  }
  if (a === 'delete') {
    if (self) return { error: 'You cannot delete your own account.' };
    if (lastAdmin) return { error: 'At least one active admin is needed.' };
    USERS = users().filter((x) => x !== u);
    saveUsers();
    killSessions(u.user);
    logger.info('user_deleted', { user: u.user, by });
    return { ok: true };
  }
  return { error: 'Unknown action.' };
}

module.exports = { enabled, currentUser, handlePages, listUsers, userAction, clientIp, otpOn, smtpReady };
