// TC Desk hosted shell: Firebase login + a small adapter so the TC Desk app runs unchanged.
import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  setPersistence, browserLocalPersistence
} from 'firebase/auth';
import {
  initializeFirestore, collection, doc, setDoc, deleteDoc, onSnapshot,
  getDocs, getDoc, query, limit, writeBatch
} from 'firebase/firestore';

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
const fs = initializeFirestore(fbApp, { ignoreUndefinedProperties: true });
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
        return onSnapshot(collection(fs, path),
          s => next({ docs: s.docs.map(d => ({ id: d.id, data: () => dec(d.data()) })), metadata: { fromCache: s.metadata.fromCache } }),
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
const shell = html => { $('#app').innerHTML = `<div class="login"><div class="lbox"><div class="brand big"><i></i>TC Desk</div>${html}</div></div>`; };
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
  window.claude = { use: async n => n === 'db' ? dbShim : n === 'downloads' ? downloadsShim : n === 'user' ? { id: async () => user.uid } : null };
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
