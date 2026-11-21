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
function buildMime({ from, to, cc, bcc, subject, html, text, files }) {
  const imgs = []; let n = 0;
  html = String(html || '').replace(/src=(["'])data:(image\/[a-z+.-]+);base64,([^"']+)\1/gi, (all, q, type, data) => { const id = 'img' + (++n) + '.' + Date.now().toString(36) + '@tcdesk'; imgs.push({ id, type, data }); return `src=${q}cid:${id}${q}`; });
  const R = 'rel_' + Date.now().toString(36), A = 'alt_' + Math.random().toString(36).slice(2), M = 'mix_' + Math.random().toString(36).slice(2);
  const att = files || []; const L = [];
  if (from) L.push('From: ' + addrHdr(from));
  L.push('To: ' + addrHdr(to)); if (cc) L.push('Cc: ' + addrHdr(cc)); if (bcc) L.push('Bcc: ' + addrHdr(bcc));
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
  if (cfg.cc && ccTo && byEmail !== ccTo.toLowerCase() && !(String(m.to) + ',' + cc + ',' + String(m.bcc || '')).toLowerCase().includes(ccTo.toLowerCase())) cc = cc ? cc + ', ' + ccTo : ccTo;
  if (!splitList(m.to).length && !splitList(cc).length && !splitList(m.bcc).length) throw new Error('Add at least one recipient');
  const mime = buildMime({ from, to: m.to || '', cc, bcc: m.bcc || '', subject: m.subject || '', html: m.html || '', text: m.text || '', files: m.files || [] });
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
  try { await watchRenew(cfg); p.watchOk = true; p.watchErr = ''; } catch (e) { p.watchOk = false; p.watchErr = e.message; }
  try { await withLock(() => mailCheck(cfg)); p.mailOk = true; p.mailErr = ''; } catch (e) { p.mailOk = false; p.mailErr = e.message; }
  await status(p);
});


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
  const m = ev.data && dec(ev.data.data()); if (!m || m.from !== 'client') return;
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
