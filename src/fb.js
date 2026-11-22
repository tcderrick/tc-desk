// TC Desk hosted shell: Firebase login + a small adapter so the TC Desk app runs unchanged.
import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut, reauthenticateWithPopup, linkWithPopup,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signInAnonymously,
  setPersistence, browserLocalPersistence
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, setDoc, deleteDoc, onSnapshot,
  getDocs, getDoc, query, limit, writeBatch, where, collectionGroup
} from 'firebase/firestore';
import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';
import { getMessaging, getToken, deleteToken, onMessage, isSupported as msgSupported } from 'firebase/messaging';

const firebaseConfig = {
  apiKey: 'AIzaSyBj-SgpUHdzVjZQPDeTj-PxFdYgH6tvROo',
  authDomain: 'tc-desk.firebaseapp.com',
  projectId: 'tc-desk',
  storageBucket: 'tc-desk.firebasestorage.app',
  messagingSenderId: '836507322815',
  appId: '1:836507322815:web:8fd4240539c259ffe0390a'
};
const ADMINS = ['tc@derrick.club'];

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
let fs;
try { fs = initializeFirestore(fbApp, { ignoreUndefinedProperties: true, localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }) }
catch (e) { fs = initializeFirestore(fbApp, { ignoreUndefinedProperties: true }) }
setPersistence(auth, browserLocalPersistence).catch(() => {});

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Firestore can't store arrays inside arrays. Those docs are stored as JSON text instead. */
const hasNested = (v, inArr) => {
  if (Array.isArray(v)) { if (inArr) return true; return v.some(x => hasNested(x, true)); }
  if (v && typeof v === 'object') return Object.values(v).some(x => hasNested(x, false));
  return false;
};
const enc = d => hasNested(d, false) ? { __json: JSON.stringify(d) } : d;
const dec = d => (d && typeof d.__json === 'string') ? JSON.parse(d.__json) : d;

// Another TC's workspace keeps all its data under ws/{id}/. Derrick's own TC Desk stays at the top level.
let WSP = '';
const dbShim = {
  collection(path) {
    path = WSP + path;
    return {
      doc: id => ({
        set: data => setDoc(doc(fs, path, id), enc(JSON.parse(JSON.stringify(data)))),
        delete: () => deleteDoc(doc(fs, path, id)),
        get: async () => { const d = await getDoc(doc(fs, path, id)); return d.exists() ? dec(d.data()) : null }
      }),
      onSnapshot(next, err) {
        // Show what's saved on this device right away, then update when the server answers.
        let lastFC = null;
        return onSnapshot(collection(fs, path), { includeMetadataChanges: true },
          s => { const fc = s.metadata.fromCache; if (!s.docChanges().length && fc === lastFC) return; lastFC = fc;
            next({ docs: s.docs.map(d => ({ id: d.id, data: () => dec(d.data()) })), metadata: { fromCache: fc && s.empty } }) },
          e => { console.error(path, e); err && err(e); });
      }
    };
  }
};
const downloadsShim = {
  async save({ filename, data }) {
    if (!(data instanceof Blob)) data = new Blob([typeof data === 'string' ? data : JSON.stringify(data)], { type: 'application/octet-stream' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(data); a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 2000);
  }
};

/* ---------- login screen ---------- */
const shell = html => { $('#app').innerHTML = `<div class="login"><div class="lbox"><div class="brand big"><img src="/favicon.svg" width="30" height="30" alt="">TC Desk</div>${html}</div></div>`; };
let linkBusy = false;
const SU_ROLES = [['agent', "I'm an agent"], ['client', "I'm a buyer or seller"], ['lender', "I'm a lender"], ['escrow', "I'm with escrow or title"], ['other', 'Other']];
let suMode = /[?&](signup|start)\b/.test(location.search);
let suTC = /[?&]start\b/.test(location.search);
function suPending() { try { return JSON.parse(localStorage.getItem('tcdSignup') || 'null') } catch (e) { return null } }
function signupScreen(msg) {
  const p = suPending() || {};
  const tc = p.role ? p.role === 'tc' : suTC;
  shell(`<div class="ltabs"><button type="button" id="tIn">Sign in</button><button type="button" class="on">Create account</button></div>
  <div class="lkind"><button type="button" data-k="tc" class="${tc ? 'on' : ''}"><b>I'm a transaction coordinator</b><span>Get my own TC Desk for my deals and team</span></button><button type="button" data-k="other" class="${tc ? '' : 'on'}"><b>I'm an agent, client, lender or escrow</b><span>See the files my TC shares with me</span></button></div>
  <p class="mut">${tc ? 'Free while TC Desk is new. You start with an empty workspace that only you and the team you add can see.' : 'Once your transaction coordinator connects your files, they show up here.'}</p>
  ${msg ? `<div class="lmsg">${msg}</div>` : ''}
  <form id="suPre" class="lsu"><input id="sN" placeholder="Full name" required value="${esc(p.name || '')}" autocomplete="name">
  ${tc ? '<input type="hidden" id="sR" value="tc">' : `<select id="sR">${SU_ROLES.map(([v, l]) => `<option value="${v}" ${p.role === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`}
  <input id="sC" placeholder="${tc ? 'Business name (optional)' : 'Brokerage or company (optional)'}" value="${esc(p.company || '')}" autocomplete="organization">
  <input id="sP" placeholder="Phone (optional)" value="${esc(p.phone || '')}" autocomplete="tel" type="tel">
  ${tc ? '<input type="hidden" id="sA" value="">' : `<input id="sA" placeholder="Property address you're working on (optional)" value="${esc(p.note || '')}">`}
  <div class="lor"><span>then confirm your email</span></div>
  <button class="btn pri lbtn" type="button" id="sG">${tc ? 'Create my TC Desk with Google' : 'Create account with Google'}</button>
  <div class="lrow" style="margin-top:8px"><input id="sE" type="email" placeholder="you@example.com" autocomplete="email" value="${esc(p.email || '')}"><button class="btn" type="submit">Email me a link</button></div></form>`);
  const grab = () => { const name = $('#sN').value.trim(); if (!name) { $('#sN').focus(); $('#sN').reportValidity && $('#sN').reportValidity(); return null }
    const d = { name: name.slice(0, 120), role: $('#sR').value, company: $('#sC').value.trim().slice(0, 120), phone: $('#sP').value.trim().slice(0, 40), note: $('#sA').value.trim().slice(0, 200), email: $('#sE').value.trim().toLowerCase() };
    localStorage.setItem('tcdSignup', JSON.stringify(d)); return d };
  $('#tIn').onclick = () => { suMode = false; loginScreen() };
  document.querySelectorAll('.lkind button').forEach(b => b.onclick = () => {
    const keep = { name: $('#sN').value, company: $('#sC').value, phone: $('#sP').value, email: $('#sE').value, role: b.dataset.k === 'tc' ? 'tc' : '' };
    suTC = b.dataset.k === 'tc'; localStorage.setItem('tcdSignup', JSON.stringify(keep)); signupScreen(msg);
  });
  $('#sG').onclick = async () => { if (!grab()) return;
    try { await signInWithPopup(auth, new GoogleAuthProvider()) } catch (e) { if (e.code !== 'auth/popup-closed-by-user') signupScreen('Google sign-in did not finish: ' + esc(e.code || e.message)) } };
  $('#suPre').onsubmit = ev => { ev.preventDefault(); const d = grab(); if (!d) return; if (!d.email) { $('#sE').focus(); return } sendLink(d.email, true) };
}
async function sendLink(email, isNew) {
  try {
    linkBusy = true;
    try {
      const a = await signInAnonymously(auth);
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      await setDoc(doc(fs, 'linkreq', id), { uid: a.user.uid, email, url: location.origin + '/', at: Date.now() });
      await signOut(auth);
    } catch (e1) {
      console.warn('server link', e1); try { if (auth.currentUser && auth.currentUser.isAnonymous) await signOut(auth); } catch (e2) {}
      await sendSignInLinkToEmail(auth, email, { url: location.origin + '/', handleCodeInApp: true });
    }
    localStorage.setItem('tcdLinkEmail', email);
    shell(`<h3>Check your email</h3><p>${isNew ? `We sent a link to <b>${esc(email)}</b> to finish creating your account.` : `If <b>${esc(email)}</b> has access, a sign-in link is on its way from our team address.`} Open it on this device. It can take a minute, so check spam too.</p><button class="btn" id="back">Back</button>`);
    $('#back').onclick = () => { linkBusy = false; isNew ? signupScreen() : loginScreen(); };
  } catch (e) { linkBusy = false; (isNew ? signupScreen : loginScreen)('Could not send the link: ' + esc(e.code || e.message)); }
}
function loginScreen(msg) {
  if (suMode) return signupScreen(msg);
  shell(`<div class="ltabs"><button type="button" class="on">Sign in</button><button type="button" id="tUp">Create account</button></div>
  <p class="mut">Sign in to continue.</p>
  ${msg ? `<div class="lmsg">${msg}</div>` : ''}
  <button class="btn pri lbtn" id="gBtn"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#fff" d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z"/></svg> Sign in with Google</button>
  <div class="lor"><span>or get a sign-in link by email</span></div>
  <form id="elForm" class="lrow"><input id="elEmail" type="email" placeholder="you@example.com" required autocomplete="email"><button class="btn" type="submit">Email me a link</button></form>`);
  $('#gBtn').onclick = async () => {
    localStorage.removeItem('tcdSignup');
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { if (e.code !== 'auth/popup-closed-by-user') loginScreen('Google sign-in did not finish: ' + esc(e.code || e.message)); }
  };
  $('#tUp').onclick = () => { suMode = true; signupScreen() };
  $('#elForm').onsubmit = ev => {
    ev.preventDefault(); localStorage.removeItem('tcdSignup');
    // Ask TC Desk's server to email the link from the team address.
    sendLink($('#elEmail').value.trim().toLowerCase(), false);
  };
}
async function finishEmailLink() {
  if (!isSignInWithEmailLink(auth, location.href)) return;
  let email = localStorage.getItem('tcdLinkEmail');
  if (!email) email = (prompt('Confirm your email to finish signing in') || '').trim().toLowerCase();
  if (!email) return;
  try { await signInWithEmailLink(auth, email, location.href); localStorage.removeItem('tcdLinkEmail'); history.replaceState(null, '', '/'); }
  catch (e) { loginScreen('That sign-in link did not work. It may have expired. Send a new one.'); }
}

/* ---------- user chip (sign out) ---------- */
function userChip(email) {
  const d = document.createElement('div'); d.className = 'uchip';
  d.innerHTML = `<button id="ucBtn" title="${esc(email)}">${esc(email[0].toUpperCase())}</button><div class="ucm hidden" id="ucMenu"><div class="mut small">${esc(email)}</div><button id="ucOut">Sign out</button></div>`;
  document.body.appendChild(d);
  d.querySelector('#ucBtn').onclick = () => d.querySelector('#ucMenu').classList.toggle('hidden');
  d.querySelector('#ucOut').onclick = async () => { await signOut(auth); location.reload(); };
  document.addEventListener('click', e => { if (!d.contains(e.target)) d.querySelector('#ucMenu').classList.add('hidden'); });
}

/* ---------- admin: keep the login list in step with Team emails ---------- */
function syncLogins() {
  onSnapshot(collection(fs, 'members'), async s => {
    const want = new Map(); s.docs.forEach(d => { const m = dec(d.data()); const e = String(m.email || '').trim().toLowerCase(); if (e) want.set(e, m.name || '') });
    try {
      const have = await getDocs(collection(fs, 'logins'));
      const b = writeBatch(fs); let n = 0;
      have.docs.forEach(d => { if (!want.has(d.id)) { b.delete(d.ref); n++ } });
      want.forEach((name, e) => { const cur = have.docs.find(d => d.id === e); if (!cur || cur.data().name !== name) { b.set(doc(fs, 'logins', e), { name }); n++ } });
      if (n) await b.commit();
    } catch (e) { console.error('logins', e); }
  });
}

/* ---------- restore from a TC Desk backup file ---------- */
window.tcdRestore = () => {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    let data; try { data = JSON.parse(await f.text()) } catch (e) { alert("That file isn't a TC Desk backup."); return }
    if (!data || data.app !== 'TC Desk' || !data.cols) { alert("That file isn't a TC Desk backup."); return }
    const jobs = []; Object.entries(data.cols).forEach(([col, arr]) => (arr || []).forEach(o => jobs.push([col, o.id, o.data])));
    if (!confirm(`Restore ${jobs.length} records from this backup? Records with the same ID are replaced. Nothing else is deleted.`)) return;
    const ov = document.createElement('div'); ov.className = 'rover'; ov.innerHTML = '<div class="lbox"><h3>Restoring backup…</h3><div class="prog"><i id="rBar" style="width:0%"></i></div><p class="mut" id="rStat"></p><p class="hint">Keep this page open.</p></div>';
    document.body.appendChild(ov);
    let done = 0, fail = 0;
    for (let i = 0; i < jobs.length; i += 200) {
      const b = writeBatch(fs);
      jobs.slice(i, i + 200).forEach(([col, id, d]) => b.set(doc(fs, WSP + col, id), enc(d)));
      try { await b.commit() } catch (e) {
        console.error(e);
        for (const [col, id, d] of jobs.slice(i, i + 200)) { try { await setDoc(doc(fs, WSP + col, id), enc(d)) } catch (e2) { fail++; console.error(col, id, e2) } }
      }
      done = Math.min(jobs.length, i + 200);
      ov.querySelector('#rBar').style.width = (done / jobs.length * 100) + '%';
      ov.querySelector('#rStat').textContent = `${done} of ${jobs.length}`;
    }
    ov.querySelector('.lbox').innerHTML = `<h3>Backup restored</h3><p>${jobs.length - fail} records restored${fail ? `, ${fail} failed` : ''}.</p><button class="btn pri" id="rOk">Done</button>`;
    ov.querySelector('#rOk').onclick = () => location.reload();
  };
  inp.click();
};

/* ---------- Gmail: send from the signed-in person's own Gmail (or a Send-as alias) ---------- */
const GSCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.settings.basic'];
const GREAD = 'https://www.googleapis.com/auth/gmail.readonly';
let gTok = null, gExp = 0, gRead = false, wantRead = false;
try { const c = JSON.parse(sessionStorage.getItem('tcdG') || 'null'); if (c && c.exp > Date.now() + 60000) { gTok = c.t; gExp = c.exp; gRead = !!c.r } } catch (e) {}
async function gmailToken(force) {
  if (!force && gTok && Date.now() < gExp - 60000 && (!wantRead || gRead)) return gTok;
  const u = auth.currentUser; const p = new GoogleAuthProvider(); GSCOPES.forEach(x => p.addScope(x)); if (wantRead) p.addScope(GREAD);
  p.setCustomParameters({ login_hint: u.email || '' });
  const hasG = u.providerData.some(d => d.providerId === 'google.com');
  const res = hasG ? await reauthenticateWithPopup(u, p) : await linkWithPopup(u, p);
  const cred = GoogleAuthProvider.credentialFromResult(res);
  if (!cred || !cred.accessToken) throw new Error('Gmail did not give permission');
  gTok = cred.accessToken; gExp = Date.now() + 55 * 60 * 1000; gRead = wantRead;
  try { sessionStorage.setItem('tcdG', JSON.stringify({ t: gTok, exp: gExp, r: gRead })) } catch (e) {}
  return gTok;
}
const utf8b64 = str => { const b = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s) };
const wrap76 = s => s.replace(/.{1,76}/g, m => m + '\r\n');
const hdr = s => /[^\x20-\x7e]/.test(s) ? '=?UTF-8?B?' + utf8b64(s) + '?=' : s;
const addrHdr = list => String(list || '').split(/[,;]+/).map(x => x.trim()).filter(Boolean).map(a => {
  const m = /^(.*)<([^>]+)>$/.exec(a); return m && m[1].trim() ? hdr(m[1].trim().replace(/^"|"$/g, '')) + ' <' + m[2].trim() + '>' : a }).join(', ');
function buildMime({ from, to, cc, bcc, subject, html, text, files }) {
  const imgs = []; let n = 0;
  html = html.replace(/src=(["'])data:(image\/[a-z+.-]+);base64,([^"']+)\1/gi, (all, q, type, data) => { const id = 'img' + (++n) + '.' + Date.now().toString(36) + '@tcdesk'; imgs.push({ id, type, data }); return `src=${q}cid:${id}${q}` });
  const R = 'rel_' + Date.now().toString(36), A = 'alt_' + Math.random().toString(36).slice(2), M = 'mix_' + Math.random().toString(36).slice(2);
  const att = files || [];
  const L = [];
  if (from) L.push('From: ' + addrHdr(from));
  L.push('To: ' + addrHdr(to)); if (cc) L.push('Cc: ' + addrHdr(cc)); if (bcc) L.push('Bcc: ' + addrHdr(bcc));
  L.push('Subject: ' + hdr(subject || ''), 'MIME-Version: 1.0');
  if (att.length) L.push(`Content-Type: multipart/mixed; boundary="${M}"`, '', `--${M}`);
  L.push(`Content-Type: multipart/related; boundary="${R}"`, '', `--${R}`,
    `Content-Type: multipart/alternative; boundary="${A}"`, '', `--${A}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(utf8b64(text || '')),
    `--${A}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(utf8b64(html || '')), `--${A}--`);
  imgs.forEach(im => L.push(`--${R}`, `Content-Type: ${im.type}`, 'Content-Transfer-Encoding: base64', `Content-ID: <${im.id}>`, 'Content-Disposition: inline', '', wrap76(im.data.replace(/\s+/g, ''))));
  L.push(`--${R}--`);
  att.forEach(f => { const nm = String(f.name || 'file').replace(/["\r\n]/g, ''); const enc = /[^\x20-\x7e]/.test(nm) ? `filename*=UTF-8''${encodeURIComponent(nm)}` : `filename="${nm}"`;
    L.push(`--${M}`, `Content-Type: ${f.type || 'application/octet-stream'}; name="${hdr(nm)}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; ${enc}`, '', wrap76(f.data)) });
  if (att.length) L.push(`--${M}--`);
  L.push('');
  return L.join('\r\n');
}
const b64url = s => utf8b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function gfetch(url, opt = {}) {
  let tok = await gmailToken(false);
  let r = await fetch(url, Object.assign({}, opt, { headers: Object.assign({ Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, opt.headers || {}) }));
  if (r.status === 401) { gTok = null; sessionStorage.removeItem('tcdG'); const e = new Error('Gmail sign-in expired. Click Send again to reconnect.'); e.code = 'reauth'; throw e }
  if (!r.ok) { let m = ''; try { m = (await r.json()).error.message } catch (e) {} const e = new Error(m || ('Gmail error ' + r.status)); e.code = 'gmail'; e.status = r.status; throw e }
  return r.json();
}
let useSrv = false;
window.tcdMail = {
  useServer(v) { useSrv = !!v },
  get server() { return useSrv },
  connected: () => useSrv || !!(gTok && Date.now() < gExp - 60000),
  connect: () => useSrv ? Promise.resolve('') : gmailToken(true),
  // Reading mail (for each deal's file email). Only asked of the person whose mailbox receives it.
  wantRead() { wantRead = true },
  readReady: () => !!(gTok && gRead && Date.now() < gExp - 60000),
  connectRead() { wantRead = true; return gmailToken(true) },
  async gget(path) { if (!(gTok && gRead && Date.now() < gExp - 60000)) { const e = new Error('Mailbox not connected'); e.code = 'reauth'; throw e } return gfetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path) },
  async sendAs() { const d = await gfetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs'); return (d.sendAs || []).filter(x => x.verificationStatus !== 'pending').map(x => ({ email: x.sendAsEmail, name: x.displayName || '', primary: !!x.isPrimary, def: !!x.isDefault })) },
  async send(m) {
    await gmailToken(false); // ask for Gmail permission first, while the click still counts
    const files = [];
    for (const f of (m.files || [])) {
      const b = new Uint8Array(await f.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      files.push({ name: f.name, type: f.type, data: btoa(s) });
    }
    const mime = buildMime(Object.assign({}, m, { files }));
    return gfetch('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media', { method: 'POST', body: mime, headers: { 'Content-Type': 'message/rfc822' } });
  }
};

/* ---------- contract reading with Gemini (Firebase AI Logic) ---------- */
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash'];
let aiInst = null;
const blobB64 = b => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(b) });
const sampleShim = {
  limits: async () => ({ images: true }),
  async json(prompt, opts = {}) {
    if (!aiInst) aiInst = getAI(fbApp, { backend: new GoogleAIBackend() });
    const parts = [{ text: prompt }];
    for (const im of (opts.images || []).slice(0, 16)) {
      if (im instanceof Blob) parts.push({ inlineData: { mimeType: im.type || 'image/jpeg', data: await blobB64(im) } });
      else if (typeof im === 'string' && im.startsWith('data:')) { const m = /^data:([^;]+);base64,(.*)$/.exec(im); if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } }) }
    }
    let lastErr = null;
    for (const name of GEMINI_MODELS) {
      try {
        const model = getGenerativeModel(aiInst, { model: name, generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } });
        const r = await model.generateContent(parts);
        let t = r.response.text().trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
        return JSON.parse(t);
      } catch (e) {
        lastErr = e; const msg = String(e && (e.message || e));
        if (/App Check/i.test(msg)) { const er = new Error('Firebase is blocking Gemini because App Check is turned on for AI Logic. In Firebase, open Security, then App Check, then the APIs tab, click Firebase AI Logic and choose Unenforce. Then try again.'); er.code = 'setup'; throw er }
        const setup = /genai config not found|genai-config-not-found|API has not been used|disabled|PERMISSION_DENIED|403|api-not-enabled/i.test(msg);
        if (!setup && /not found|404|is not supported|unsupported model/i.test(msg)) continue;
        if (setup) { const er = new Error('Gemini isn\'t turned on for this project yet. In Firebase, open AI Logic and click Get started with the Gemini Developer API.'); er.code = 'setup'; throw er }
        if (/429|quota|RESOURCE_EXHAUSTED/i.test(msg)) { const er = new Error('Gemini\'s free limit is used up for now. Try again in a minute or two.'); er.code = 'rate_limited'; throw er }
        throw e;
      }
    }
    throw lastErr || new Error('No Gemini model was available');
  }
};

/* ---------- start ---------- */
let started = false;
async function start(user) {
  if (started) return; started = true;
  const email = String(user.email || '').toLowerCase();
  const admin = ADMINS.includes(email);
  shell('<p class="mut">Loading…</p>');
  if (!admin) {
    let ok = false;
    try { ok = (await getDoc(doc(fs, 'logins', email))).exists() } catch (e) { ok = false }
    if (!ok) {
      // Another TC's workspace? (their own, one they joined, or an invite to answer)
      let mem = null; try { const m0 = await getDoc(doc(fs, 'wsmem', email)); mem = m0.exists() ? m0.data() : null; } catch (e) { console.warn('wsmem', e); }
      if (mem && (mem.role === 'owner' || mem.role === 'member')) return enterWs(user, email, mem);
      const pre0 = suPending();
      if (!mem && pre0 && pre0.role === 'tc' && pre0.name) {
        localStorage.removeItem('tcdSignup');
        try { return enterWs(user, email, await createWs(email, pre0)); }
        catch (e) { console.error('create ws', e); shell(`<h3>Could not create your TC Desk</h3><p class="mut">${esc(e.code || e.message)}</p><button class="btn" id="so">Sign out</button>`); $('#so').onclick = async () => { await signOut(auth); location.reload() }; return; }
      }
      // Not on a team: show the client portal (only files shared with this email, from any TC's workspace).
      let docs = [];
      const pdocs = sn => sn.docs.map(d => Object.assign({ id: d.id, _base: d.ref.parent.parent ? d.ref.parent.parent.path + '/' : '' }, dec(d.data())));
      try { docs = pdocs(await getDocs(query(collectionGroup(fs, 'portal'), where('email', '==', email)))); }
      catch (e) { console.warn('portal group', e); try { docs = pdocs(await getDocs(query(collection(fs, 'portal'), where('email', '==', email)))); } catch (e2) { console.warn('portal', e2); } }
      if (mem && mem.role === 'invited') {
        const join = await new Promise(res => {
          shell(`<h3>You're invited</h3><p>You've been added to the team on <b>${esc(mem.name || 'a TC Desk workspace')}</b>. Join to work on their deals with them.</p><button class="btn pri lbtn" id="jY">Join the team</button>${docs.length ? '<button class="btn lbtn" id="jN">Not now, show my files</button>' : ''}<button class="btn" id="so" style="margin-top:10px">Sign out</button>`);
          $('#jY').onclick = () => res(true); const n = $('#jN'); if (n) n.onclick = () => res(false);
          $('#so').onclick = async () => { await signOut(auth); location.reload() };
        });
        if (join) { try { await setDoc(doc(fs, 'wsmem', email), Object.assign({}, mem, { role: 'member', at: Date.now() })); return enterWs(user, email, Object.assign({}, mem, { role: 'member' })); } catch (e) { alert('Could not join: ' + (e.code || e.message)); location.reload(); return; } }
      }
      if (!docs.length) {
        // Signed in, but nothing is shared yet: let them finish a short sign-up so the team knows who they are.
        let su = null; try { const d0 = await getDoc(doc(fs, 'signups', email)); su = d0.exists() ? d0.data() : null; } catch (e) {}
        // Filled in on the Create account screen before confirming the email: save it now.
        const pre = suPending();
        if (!su && pre && pre.name) { const d1 = { email, name: pre.name, role: pre.role || 'other', company: pre.company || '', phone: pre.phone || '', note: pre.note || '', at: Date.now() }; try { await setDoc(doc(fs, 'signups', email), d1); su = d1; } catch (e) { console.warn('signup', e) } }
        localStorage.removeItem('tcdSignup');
        const form = () => shell(`<h3>Welcome to TC Desk</h3>${su ? `<p>Thanks, <b>${esc(su.name || email)}</b>. Your account is set up. Your files will show here as soon as your transaction coordinator shares them with <b>${esc(email)}</b>. This page updates by itself.</p>` : `<p class="mut">You're signed in as <b>${esc(email)}</b>. Nothing is shared with this email yet. Tell us who you are and your transaction coordinator will connect your files.</p>
          <form id="suF" class="psu" style="display:flex;flex-direction:column;gap:8px;margin-top:10px"><input id="suN" placeholder="Full name" required><select id="suR"><option value="agent">I'm an agent</option><option value="client">I'm a buyer or seller</option><option value="lender">I'm a lender</option><option value="escrow">I'm with escrow or title</option><option value="other">Other</option></select><input id="suC" placeholder="Brokerage or company (optional)"><input id="suP" placeholder="Phone (optional)"><input id="suA" placeholder="Property address you're working on (optional)"><button class="btn pri" type="submit">Create my account</button></form>`}<div class="lor"><span>transaction coordinator?</span></div><button class="btn lbtn" id="mkWs">Start my own TC Desk</button><button class="btn" id="so" style="margin-top:10px">Sign out</button>`);
        const wire = () => { $('#so').onclick = async () => { await signOut(auth); location.reload() };
          $('#mkWs').onclick = async () => {
            const nm = (su && su.name) || ($('#suN') && $('#suN').value.trim()) || prompt('Your full name');
            if (!nm) return;
            $('#mkWs').disabled = true; $('#mkWs').textContent = 'Setting up…';
            try { enterWs(user, email, await createWs(email, { name: nm, company: (su && su.company) || '', phone: (su && su.phone) || '' })); }
            catch (e) { alert('Could not create your TC Desk: ' + (e.code || e.message)); $('#mkWs').disabled = false; $('#mkWs').textContent = 'Start my own TC Desk'; }
          }; const f = $('#suF'); if (f) f.onsubmit = async ev => { ev.preventDefault(); su = { email, name: $('#suN').value.trim().slice(0, 120), role: $('#suR').value, company: $('#suC').value.trim().slice(0, 120), phone: $('#suP').value.trim().slice(0, 40), note: $('#suA').value.trim().slice(0, 200), at: Date.now() }; try { await setDoc(doc(fs, 'signups', email), su) } catch (e) { alert('Could not save. Please try again.'); su = null; return } form(); wire(); }; };
        form(); wire();
        onSnapshot(query(collectionGroup(fs, 'portal'), where('email', '==', email)), sn => { if (!sn.empty) location.reload(); }, () => {});
        return;
      }
      document.title = 'Your transaction';
      $('#app').innerHTML = ''; userChip(email);
      let msgs = [];
      const send = async (d, text) => { const id = Math.random().toString(36).slice(2) + Date.now().toString(36); const m = { id, txId: d.txId, email, pid: d.id, from: 'client', by: d.name || email, text: String(text).slice(0, 3900), at: Date.now() }; msgs = msgs.concat([m]); view && view.update(null, { msgs }); await setDoc(doc(fs, (d._base || '') + 'pchat', id), m); };
      if (!window.tcdPortal) await new Promise(res => { const sc = document.createElement('script'); sc.src = '/portalview.js?v=' + (window.TCD_BUILD || ''); sc.onload = res; sc.onerror = res; document.body.appendChild(sc); });
      const view = window.tcdPortal ? window.tcdPortal($('#app'), docs, email, { msgs, send }) : null;
      if (!view) $('#app').textContent = 'Please reload the page.';
      onSnapshot(query(collectionGroup(fs, 'portal'), where('email', '==', email)), sn => { docs = pdocs(sn); view && view.update(docs); }, e => console.warn('portal live', e));
      onSnapshot(query(collectionGroup(fs, 'pchat'), where('email', '==', email)), sn => { msgs = sn.docs.map(d => dec(d.data())); view && view.update(null, { msgs }); }, e => console.warn('pchat live', e));
      try { await setDoc(doc(fs, 'portalseen', email), { email, at: Date.now() }); } catch (e) {}
      return;
    }
  } else syncLogins();
  boot(user, email, admin);
}

/* ---------- other TCs' workspaces ---------- */
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
async function createWs(email, pre) {
  const id = 'w' + rid();
  const nm = String(pre.name || '').trim().slice(0, 120);
  const name = (String(pre.company || '').trim() || (nm + "'s TC Desk")).slice(0, 120);
  const b = writeBatch(fs);
  b.set(doc(fs, 'ws', id), { owner: email, name, at: Date.now() });
  b.set(doc(fs, 'wsmem', email), { ws: id, role: 'owner', name, at: Date.now() });
  await b.commit();
  const mid = rid();
  const b2 = writeBatch(fs);
  b2.set(doc(fs, `ws/${id}/members`, mid), { id: mid, name: nm, email, createdAt: Date.now() });
  b2.set(doc(fs, `ws/${id}/settings`, 'mytc'), { id: 'mytc', name: nm, email, phone: String(pre.phone || '').slice(0, 40) });
  await b2.commit();
  return { ws: id, role: 'owner', name };
}
// The owner's Team list decides who may sign in to the workspace: new emails get an invite they accept.
function syncWsMembers(id, wsName, owner) {
  onSnapshot(collection(fs, `ws/${id}/members`), async s => {
    const want = new Set(); s.docs.forEach(d => { const m = dec(d.data()); const e = String(m.email || '').trim().toLowerCase(); if (e && e !== owner) want.add(e) });
    try {
      const have = await getDocs(query(collection(fs, 'wsmem'), where('ws', '==', id)));
      const had = new Set(have.docs.map(d => d.id));
      for (const d of have.docs) if (d.id !== owner && !want.has(d.id)) { try { await deleteDoc(d.ref) } catch (e) { console.warn('wsmem del', e) } }
      for (const e of want) if (!had.has(e)) { try { await setDoc(doc(fs, 'wsmem', e), { ws: id, role: 'invited', name: wsName, at: Date.now() }) } catch (er) { console.warn('wsmem add (already on another team?)', e, er) } }
    } catch (e) { console.error('ws members', e); }
  });
}
async function enterWs(user, email, mem) {
  WSP = `ws/${mem.ws}/`;
  let w = {}; try { const d = await getDoc(doc(fs, 'ws', mem.ws)); w = d.exists() ? d.data() : {}; } catch (e) {}
  const isOwner = mem.role === 'owner';
  window.TCD_WS = { id: mem.ws, name: w.name || mem.name || 'TC Desk', owner: w.owner || '', isOwner };
  if (isOwner) syncWsMembers(mem.ws, window.TCD_WS.name, email);
  boot(user, email, false);
}

function boot(user, email, admin) {
  window.TCD_HOSTED = { email, admin, ws: !!window.TCD_WS };
  window.claude = { use: async n => n === 'db' ? dbShim : n === 'downloads' ? downloadsShim : n === 'user' ? { id: async () => user.uid } : n === 'sample' ? sampleShim : null };
  window.TCD_AI = 'Gemini';
  userChip(email);
  // first run: offer to restore when the database is empty
  if (admin) getDocs(query(collection(fs, 'transactions'), limit(1))).then(s => {
    if (s.empty) setTimeout(() => { if (confirm('Your hosted TC Desk is empty. Restore from a TC Desk backup file now?')) window.tcdRestore() }, 1500);
  }).catch(() => {});
  const sc = document.createElement('script'); sc.src = '/app.js?v=' + (window.TCD_BUILD || ''); document.body.appendChild(sc);
}

finishEmailLink().finally(() => {
  onAuthStateChanged(auth, u => { if (u && u.isAnonymous) return; if (u) start(u); else if (!started && !linkBusy) loginScreen(); });
});


/* ---------- push notifications (Firebase Cloud Messaging) ---------- */
let msgInst = null, pushOK = false;
msgSupported().then(ok => { pushOK = ok && 'Notification' in window && 'serviceWorker' in navigator; if (pushOK) { try { msgInst = getMessaging(fbApp); onMessage(msgInst, p => { const n = (p && p.notification) || {}; const t = window.toast || (x => console.log(x)); try { t((n.title ? n.title + ': ' : '') + (n.body || 'New email')) } catch (e) {} }) } catch (e) { pushOK = false } } }).catch(() => {});
const tokHash = t => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return 'p' + (h >>> 0).toString(36) + t.length.toString(36) };
window.tcdPush = {
  get supported() { return pushOK },
  status() { if (!pushOK) return 'off'; if (Notification.permission === 'denied') return 'blocked'; return (Notification.permission === 'granted' && localStorage.getItem('tcdPushTok')) ? 'on' : 'off' },
  async enable(name) {
    if (!pushOK) throw new Error("This browser can't show notifications");
    const perm = await Notification.requestPermission(); if (perm !== 'granted') throw new Error('Notifications were not allowed');
    const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    const token = await getToken(msgInst, { serviceWorkerRegistration: reg }); if (!token) throw new Error('Could not get a notification token');
    const u = auth.currentUser;
    await setDoc(doc(fs, 'push', tokHash(token)), { token, email: (u && u.email || '').toLowerCase(), name: name || '', on: true, at: Date.now(), ua: navigator.userAgent.slice(0, 160) });
    localStorage.setItem('tcdPushTok', token); return true;
  },
  async disable() { const t = localStorage.getItem('tcdPushTok'); localStorage.removeItem('tcdPushTok'); if (t) { try { await deleteDoc(doc(fs, 'push', tokHash(t))) } catch (e) {} try { await deleteToken(msgInst) } catch (e) {} } },
  async test() { const reg = await navigator.serviceWorker.getRegistration('/firebase-messaging-sw.js') || await navigator.serviceWorker.register('/firebase-messaging-sw.js'); await reg.showNotification('TC Desk', { body: 'Notifications are working on this computer.', icon: '/icon-192.png' }) }
};
