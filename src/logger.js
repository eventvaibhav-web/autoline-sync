'use strict';
// JSONL logs (one file per day in logs/), 12-month retention, alerts.
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

fs.mkdirSync(config.logs.dir, { recursive: true });

const recent = []; // in-memory ring buffer for the dashboard
const RECENT_MAX = 1000;

function dayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10); // UTC date, YYYY-MM-DD
}

function log(level, event, data = {}) {
  const entry = { ts: new Date().toISOString(), level, event, ...data };
  try {
    fs.appendFileSync(path.join(config.logs.dir, `sync-${dayStamp()}.jsonl`), JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('Could not write log file:', e.message);
  }
  recent.push(entry);
  if (recent.length > RECENT_MAX) recent.shift();
  const extra = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  const line = `[${entry.ts}] ${level.toUpperCase().padEnd(5)} ${event}${extra}`;
  if (level === 'error' || level === 'alert') console.error(line);
  else console.log(line);
  return entry;
}

const logger = {
  info: (e, d) => log('info', e, d),
  warn: (e, d) => log('warn', e, d),
  error: (e, d) => log('error', e, d),
  change: (e, d) => log('change', e, d),
  skip: (e, d) => log('skip', e, d),
  recent: (n = 200) => recent.slice(-n).reverse(),
};

function readLogFile(date, limit = 500) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const p = path.join(config.logs.dir, `sync-${date}.jsonl`);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

function listLogDates() {
  return fs
    .readdirSync(config.logs.dir)
    .map((f) => (f.match(/^sync-(\d{4}-\d{2}-\d{2})\.jsonl$/) || [])[1])
    .filter(Boolean)
    .sort()
    .reverse();
}

function cleanupOldLogs() {
  const cutoff = Date.now() - config.logs.retentionDays * 86400000;
  let removed = 0;
  for (const d of listLogDates()) {
    if (new Date(d + 'T00:00:00Z').getTime() < cutoff) {
      fs.unlinkSync(path.join(config.logs.dir, `sync-${d}.jsonl`));
      removed++;
    }
  }
  if (removed) logger.info('log_cleanup', { removedFiles: removed, retentionDays: config.logs.retentionDays });
}

// ---------- Alerts ----------
const lastAlertAt = {};
async function alert(key, message, data = {}, { force = false } = {}) {
  const now = Date.now();
  const cooldown = config.alerts.cooldownMinutes * 60000;
  if (!force && lastAlertAt[key] && now - lastAlertAt[key] < cooldown) return false;
  lastAlertAt[key] = now;
  log('alert', key, { message, ...data });
  if (config.alerts.webhookUrl) {
    try {
      const res = await fetch(config.alerts.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `[Autoline-Shopify Sync] ${message}` }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) log('error', 'alert_webhook_failed', { status: res.status });
    } catch (e) {
      log('error', 'alert_webhook_failed', { error: e.message });
    }
  }
  if (config.alerts.emailTo.length && config.alerts.smtp.host) {
    try {
      const mailer = require('./mailer');
      const esc = mailer.emailEsc;
      const title = String(key).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
      const severe = /short|error|fail|down|unreachable/i.test(key);
      const accent = severe ? '#d93025' : '#b06000';
      const accentBg = severe ? '#fce8e6' : '#fef7e0';
      const rows = Object.entries(data || {})
        .map(([k, v]) => `<tr><td style="padding:7px 0;color:#5f6368;font-size:13px;width:140px;vertical-align:top;">${esc(k)}</td><td style="padding:7px 0;font-size:13px;color:#202124;word-break:break-word;">${esc(String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/#{2,}/g, '#'))}</td></tr>`)
        .join('');
      const inner =
        `<div style="display:inline-block;background:${accentBg};color:${accent};font-size:12px;font-weight:600;padding:4px 12px;border-radius:999px;margin:16px 0 10px;">Alert</div>` +
        `<h1 style="font-size:20px;font-weight:600;margin:4px 0 10px;color:#202124;">${esc(title)}</h1>` +
        `<p style="color:#444746;font-size:14px;margin:0 0 16px;line-height:1.6;">${esc(String(message).replace(/#{2,}/g, '#'))}</p>` +
        (rows ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-top:1px solid #eef0f3;">${rows}</table>` : '');
      await mailer.sendMail({
        to: config.alerts.emailTo,
        subject: `[Shopify Autoline Sync] ${title}`,
        text: `${message}\n\n${JSON.stringify(data, null, 2)}\n\nTime: ${new Date().toISOString()}`,
        html: mailer.emailShell(title, inner, 'Sent ' + new Date().toUTCString() + ' by the Shopify Autoline Sync dashboard.'),
      });
    } catch (e) {
      log('error', 'alert_email_failed', { error: e.message });
    }
  }
  return true;
}

module.exports = { logger, alert, readLogFile, listLogDates, cleanupOldLogs };
