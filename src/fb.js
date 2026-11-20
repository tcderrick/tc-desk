// TC Desk hosted shell: Firebase login + a small adapter so the TC Desk app runs unchanged.
import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut, reauthenticateWithPopup, linkWithPopup,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  setPersistence, browserLocalPersistence
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, setDoc, deleteDoc, onSnapshot,
  getDocs, getDoc, query, limit, writeBatch
} from 'firebase/firestore';
import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';

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

const dbShim = {
  collection(path) {
    return {
      doc: id => ({
        set: data => setDoc(doc(fs, path, id), enc(JSON.parse(JSON.stringify(data)))),
        delete: () => deleteDoc(doc(fs, path, id))
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
    const a = document.createElement('a'); a.href = URL.createObjectURL(data); a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 2000);
  }
};

/* ---------- login screen ---------- */
const shell = html => { $('#app').innerHTML = `<div class="login"><div class="lbox"><div class="brand big"><img src="/favicon.svg" width="30" height="30" alt="">TC Desk</div>${html}</div></div>`; };
function loginScreen(msg) {
  shell(`<p class="mut">Sign in to continue.</p>
  ${msg ? `<div class="lmsg">${msg}</div>` : ''}
  <button class="btn pri lbtn" id="gBtn"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#fff" d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z"/></svg> Sign in with Google</button>
  <div class="lor"><span>or get a sign-in link by email</span></div>
  <form id="elForm" class="lrow"><input id="elEmail" type="email" placeholder="you@example.com" required autocomplete="email"><button class="btn" type="submit">Email me a link</button></form>`);
  $('#gBtn').onclick = async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { if (e.code !== 'auth/popup-closed-by-user') loginScreen('Google sign-in did not finish: ' + esc(e.code || e.message)); }
  };
  $('#elForm').onsubmit = async ev => {
    ev.preventDefault(); const email = $('#elEmail').value.trim().toLowerCase();
    try {
      await sendSignInLinkToEmail(auth, email, { url: location.origin + '/', handleCodeInApp: true });
      localStorage.setItem('tcdLinkEmail', email);
      shell(`<h3>Check your email</h3><p>We sent a sign-in link to <b>${esc(email)}</b>. Open it on this device to finish signing in.</p><button class="btn" id="back">Back</button>`);
      $('#back').onclick = () => loginScreen();
    } catch (e) { loginScreen('Could not send the link: ' + esc(e.code || e.message)); }
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
      jobs.slice(i, i + 200).forEach(([col, id, d]) => b.set(doc(fs, col, id), enc(d)));
      try { await b.commit() } catch (e) {
        console.error(e);
        for (const [col, id, d] of jobs.slice(i, i + 200)) { try { await setDoc(doc(fs, col, id), enc(d)) } catch (e2) { fail++; console.error(col, id, e2) } }
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
let gTok = null, gExp = 0;
try { const c = JSON.parse(sessionStorage.getItem('tcdG') || 'null'); if (c && c.exp > Date.now() + 60000) { gTok = c.t; gExp = c.exp } } catch (e) {}
async function gmailToken(force) {
  if (!force && gTok && Date.now() < gExp - 60000) return gTok;
  const u = auth.currentUser; const p = new GoogleAuthProvider(); GSCOPES.forEach(x => p.addScope(x));
  p.setCustomParameters({ login_hint: u.email || '' });
  const hasG = u.providerData.some(d => d.providerId === 'google.com');
  const res = hasG ? await reauthenticateWithPopup(u, p) : await linkWithPopup(u, p);
  const cred = GoogleAuthProvider.credentialFromResult(res);
  if (!cred || !cred.accessToken) throw new Error('Gmail did not give permission');
  gTok = cred.accessToken; gExp = Date.now() + 55 * 60 * 1000;
  try { sessionStorage.setItem('tcdG', JSON.stringify({ t: gTok, exp: gExp })) } catch (e) {}
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
window.tcdMail = {
  connected: () => !!(gTok && Date.now() < gExp - 60000),
  connect: () => gmailToken(true),
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
      shell(`<h3>No access yet</h3><p><b>${esc(email)}</b> isn't on the TC Desk team. Ask Derrick to add this email under Templates → Team.</p><button class="btn" id="so">Use a different account</button>`);
      $('#so').onclick = async () => { await signOut(auth); location.reload() };
      return;
    }
  } else syncLogins();
  window.TCD_HOSTED = { email, admin };
  window.claude = { use: async n => n === 'db' ? dbShim : n === 'downloads' ? downloadsShim : n === 'user' ? { id: async () => user.uid } : n === 'sample' ? sampleShim : null };
  window.TCD_AI = 'Gemini';
  userChip(email);
  // first run: offer to restore when the database is empty
  if (admin) {
    try {
      const s = await getDocs(query(collection(fs, 'transactions'), limit(1)));
      if (s.empty) setTimeout(() => { if (confirm('Your hosted TC Desk is empty. Restore from a TC Desk backup file now?')) window.tcdRestore() }, 1500);
    } catch (e) {}
  }
  const sc = document.createElement('script'); sc.src = '/app.js?v=' + (window.TCD_BUILD || ''); document.body.appendChild(sc);
}

finishEmailLink().finally(() => {
  onAuthStateChanged(auth, u => { if (u) start(u); else if (!started) loginScreen(); });
});
