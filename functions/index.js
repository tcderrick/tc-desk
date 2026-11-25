// TC Desk server: sends team email from the TC mailbox, sends scheduled email on time,
// files mail sent to each deal's file address, and pushes notifications.
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onMessagePublished } = require('firebase-functions/v2/pubsub');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const PROJECT = process.env.GCLOUD_PROJECT || 'tc-desk';
const SA = `tc-desk-mail@${PROJECT}.iam.gserviceaccount.com`;
const TOPIC = 'gmail-in';
const APP_URL = 'https://app.derrick.club';
const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];
const ADMINS = String(process.env.ADMINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

setGlobalOptions({ region: 'us-west2', serviceAccount: SA, maxInstances: 3 });

/* ---------- helpers ---------- */
const dec = d => (d && typeof d.__json === 'string') ? JSON.parse(d.__json) : d;
const hasNested = (v, inArr) => {
  if (Array.isArray(v)) { if (inArr) return true; return v.some(x => hasNested(x, true)); }
  if (v && typeof v === 'object') return Object.values(v).some(x => hasNested(x, false));
  return false;
};
const enc = d => hasNested(d, false) ? { __json: JSON.stringify(d) } : d;
const clean = o => JSON.parse(JSON.stringify(o));
const addrOf = v => String(v || '').toLowerCase().replace(/.*</, '').replace(/>.*/, '').trim();
const splitList = v => String(v || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
async function setting(id) { const s = await db.doc('settings/' + id).get(); return s.exists ? dec(s.data()) : {}; }
const mailboxOf = cfg => addrOf(cfg.fileBase) || ADMINS[0] || '';
async function isTeam(email) {
  if (!email) return false; if (ADMINS.includes(email)) return true;
  const s = await db.doc('logins/' + email).get(); return s.exists;
}
async function status(patch) {
  const ref = db.doc('settings/srvstatus'); const cur = (await ref.get()).data() || {};
  const next = Object.assign({}, cur, patch, { id: 'srvstatus' });
  const keys = ['ok', 'sendOk', 'mailOk', 'watchOk', 'err', 'mailErr', 'watchErr', 'outErr', 'box', 'clientId'];
  const changed = keys.some(k => JSON.stringify(cur[k]) !== JSON.stringify(next[k]));
  if (changed || !cur.at || Date.now() - cur.at > 10 * 60e3) { next.at = Date.now(); next.updatedAt = Date.now(); await ref.set(clean(next)); }
}

/* ---------- Google tokens (no keys: the server signs its own requests) ---------- */
async function saToken() {
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  if (!r.ok) throw new Error('metadata token ' + r.status); return (await r.json()).access_token;
}
const tokCache = {};
async function mailToken(sub) {
  const c = tokCache[sub]; if (c && c.exp > Date.now() + 120e3) return c.t;
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: SA, sub, scope: SCOPES.join(' '), aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const r = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:signJwt`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + await saToken(), 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: JSON.stringify(claims) })
  });
  const j = await r.json(); if (!r.ok) throw new Error('Could not sign: ' + ((j.error && j.error.message) || r.status));
  const r2 = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: j.signedJwt }) });
  const j2 = await r2.json();
  if (!r2.ok) { const e = new Error('Google Workspace has not allowed TC Desk to use this mailbox yet (' + (j2.error_description || j2.error || r2.status) + ')'); e.code = 'dwd'; throw e; }
  tokCache[sub] = { t: j2.access_token, exp: Date.now() + 3500e3 }; return j2.access_token;
}
async function gmail(box, path, opt = {}) {
  const url = path.startsWith('http') ? path : 'https://gmail.googleapis.com/gmail/v1/users/me/' + path;
  const r = await fetch(url, Object.assign({}, opt, { headers: Object.assign({ Authorization: 'Bearer ' + await mailToken(box) }, opt.json ? { 'Content-Type': 'application/json' } : {}, opt.headers || {}), body: opt.json ? JSON.stringify(opt.json) : opt.body }));
  if (!r.ok) { let m = ''; try { m = (await r.json()).error.message } catch (e) {} const e = new Error(m || ('Gmail ' + r.status)); e.status = r.status; throw e; }
  return r.json();
}

/* ---------- building and sending email ---------- */
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const wrap76 = s => s.replace(/.{1,76}/g, m => m + '\r\n');
const hdr = s => /[^\x20-\x7e]/.test(s) ? '=?UTF-8?B?' + b64(s) + '?=' : s;
const addrHdr = list => splitList(list).map(a => { const m = /^(.*)<([^>]+)>$/.exec(a); return m && m[1].trim() ? hdr(m[1].trim().replace(/^"|"$/g, '')) + ' <' + m[2].trim() + '>' : a; }).join(', ');
function buildMime({ from, to, cc, bcc, subject, html, text, files, replyTo }) {
  const imgs = []; let n = 0;
  html = String(html || '').replace(/src=(["'])data:(image\/[a-z+.-]+);base64,([^"']+)\1/gi, (all, q, type, data) => { const id = 'img' + (++n) + '.' + Date.now().toString(36) + '@tcdesk'; imgs.push({ id, type, data }); return `src=${q}cid:${id}${q}`; });
  const R = 'rel_' + Date.now().toString(36), A = 'alt_' + Math.random().toString(36).slice(2), M = 'mix_' + Math.random().toString(36).slice(2);
  const att = files || []; const L = [];
  if (from) L.push('From: ' + addrHdr(from));
  L.push('To: ' + addrHdr(to)); if (cc) L.push('Cc: ' + addrHdr(cc)); if (bcc) L.push('Bcc: ' + addrHdr(bcc));
  if (replyTo) L.push('Reply-To: ' + addrHdr(replyTo));
  L.push('Subject: ' + hdr(subject || ''), 'MIME-Version: 1.0');
  if (att.length) L.push(`Content-Type: multipart/mixed; boundary="${M}"`, '', `--${M}`);
  L.push(`Content-Type: multipart/related; boundary="${R}"`, '', `--${R}`, `Content-Type: multipart/alternative; boundary="${A}"`, '', `--${A}`,
    'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(b64(text || '')),
    `--${A}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(b64(html || '')), `--${A}--`);
  imgs.forEach(im => L.push(`--${R}`, `Content-Type: ${im.type}`, 'Content-Transfer-Encoding: base64', `Content-ID: <${im.id}>`, 'Content-Disposition: inline', '', wrap76(im.data.replace(/\s+/g, ''))));
  L.push(`--${R}--`);
  att.forEach(f => { const nm = String(f.name || 'file').replace(/["\r\n]/g, ''); const en = /[^\x20-\x7e]/.test(nm) ? `filename*=UTF-8''${encodeURIComponent(nm)}` : `filename="${nm}"`;
    L.push(`--${M}`, `Content-Type: ${f.type || 'application/octet-stream'}; name="${hdr(nm)}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; ${en}`, '', wrap76(String(f.data || '').replace(/\s+/g, ''))); });
  if (att.length) L.push(`--${M}--`);
  L.push(''); return L.join('\r\n');
}
async function sendOne(m, byEmail, cfg) {
  const box = mailboxOf(cfg); if (!box) throw new Error('No team mailbox is set');
  const allowed = splitList(cfg.from);
  let from = m.from || '';
  if (allowed.length) { if (!allowed.some(a => addrOf(a) === addrOf(from))) from = allowed[0]; } else from = box;
  let cc = m.cc || ''; const ccTo = String(cfg.ccTo || '').trim();
  if (!m.noCc && cfg.cc && ccTo && byEmail !== ccTo.toLowerCase() && !(String(m.to) + ',' + cc + ',' + String(m.bcc || '')).toLowerCase().includes(ccTo.toLowerCase())) cc = cc ? cc + ', ' + ccTo : ccTo;
  if (!splitList(m.to).length && !splitList(cc).length && !splitList(m.bcc).length) throw new Error('Add at least one recipient');
  // Portal invites carry %%SIGNIN_LINK%%: swap in a one-tap sign-in link for the person it's addressed to.
  if (/%%SIGNIN_LINK%%/.test(String(m.html || '') + String(m.text || ''))) {
    const who = addrOf(splitList(m.to)[0]); let link = APP_URL + '/';
    try { if (who) link = await admin.auth().generateSignInWithEmailLink(who, { url: APP_URL + '/?le=' + encodeURIComponent(who), handleCodeInApp: true }); } catch (e) { console.warn('invite link', e.message); }
    const r = s => String(s || '').split('%%SIGNIN_LINK%%').join(link);
    m = Object.assign({}, m, { html: r(m.html), text: r(m.text) });
  }
  const mime = buildMime({ from, to: m.to || '', cc, bcc: m.bcc || '', subject: m.subject || '', html: m.html || '', text: m.text || '', files: m.files || [], replyTo: m.replyTo || '' });
  const r = await gmail(box, 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media', { method: 'POST', body: mime, headers: { 'Content-Type': 'message/rfc822' } });
  return { id: r.id, from, cc };
}

/* ---------- scheduled and queued email ---------- */
async function getOutAtt(o) {
  const files = [];
  for (let i = 0; i < (o.att || []).length; i++) {
    const a = o.att[i]; let d = '';
    for (let c = 0; c < (a.n || 0); c++) { const x = await db.doc(`outatt/${o.id}_${i}_${c}`).get(); if (!x.exists) throw new Error('An attachment is missing (' + a.name + ')'); d += dec(x.data()).d || ''; }
    files.push({ name: a.name, type: a.type, data: d });
  }
  return files;
}
async function sendDoc(ref, cfg) {
  const claimed = await db.runTransaction(async tr => {
    const s = await tr.get(ref); if (!s.exists) return null; const o = Object.assign(dec(s.data()), { id: ref.id });
    if (o.st !== 'queued' || !o.sendAt || o.sendAt > Date.now() + 5000) return null;
    o.st = 'sending'; o.sAt = Date.now(); tr.set(ref, enc(clean(o))); return o;
  });
  if (!claimed) return false;
  const o = claimed;
  try {
    const files = await getOutAtt(o);
    const r = await sendOne({ from: o.from, to: o.to, cc: o.cc, bcc: o.bcc, subject: o.subject, html: o.html, text: o.text, files }, String(o.by || '').toLowerCase(), cfg || await setting('sending'));
    o.st = 'sent'; o.sentAt = Date.now(); o.sentFrom = r.from; o.cc = r.cc; o.srv = true; delete o.err;
    await ref.set(enc(clean(o)));
    for (let i = 0; i < (o.att || []).length; i++) for (let c = 0; c < (o.att[i].n || 0); c++) await db.doc(`outatt/${o.id}_${i}_${c}`).delete().catch(() => {});
    return true;
  } catch (e) { o.st = 'failed'; o.err = e.message || 'Could not send'; await ref.set(enc(clean(o))); return false; }
}
async function sendDue(cfg) {
  const snap = await db.collection('outbox').where('st', '==', 'queued').get(); let n = 0;
  for (const d of snap.docs) { const o = dec(d.data()); if (o.sendAt && o.sendAt <= Date.now()) { if (await sendDoc(d.ref, cfg)) n++; } }
  return n;
}
// "Send" in TC Desk drops the email in the outbox with the time set to now; this sends it within seconds.
exports.outSend = onDocumentWritten({ document: 'outbox/{id}', memory: '512MiB', timeoutSeconds: 120 }, async ev => {
  const after = ev.data && ev.data.after; if (!after || !after.exists) return;
  const o = dec(after.data()); if (o.st !== 'queued' || !o.sendAt || o.sendAt > Date.now() + 5000) return;
  await sendDoc(after.ref);
});

/* ---------- file email: mail sent to each deal's address ---------- */
let codeCache = { at: 0, map: {} };
async function dealCodes() {
  if (Date.now() - codeCache.at < 5 * 60e3) return codeCache.map;
  const map = {};
  for (const col of ['transactions', 'archive']) {
    const s = await db.collection(col).get();
    s.docs.forEach(d => { const t = dec(d.data()); const f = (t && t.f) || {}; if (f.file_code) map[String(f.file_code).toLowerCase()] = { id: d.id, addr: f.address || '' }; });
  }
  codeCache = { at: Date.now(), map }; return map;
}
const b64u = s => String(s || '').replace(/-/g, '+').replace(/_/g, '/');
const txt = s => { try { return Buffer.from(b64u(s), 'base64').toString('utf8'); } catch (e) { return ''; } };
function walk(p, o) {
  if (!p) return o; const mt = (p.mimeType || '').toLowerCase(); const hd = {}; (p.headers || []).forEach(h => hd[h.name.toLowerCase()] = h.value);
  const disp = (hd['content-disposition'] || '').toLowerCase();
  if (p.filename && p.body && (p.body.attachmentId || p.body.data)) {
    const inlineImg = /^inline/.test(disp) && hd['content-id'] && /^image\//.test(mt) && (p.body.size || 0) < 200000;
    if (!inlineImg) o.atts.push({ name: p.filename, type: mt, size: p.body.size || 0, aid: p.body.attachmentId || '', data: p.body.data || '' });
  } else if (mt === 'text/html' && p.body && p.body.data && !o.html) o.html = txt(p.body.data);
  else if (mt === 'text/plain' && p.body && p.body.data && !o.text) o.text = txt(p.body.data);
  (p.parts || []).forEach(x => walk(x, o)); return o;
}
function boxRe(box) {
  const i = box.indexOf('@'); const q = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(q(box.slice(0, i)) + '\\+([a-z0-9-]+)@' + q(box.slice(i + 1)), 'gi');
}
async function importOne(box, id) {
  const md = await gmail(box, `messages/${id}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Delivered-To&metadataHeaders=X-Original-To`);
  const hs = ((md.payload && md.payload.headers) || []).map(h => h.value).join(', ');
  const re = boxRe(box); const found = []; let mm;
  while ((mm = re.exec(hs))) found.push(mm[1].toLowerCase());
  if (!found.length) return null; // not for a deal: no database reads at all
  // A reply to a client-chat email: tc+<code>-chat-<token>@...
  const ck = found.find(c => c.includes('-chat-'));
  let chatNote = '';
  if (ck) {
    const r = await chatReply(box, id, ck.slice(ck.lastIndexOf('-chat-') + 6));
    if (r === 'done' || r === 'dup') return null;
    if (r && r.atts) chatNote = r.atts; // posted to chat; attachments still go to File email below
    for (let i = 0; i < found.length; i++) if (found[i].includes('-chat-')) found[i] = found[i].slice(0, found[i].lastIndexOf('-chat-'));
  }
  let codes = await dealCodes(); if (!found.some(c => codes[c]) && Date.now() - codeCache.at > 30e3) { codeCache.at = 0; codes = await dealCodes(); }
  const k = found.find(c => codes[c]); const hit = k && codes[k];
  if (!hit) return null;
  if ((await db.doc('fmail/' + id).get()).exists) return null;
  const m = await gmail(box, `messages/${id}?format=full`);
  const hd = {}; ((m.payload && m.payload.headers) || []).forEach(h => hd[h.name.toLowerCase()] = h.value);
  const o = walk(m.payload, { html: '', text: '', atts: [] }); const atts = [];
  for (let i = 0; i < o.atts.length; i++) {
    const a = o.atts[i]; const meta = { name: a.name, type: a.type, size: a.size, n: 0 };
    if (a.size > 15 * 1048576) { meta.big = true; atts.push(meta); continue; }
    try {
      let d = a.data; if (!d && a.aid) d = (await gmail(box, `messages/${id}/attachments/${a.aid}`)).data;
      d = b64u(d || '').replace(/\s+/g, ''); const n = Math.max(1, Math.ceil(d.length / 700000));
      for (let c = 0; c < n; c++) await db.doc(`fmatt/${id}_${i}_${c}`).set({ d: d.slice(c * 700000, (c + 1) * 700000) });
      meta.n = n;
    } catch (e) { meta.big = true; }
    atts.push(meta);
  }
  let html = o.html, text = o.text; if (html.length > 700000) html = ''; if (text.length > 300000) text = text.slice(0, 300000);
  await db.doc('fmbody/' + id).set({ html, text });
  const unq = s => String(s || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const rec = { id, tx: hit.id, thread: m.threadId || '', from: hd.from || '', to: hd.to || '', cc: hd.cc || '', subject: hd.subject || '(no subject)',
    date: +m.internalDate || Date.now(), snippet: unq(m.snippet).slice(0, 200), atts, who: '', at: Date.now(), srv: true };
  await db.doc('fmail/' + id).set(rec);
  return { rec, addr: hit.addr };
}
async function notify(items) {
  if (!items.length) return;
  const snap = await db.collection('push').get(); const docs = snap.docs.map(d => ({ ref: d.ref, ...dec(d.data()) })).filter(x => x.token && x.on !== false);
  if (!docs.length) return;
  for (const it of items) {
    const name = (/^\s*"?([^"<]*?)"?\s*</.exec(it.rec.from) || [])[1] || addrOf(it.rec.from);
    const res = await admin.messaging().sendEachForMulticast({
      tokens: docs.map(x => x.token),
      data: { tx: it.rec.tx, fm: it.rec.id },
      webpush: { notification: { title: 'New email · ' + (it.addr || 'File email'), body: name + ': ' + it.rec.subject, icon: '/icon-192.png', tag: it.rec.id },
        fcmOptions: { link: `${APP_URL}/#v=detail&tx=${encodeURIComponent(it.rec.tx)}&tab=fmail` } }
    });
    res.responses.forEach((r, i) => { const c = r.error && r.error.code; if (c && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(c)) docs[i].ref.delete().catch(() => {}); });
  }
}
async function withLock(fn) {
  const ref = db.doc('srv/lock');
  const got = await db.runTransaction(async tr => { const s = (await tr.get(ref)).data() || {}; if (s.until && s.until > Date.now()) { tr.set(ref, { again: true }, { merge: true }); return false; } tr.set(ref, { until: Date.now() + 150e3, again: false }); return true; });
  if (!got) return false;
  try { for (let k = 0; k < 3; k++) { await fn(); const s = (await ref.get()).data() || {}; if (!s.again) break; await ref.set({ again: false }, { merge: true }); } }
  finally { await ref.set({ until: 0, again: false }, { merge: true }); }
  return true;
}
async function mailCheck(cfg) {
  const box = mailboxOf(cfg); if (!box) return 0;
  const ref = db.doc('srv/gmail'); let st = (await ref.get()).data() || {};
  if (st.box !== box) st = { box };
  const found = [];
  if (!st.historyId) {
    // First run: pick up anything from the last two days, then follow the mailbox history from here on.
    const prof = await gmail(box, 'profile'); const since = Math.floor((Date.now() - 2 * 864e5) / 1000);
    let pt = '', pages = 0; do { const r = await gmail(box, 'messages?maxResults=100&q=' + encodeURIComponent('after:' + since) + (pt ? '&pageToken=' + pt : ''));
      for (const m of (r.messages || [])) { const x = await importOne(box, m.id); if (x) found.push(x); } pt = r.nextPageToken || ''; pages++; } while (pt && pages < 5);
    st.historyId = prof.historyId;
  } else {
    let pt = '', ids = new Set(), last = st.historyId;
    try {
      do { const r = await gmail(box, `history?startHistoryId=${st.historyId}&historyTypes=messageAdded&maxResults=500` + (pt ? '&pageToken=' + pt : ''));
        (r.history || []).forEach(h => (h.messagesAdded || []).forEach(x => ids.add(x.message.id))); last = r.historyId || last; pt = r.nextPageToken || ''; } while (pt);
    } catch (e) { if (e.status === 404) { st.historyId = (await gmail(box, 'profile')).historyId; await ref.set(clean(st)); return 0; } throw e; }
    for (const id of ids) { try { const x = await importOne(box, id); if (x) found.push(x); } catch (e) { if (e.status !== 404) throw e; } }
    st.historyId = last;
  }
  await ref.set(clean(st), { merge: true });
  try { await notify(found); } catch (e) { console.error('notify', e); }
  return found.length;
}
async function watchRenew(cfg) {
  const box = mailboxOf(cfg); const ref = db.doc('srv/watch'); const st = (await ref.get()).data() || {};
  if (st.box === box && st.exp && st.exp > Date.now() + 864e5) return true;
  const r = await gmail(box, 'watch', { method: 'POST', json: { topicName: `projects/${PROJECT}/topics/${TOPIC}` } });
  await ref.set({ box, exp: +r.expiration || 0, at: Date.now() }); return true;
}

exports.mailIn = onMessagePublished({ topic: TOPIC, memory: '512MiB', timeoutSeconds: 300 }, async () => {
  const cfg = await setting('sending');
  await withLock(() => mailCheck(cfg).then(() => status({ mailOk: true, mailErr: '' })).catch(e => status({ mailOk: false, mailErr: e.message })));
});

exports.tick = onSchedule({ schedule: 'every 1 minutes', memory: '512MiB', timeoutSeconds: 240 }, async () => {
  const cfg = await setting('sending'); const box = mailboxOf(cfg); const p = { box, sa: SA, scopes: SCOPES.join(',') };
  try { const info = await (await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + await saToken())).json(); p.clientId = info.azp || info.aud || ''; } catch (e) {}
  try { await mailToken(box); p.ok = true; p.sendOk = true; p.err = ''; } catch (e) { p.ok = false; p.sendOk = false; p.err = e.message; await status(p); return; }
  try { await sendDue(cfg); p.outErr = ''; } catch (e) { p.outErr = e.message; }
  try { await sdDaily(cfg); p.sdErr = ''; } catch (e) { p.sdErr = e.message; }
  try { await watchRenew(cfg); p.watchOk = true; p.watchErr = ''; } catch (e) { p.watchOk = false; p.watchErr = e.message; }
  try { await withLock(() => mailCheck(cfg)); p.mailOk = true; p.mailErr = ''; } catch (e) { p.mailOk = false; p.mailErr = e.message; }
  await status(p);
});


/* ---------- Sent docs: weekday 8 AM reminders to the other side, until every document is signed ----------
   The app keeps sdq/<deal> ready to send (recipients, message, file list). "Send reminder now" sets force. */
function ptParts(d = new Date()) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(d);
  const g = k => (s.find(x => x.type === k) || {}).value; return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: +g('hour') % 24, wd: g('weekday') };
}
async function sdDaily(cfg) {
  const now = ptParts(); const wdN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(now.wd);
  const dayDiff = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5);
  const snap = await db.collection('sdq').where('pending', '>', 0).get();
  const due = x => {
    const days = Array.isArray(x.days) && x.days.length ? x.days : [1, 2, 3, 4, 5]; const hour = +x.hour || 8;
    if (!x.auto || !days.includes(wdN) || now.hour < hour || now.hour >= hour + 3 || x.last === now.day) return false;
    if (x.last && dayDiff(now.day, x.last) < (+x.every || 1)) return false; return true;
  };
  const ready = x => (x.items || []).filter(it => x.force || !it.sent || dayDiff(now.day, it.sent) >= (+x.delay || 0));
  for (const d of snap.docs) {
    const q0 = dec(d.data()); if (!q0.items) continue; // old single-list records
    if (!q0.force && !(due(q0) && ready(q0).length)) continue;
    const q = await db.runTransaction(async tr => {
      const s = await tr.get(d.ref); if (!s.exists) return null; const x = dec(s.data());
      if (!(x.pending > 0) || !(x.force || (due(x) && ready(x).length))) return null;
      tr.update(d.ref, { last: now.day, lastAt: Date.now(), force: false, err: '' }); return x;
    });
    if (!q) continue;
    try {
      const its = ready(q); if (!its.length) continue;
      const files = []; let total = 0;
      for (const it of its) for (const f of (it.files || [])) {
        let data = ''; for (let c = 0; c < (f.n || 0); c++) { const x = await db.doc(`sdatt/${f.key}_${c}`).get(); if (x.exists) data += dec(x.data()).d || ''; }
        if (!data) continue; total += data.length * 0.75; if (total > 20 * 1024 * 1024) break; files.push({ name: f.name, type: f.type, data });
      }
      const esc2 = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const html = (q.head || '') + '<ul style="margin-top:4px">' + its.map(it => `<li style="margin:4px 0"><b>${esc2(it.name)}</b> <span style="color:#667085">(${esc2(q.word || 'sent')} ${esc2(it.sentS || it.sent || '')})</span></li>`).join('') + '</ul>' + (q.tail || '');
      const text = `${q.hi || 'Hello,'}\n\n${q.msg || ''}\n\n${q.addr || ''}:\n${its.map(it => '- ' + it.name).join('\n')}\n\nThank you`;
      if (!splitList(q.to).length) throw new Error('No one to send it to');
      await sendOne({ to: q.to, cc: q.cc || '', subject: q.subject, html, text, files }, '', cfg);
    } catch (e) { console.error('sent docs', d.id, e.message); await d.ref.update({ err: e.message, last: q.last || '' }).catch(() => {}); }
  }
}

/* ---------- @mentions in a file email's team chat ---------- */
exports.fmMention = onDocumentWritten({ document: 'fmail/{id}', memory: '256MiB' }, async ev => {
  const before = ev.data.before && ev.data.before.exists ? dec(ev.data.before.data()) : {};
  const after = ev.data.after && ev.data.after.exists ? dec(ev.data.after.data()) : null;
  if (!after || after.del) return;
  const had = new Set((before.notes || []).map(n => n.id));
  const fresh = (after.notes || []).filter(n => !had.has(n.id) && (n.men || []).length && Date.now() - (n.at || 0) < 10 * 60e3);
  if (!fresh.length) return;
  const snap = await db.collection('push').get(); const docs = snap.docs.map(d => ({ ref: d.ref, ...dec(d.data()) })).filter(x => x.token && x.on !== false);
  if (!docs.length) return;
  let addr = '';
  for (const col of ['transactions', 'archive']) { const t = await db.doc(col + '/' + after.tx).get(); if (t.exists) { addr = ((dec(t.data()).f) || {}).address || ''; break; } }
  for (const n of fresh) {
    const want = new Set(n.men.map(x => String(x).toLowerCase())); const by = String(n.by || '').toLowerCase();
    const to = docs.filter(x => x.name && want.has(String(x.name).toLowerCase()) && String(x.name).toLowerCase() !== by);
    if (!to.length) continue;
    const res = await admin.messaging().sendEachForMulticast({
      tokens: to.map(x => x.token), data: { tx: after.tx, fm: after.id },
      webpush: { notification: { title: (n.by || 'Someone') + ' mentioned you' + (addr ? ' · ' + addr : ''), body: String(n.text || '').slice(0, 180), icon: '/icon-192.png', tag: 'men-' + n.id },
        fcmOptions: { link: `${APP_URL}/#v=detail&tx=${encodeURIComponent(after.tx)}&tab=fmail` } }
    });
    res.responses.forEach((r, i) => { const c = r.error && r.error.code; if (c && /registration-token-not-registered|invalid-registration-token/.test(c)) to[i].ref.delete().catch(() => {}); });
  }
});

/* ---------- portal chat: tell the team when a client writes ---------- */
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
exports.pchatIn = onDocumentCreated({ document: 'pchat/{id}', memory: '256MiB' }, async ev => {
  const m = ev.data && dec(ev.data.data()); if (!m) return;
  if (m.from === 'team') { if (m.mail && !m.mailed) { try { await chatMail(m, ev.data.ref); } catch (e) { console.error('chatMail', e.message); await ev.data.ref.set({ mailErr: e.message }, { merge: true }); } } return; }
  if (m.from !== 'client') return;
  const snap = await db.collection('push').get(); const docs = snap.docs.map(d => ({ ref: d.ref, ...dec(d.data()) })).filter(x => x.token && x.on !== false);
  if (!docs.length) return;
  let addr = ''; const t = await db.doc('transactions/' + m.txId).get(); if (t.exists) addr = ((dec(t.data()).f) || {}).address || '';
  const res = await admin.messaging().sendEachForMulticast({
    tokens: docs.map(x => x.token), data: { tx: m.txId },
    webpush: { notification: { title: '💬 ' + (m.by || m.email) + (addr ? ' · ' + addr : ''), body: String(m.text || '').slice(0, 180), icon: '/icon-192.png', tag: 'pc-' + m.id },
      fcmOptions: { link: `${APP_URL}/#v=detail&tx=${encodeURIComponent(m.txId)}&tab=pchat` } }
  });
  res.responses.forEach((r, i) => { const c = r.error && r.error.code; if (c && /registration-token-not-registered|invalid-registration-token/.test(c)) docs[i].ref.delete().catch(() => {}); });
});

/* ---------- sign-in links sent from the team address ---------- */
const LINK_ORIGINS = ['https://app.derrick.club', 'https://tc-desk.web.app', 'https://tc-desk.firebaseapp.com'];
exports.linkSend = onDocumentCreated({ document: 'linkreq/{id}', memory: '256MiB' }, async ev => {
  const r = ev.data && ev.data.data(); if (!r) return;
  try {
    const email = String(r.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
    let ok = ADMINS.includes(email) || (await db.doc('logins/' + email).get()).exists;
    if (!ok) ok = !(await db.collection('portal').where('email', '==', email).limit(1).get()).empty;
    if (!ok) {
      // New person signing up: allow, but cap how many links go to unknown addresses each hour.
      const g = db.doc('srv/linkglobal'); const hr = Math.floor(Date.now() / 3600e3);
      const cur = (await g.get()).data() || {}; const n = cur.hr === hr ? (cur.n || 0) : 0;
      if (n >= 40) return;
      await g.set({ hr, n: n + 1 });
    }
    const rl = db.doc('srv/lr_' + Buffer.from(email).toString('base64url').slice(0, 120));
    const last = ((await rl.get()).data() || {}).at || 0; if (Date.now() - last < 15e3) return;
    await rl.set({ at: Date.now() });
    const origin = LINK_ORIGINS.find(o => String(r.url || '').startsWith(o)) || LINK_ORIGINS[0];
    const link = await admin.auth().generateSignInWithEmailLink(email, { url: origin + '/', handleCodeInApp: true });
    const cfg = await setting('sending');
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#101828;max-width:520px"><p>Hello,</p><p>Here's your link to sign in to TC Desk as <b>${email}</b>:</p><p><a href="${link}" style="display:inline-block;background:#101828;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none">Sign in</a></p><p style="color:#475467;font-size:13px">Open it on the same device where you asked for it. The link works once and expires soon. If you didn't ask to sign in, you can ignore this email.</p></div>`;
    const box = splitList(cfg.from)[0] || mailboxOf(cfg); const when = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
    await sendOne({ from: 'TC Desk <' + addrOf(box) + '>', to: email, subject: 'Your TC Desk sign-in link (' + when + ')', html, text: `Sign in to TC Desk as ${email}:\n${link}\n\nOpen it on the same device where you asked for it. If you didn't ask to sign in, ignore this email.`, noCc: true }, '', cfg);
  } catch (e) { console.error('linkSend', e.message); }
  finally {
    try { await ev.data.ref.delete(); } catch (e) {}
    try { if (r.uid) await admin.auth().deleteUser(r.uid); } catch (e) {}
  }
});


/* ---------- client chat by email ----------
   A team message with "email them" ticked goes out from the team address with:
   - a one-tap link that signs the client straight into their portal, and
   - Reply-To set to the file's own address plus a chat token (tc+<code>-chat-<token>@...),
     so a reply lands back in that client's chat on the file. */
const rnd = n => require('crypto').randomBytes(n).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, n);
async function txFor(id) { for (const col of ['transactions', 'archive']) { const s = await db.doc(col + '/' + id).get(); if (s.exists) return dec(s.data()); } return null; }
async function chatToken(pid, txId, email) {
  const ref = db.doc('pmail/' + pid); const cur = (await ref.get()).data();
  if (cur && cur.tok) return cur.tok;
  const tok = rnd(12); await db.doc('pmtok/' + tok).set({ pid, txId, email, at: Date.now() }); await ref.set({ tok, txId, email, at: Date.now() });
  return tok;
}
const escH = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
async function chatMail(m, ref) {
  const cfg = await setting('sending'); const box = mailboxOf(cfg); if (!box) throw new Error('No team mailbox is set');
  const p = await db.doc('portal/' + m.pid).get(); const pd = p.exists ? dec(p.data()) : null;
  const tx = await txFor(m.txId); const f = (tx && tx.f) || {};
  const addr = f.address || 'your file';
  const first = String((pd && pd.name) || '').split(/[\s&]+/)[0] || 'there';
  const chatOn = !!(pd && pd.data && pd.data.show && pd.data.show.chat);
  let replyTo = '';
  if (chatOn && f.file_code) { const tok = await chatToken(m.pid, m.txId, m.email); const i = box.indexOf('@'); replyTo = `TC Desk <${box.slice(0, i)}+${String(f.file_code).toLowerCase()}-chat-${tok}${box.slice(i)}>`; }
  let link = APP_URL + '/';
  try { link = await admin.auth().generateSignInWithEmailLink(m.email, { url: APP_URL + '/?le=' + encodeURIComponent(m.email) + '&chat=' + encodeURIComponent(m.txId), handleCodeInApp: true }); } catch (e) { console.warn('chat link', e.message); }
  const how = replyTo ? 'Just reply to this email to answer, or open the chat:' : 'Open the chat to reply:';
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#101828;max-width:560px"><p>Hi ${escH(first)},</p><p>You have a new message about <b>${escH(addr)}</b> from ${escH(m.by || 'your TC team')}:</p><blockquote style="border-left:3px solid #d0d5dd;margin:0 0 14px;padding:4px 12px;color:#344054">${escH(m.text).replace(/\n/g, '<br>')}</blockquote><p>${how}</p><p><a href="${link}" style="display:inline-block;background:#101828;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none">Open chat</a></p><p style="color:#667085;font-size:12.5px">The button signs you in as ${escH(m.email)}. After the first time, this device stays signed in at app.derrick.club.</p></div>`;
  const text = `Hi ${first},\n\nYou have a new message about ${addr} from ${m.by || 'your TC team'}:\n\n${m.text}\n\n${replyTo ? 'Just reply to this email to answer, or open the chat:' : 'Open the chat to reply:'}\n${link}`;
  const from = 'TC Desk <' + addrOf(splitList(cfg.from)[0] || box) + '>';
  await sendOne({ from, to: m.email, subject: 'Message about ' + addr, html, text, replyTo, noCc: true }, '', cfg);
  await ref.set({ mailed: Date.now() }, { merge: true });
}
// Keep only what the client typed: drop quoted history, signatures and "Sent from my iPhone".
function replyText(text, html) {
  let s = String(text || '');
  if (!s.trim() && html) s = String(html).replace(/<div[^>]*class="?gmail_quote[\s\S]*$/i, '').replace(/<blockquote[\s\S]*$/i, '')
    .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  s = s.replace(/\r/g, '');
  const cuts = [/^On [^\n]*(\n[^\n]*)?wrote:\s*$/m, /^-{2,}\s*Original Message/mi, /^_{5,}/m, /^From: [^\n]+$/m, /^Sent from my /m, /^Get Outlook for/m, /^-- ?$/m, /^\S[^\n]{0,80}<[^>\s]+@[^>\s]+>\s*wrote:\s*$/m];
  let end = s.length; cuts.forEach(re => { const m = re.exec(s); if (m && m.index < end) end = m.index; });
  s = s.slice(0, end).split('\n').filter(l => !/^\s*>/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.slice(0, 3900);
}
async function chatReply(box, id, tok) {
  const t = await db.doc('pmtok/' + tok.replace(/[^a-z0-9]/g, '')).get(); if (!t.exists) return null;
  const k = t.data();
  if ((await db.doc('pchat/em_' + id).get()).exists) return 'dup';
  const m = await gmail(box, `messages/${id}?format=full`);
  const hd = {}; ((m.payload && m.payload.headers) || []).forEach(h => hd[h.name.toLowerCase()] = h.value);
  // Only the client the chat belongs to can post into it. Anyone else's mail goes to File email as usual.
  if (addrOf(hd.from) !== String(k.email).toLowerCase()) return null;
  const p = await db.doc('portal/' + k.pid).get(); const pd = p.exists ? dec(p.data()) : null;
  if (!pd || !(pd.data && pd.data.show && pd.data.show.chat)) return null;
  const o = walk(m.payload, { html: '', text: '', atts: [] });
  let body = replyText(o.text, o.html);
  const n = o.atts.length;
  if (!body && !n) return 'done';
  if (n) body = (body ? body + '\n\n' : '') + `📎 Sent ${n} attachment${n > 1 ? 's' : ''} (saved in File email)`;
  const name = (/^\s*"?([^"<]*?)"?\s*</.exec(hd.from || '') || [])[1] || pd.name || k.email;
  await db.doc('pchat/em_' + id).set({ id: 'em_' + id, txId: k.txId, email: k.email, pid: k.pid, from: 'client', by: name.trim(), text: body, at: +m.internalDate || Date.now(), viaEmail: true });
  return n ? { atts: n } : 'done';
}
