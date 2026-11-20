'use strict';
// Minimal SMTP client (no packages). Port 465 = TLS, other ports = STARTTLS (e.g. 587 for Office 365 / Gmail).
// .env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL_FROM, ALERT_EMAIL_TO
const net = require('net');
const tls = require('tls');
const os = require('os');
const { config } = require('./config');

function session(socket) {
  let buf = '';
  let waiter = null;
  const onData = (d) => {
    buf += d.toString('utf8');
    // a complete reply ends with a line "NNN text" (space after the code)
    const lines = buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const reply = lines.slice(0, i + 1).join('\n');
        buf = lines.slice(i + 1).join('\r\n');
        if (waiter) { const w = waiter; waiter = null; w.resolve(reply); }
        return;
      }
    }
  };
  const onErr = (e) => { if (waiter) { const w = waiter; waiter = null; w.reject(e); } };
  socket.on('data', onData);
  socket.on('error', onErr);
  const read = () => new Promise((resolve, reject) => { waiter = { resolve, reject }; });
  const cmd = async (line, expect) => {
    if (line !== null) socket.write(line + '\r\n');
    const reply = await read();
    const code = Number(reply.slice(0, 3));
    if (!expect.includes(code)) {
      const shown = line && line.startsWith('AUTH') ? 'AUTH' : line;
      throw new Error(`SMTP ${shown || 'greeting'} failed: ${reply.split('\n').pop()}`);
    }
    return reply;
  };
  return { cmd, detach: () => { socket.removeListener('data', onData); socket.removeListener('error', onErr); } };
}

function connect(host, port, secure) {
  return new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    s.setTimeout(30000, () => s.destroy(new Error('SMTP timeout')));
    s.once(secure ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', reject);
  });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

async function sendMail({ to, subject, text, html, fromName }) {
  const { host, port, user, pass } = config.alerts.smtp;
  const from = config.alerts.emailFrom || user;
  const rcpts = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!host || !from || !rcpts.length) throw new Error('SMTP_HOST, sender and ALERT_EMAIL_TO are required');

  const secure = port === 465;
  let socket = await connect(host, port, secure);
  let s = session(socket);
  try {
    await s.cmd(null, [220]);
    const name = os.hostname() || 'autoline-sync';
    let ehlo = await s.cmd(`EHLO ${name}`, [250]);
    if (!secure && /STARTTLS/i.test(ehlo)) {
      await s.cmd('STARTTLS', [220]);
      s.detach();
      socket = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket, servername: host }, () => resolve(t));
        t.once('error', reject);
      });
      s = session(socket);
      ehlo = await s.cmd(`EHLO ${name}`, [250]);
    }
    if (user) {
      await s.cmd('AUTH LOGIN', [334]);
      await s.cmd(b64(user), [334]);
      await s.cmd(b64(pass), [235]);
    }
    await s.cmd(`MAIL FROM:<${from}>`, [250]);
    for (const r of rcpts) await s.cmd(`RCPT TO:<${r}>`, [250, 251]);
    await s.cmd('DATA', [354]);
    const stuff = (t) => String(t).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const headers = [
      `From: ${header(fromName || 'Shopify Autoline Sync')} <${from}>`,
      `To: ${rcpts.join(', ')}`,
      `Subject: ${header(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
    ];
    let msg;
    if (html) {
      const boundary = 'yk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      msg = headers.concat([
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        stuff(text || ''),
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        stuff(html),
        `--${boundary}--`,
        '.',
      ]).join('\r\n');
    } else {
      msg = headers.concat([
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        stuff(text),
        '.',
      ]).join('\r\n');
    }
    await s.cmd(msg, [250]);
    await s.cmd('QUIT', [221]).catch(() => {});
    return true;
  } finally {
    socket.end();
  }
}

// ---------- shared Google/Material-style HTML email ----------
function emailEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
// title: used nowhere visible (kept for clarity); inner: HTML body; footerNote: small grey note (optional)
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

module.exports = { sendMail, emailShell, emailEsc };

// CLI test: node src/mailer.js you@example.com
if (require.main === module) {
  const to = process.argv[2] ? [process.argv[2]] : config.alerts.emailTo;
  const inner =
    '<h1 style="font-size:22px;font-weight:600;margin:16px 0 8px;color:#202124;">Test email</h1>' +
    '<p style="color:#444746;font-size:14px;margin:0;line-height:1.6;">If you can read this, email alerts from the Shopify Autoline Sync dashboard are working correctly.</p>';
  sendMail({ to, subject: 'Shopify Autoline Sync — test email', text: 'If you can read this, alert emails work.', html: emailShell('Test email', inner, 'Sent ' + new Date().toUTCString() + ' from the Shopify Autoline Sync dashboard.') })
    .then(() => console.log('Email sent to ' + to.join(', ')))
    .catch((e) => { console.error('Email failed: ' + e.message); process.exit(1); });
}
