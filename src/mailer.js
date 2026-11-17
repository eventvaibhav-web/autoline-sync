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

async function sendMail({ to, subject, text }) {
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
    const body = String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const msg = [
      `From: Autoline Sync <${from}>`,
      `To: ${rcpts.join(', ')}`,
      `Subject: ${header(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
      '.',
    ].join('\r\n');
    await s.cmd(msg, [250]);
    await s.cmd('QUIT', [221]).catch(() => {});
    return true;
  } finally {
    socket.end();
  }
}

module.exports = { sendMail };

// CLI test: node src/mailer.js you@example.com
if (require.main === module) {
  const to = process.argv[2] ? [process.argv[2]] : config.alerts.emailTo;
  sendMail({ to, subject: 'Autoline sync test email', text: 'If you can read this, alert emails work.' })
    .then(() => console.log('Email sent to ' + to.join(', ')))
    .catch((e) => { console.error('Email failed: ' + e.message); process.exit(1); });
}
