// Designverse render worker: due reels -> AI story copy -> branded video render -> voice-over + music + sfx -> upload -> email.
const {spawn, spawnSync} = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const U = (process.env.SUPABASE_URL || '').replace(/\/$/, ''), K = process.env.SUPABASE_SECRET_KEY || '';
const G = process.env.GEMINI_API_KEY || '', GM = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const hdr = (x = {}) => ({apikey: K, ...(K.startsWith('eyJ') ? {Authorization: 'Bearer ' + K} : {}), ...x});
const J = {'Content-Type': 'application/json'};
async function api(p, o = {}) {
  const r = await fetch(U + p, {...o, headers: hdr(o.headers)});
  const t = await r.text();
  if (!r.ok) throw new Error(p.split('?')[0] + ' ' + r.status + ' ' + t.slice(0, 200));
  try { return t ? JSON.parse(t) : null } catch (e) { return t }
}
const due = () => api('/rest/v1/reels?status=eq.queued&due_at=lte.' + encodeURIComponent(new Date().toISOString()) + '&order=due_at.asc&limit=3&select=*');
const patch = (id, b, extra = {}) => api('/rest/v1/reels?id=eq.' + id, {method: 'PATCH', headers: {...J, ...extra}, body: JSON.stringify(b)});

const LANG = {Arabic: 'Modern Standard Arabic, simple, punchy, friendly (Algerian audience)', Darija: 'simple Arabic with Algerian flavor, written in Arabic letters', French: 'French', English: 'English'};
const PRESET = {'Modern & clean': 0, 'Luxury': 1, 'Fun & colorful': 2, 'Minimal': 1, 'Bold & energetic': 0};
const MEET = {ar: 'تعرّفوا على', fr: 'Découvrez', en: 'Meet'};
const langKey = l => (l === 'Arabic' || l === 'Darija') ? 'ar' : l === 'French' ? 'fr' : 'en';
const FALLBACK = {
  ar: {hook: 'ابحث عن شيء مميز.', pains: ['عادي', 'مكرر', 'ممل'], pain_end: 'لا بعد اليوم.', labels: ['جودة عالية', 'تصاميم عصرية', 'خدمة ممتازة'], tagline: 'اختيار يشبهك.', cta: 'اطلب الآن'},
  fr: {hook: 'Cherchez quelque chose d\'unique.', pains: ['Banal', 'Répétitif', 'Ennuyeux'], pain_end: 'Plus maintenant.', labels: ['Haute qualité', 'Designs modernes', 'Service soigné'], tagline: 'Un choix qui vous ressemble.', cta: 'Commander'},
  en: {hook: 'Looking for something unique?', pains: ['Plain', 'Repeated', 'Boring'], pain_end: 'Not anymore.', labels: ['High quality', 'Modern designs', 'Great service'], tagline: 'A choice that fits you.', cta: 'Order now'}
};
async function copy(p, n) {
  const lang = p.lang || 'Arabic', key = langKey(lang);
  const prompt = `You are a senior direct-response ad copywriter. Write the on-screen story for a 25-second vertical ad reel.
Language: ${LANG[lang] || LANG.Arabic}. Keep every line extremely short and punchy.
BUSINESS FACTS (use only these; never invent prices, discounts, numbers, guarantees or claims):
- Brand: ${p.brand}
- Niche: ${p.niche}
- What they sell: ${p.sells || 'not given'}
- Main offer or price: ${p.offer || 'not given'}
- Target customer: ${p.audience || 'not given'}
- What makes them different: ${p.diff || 'not given'}
Reel goal: ${p.goal}. Reel type: ${p.type}. Style: ${p.style}. Wanted call to action: ${p.cta}.
This is reel ${n} of 3 for the same brand: use a different customer pain and angle from a generic one.
STORY: 1) hook about the customer's problem or desire; 2) three one-or-two-word pains; 3) a short line that closes the pains; 4) the product revealed with three short benefit labels; 5) the offer; 6) a proof line; 7) tagline; 8) call to action.
Return JSON only:
{"hook":"max 6 words, ends with the key emotional word","pains":["1-2 words","1-2 words","1-2 words"],"pain_end":"max 4 words, relief, e.g. Not anymore.","labels":["max 3 words","max 3 words","max 3 words"],"offer_big":"the main offer as short as possible, e.g. 4500 DA or 2 for 1, or empty string if none given","offer_small":"max 4 words of context for the offer, or empty","proof":"max 6 words from what makes them different, or empty","tagline":"max 6 words","cta":"max 3 words"}`;
  const cut = (s, m) => String(s || '').slice(0, m);
  try {
    if (!G) throw new Error('no key');
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GM}:generateContent`, {
      method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': G},
      body: JSON.stringify({contents: [{parts: [{text: prompt}]}], generationConfig: {responseMimeType: 'application/json', temperature: 0.9}})
    });
    const j = await r.json();
    const o = JSON.parse(j.candidates[0].content.parts[0].text);
    if (typeof o.hook !== 'string' || !Array.isArray(o.pains) || o.pains.length < 3 || !Array.isArray(o.labels) || o.labels.length < 3) throw new Error('bad shape');
    return {hook: cut(o.hook, 60), pains: o.pains.slice(0, 3).map(x => cut(x, 18)), pain_end: cut(o.pain_end, 36), labels: o.labels.slice(0, 3).map(x => cut(x, 30)),
      offer_big: p.offer ? cut(o.offer_big || p.offer, 24) : '', offer_small: p.offer ? cut(o.offer_small, 30) : '', proof: p.diff ? cut(o.proof, 48) : '',
      tagline: cut(o.tagline, 48), cta: cut(o.cta || FALLBACK[key].cta, 24), ai: true};
  } catch (e) {
    console.log('Gemini failed, using fallback:', e.message);
    const f = FALLBACK[key];
    return {...f, offer_big: p.offer || '', offer_small: '', proof: p.diff || '', ai: false};
  }
}
async function photoUrls(p) {
  const out = [];
  for (const pa of (p.photos || []).slice(0, 5)) {
    try {
      const r = await fetch(U + '/storage/v1/object/brand-photos/' + pa, {headers: hdr()});
      if (!r.ok) { console.log('photo missing', pa, r.status); continue }
      out.push('data:image/jpeg;base64,' + Buffer.from(await r.arrayBuffer()).toString('base64'));
    } catch (e) { console.log('photo failed', pa) }
  }
  return out;
}

async function render(props, out, info = {}) {
  const {chromium} = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({viewport: {width: 720, height: 1280}});
    await page.goto('file://' + path.resolve(__dirname, 'template.html') + '#render');
    await page.evaluate(() => Promise.all([document.fonts.load('900 60px Inter'), document.fonts.load('800 40px Inter'), document.fonts.load('700 40px "Noto Kufi Arabic"'), document.fonts.load('900 60px "Noto Kufi Arabic"')]).catch(() => {}));
    await page.evaluate(p => {
      const set = (id, v) => { document.getElementById(id).value = v };
      set('brand', p.brand); set('niche', p.niche); set('hook', p.hook); set('pains', p.pains.join('\n')); set('painend', p.painEnd);
      set('labels', p.labels.join('\n')); set('offerbig', p.offerBig); set('offersmall', p.offerSmall); set('proof', p.proof);
      set('tagline', p.tagline); set('cta', p.cta); set('con', p.con); set('lang', p.lang); set('pre', String(p.pre));
    }, props);
    await page.evaluate(u => window.setPhotos(u), props.photos || []);
    info.cues = await page.evaluate(() => window.getCues()); info.voT = await page.evaluate(() => window.VO_T);
    const total = await page.evaluate(() => window.TOTAL), frames = Math.round(total * 30);
    const ff = spawn('ffmpeg', ['-y', '-f', 'image2pipe', '-framerate', '30', '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '19', '-preset', 'veryfast', '-movflags', '+faststart', out], {stdio: ['pipe', 'ignore', 'inherit']});
    const done = new Promise((res, rej) => { ff.on('close', c => c === 0 ? res() : rej(new Error('ffmpeg exit ' + c))); ff.on('error', rej) });
    for (let f = 0; f < frames; f++) {
      const b64 = await page.evaluate(t => { window.frame(t); return document.getElementById('cv').toDataURL('image/jpeg', 0.93).split(',')[1] }, f / 30);
      await new Promise(r => ff.stdin.write(Buffer.from(b64, 'base64'), r));
    }
    ff.stdin.end(); await done; info.total = total;
  } finally { await browser.close() }
}

// ---------- audio: male voice-over (Edge TTS), synthesized music and cue-synced sound effects ----------
const VOICE = {ar: process.env.VOICE_AR || 'ar-DZ-IsmaelNeural', fr: process.env.VOICE_FR || 'fr-FR-HenriNeural', en: process.env.VOICE_EN || 'en-US-GuyNeural'};
let edgeOk = null;
const lib = {
  ensureEdge() {
    if (process.env.NO_TTS) return false;
    if (edgeOk === null) edgeOk = spawnSync('python3', ['-m', 'pip', 'install', '--quiet', '--break-system-packages', 'edge-tts'], {stdio: 'inherit'}).status === 0;
    return edgeOk;
  },
  tts(text, voice, file) {
    const r = spawnSync('python3', ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', file], {encoding: 'utf8', timeout: 60000});
    if (r.status !== 0) console.log('edge-tts error:', (r.stderr || '').slice(-200));
    return r.status === 0 && fs.existsSync(file) && fs.statSync(file).size > 1000;
  }
};
const duration = file => parseFloat(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {encoding: 'utf8'}).stdout) || 0;
function writeWav(file, f, norm) {
  let peak = 0; for (let i = 0; i < f.length; i++) peak = Math.max(peak, Math.abs(f[i]));
  const g = norm && peak > 0 ? norm / peak : 1, buf = Buffer.alloc(44 + f.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + f.length * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(44100, 24); buf.writeUInt32LE(88200, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(f.length * 2, 40);
  for (let i = 0; i < f.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, f[i] * g)) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
}
const SR = 44100, PI2 = 2 * Math.PI;
function musicTrack(dur) {
  const N = Math.floor(dur * SR), a = new Float32Array(N), beat = 60 / 118;
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], hz = m => 440 * Math.pow(2, (m - 69) / 12);
  let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1 };
  for (let i = 0; i < N; i++) {
    const t = i / SR, bar = Math.floor(t / (beat * 4)), ch = chords[bar % 4], tb = t % beat, bt = Math.floor(t / beat), tbar = t - bar * beat * 4;
    const sec = t < 3.4 ? 1 : t < 8.4 ? 0 : 2;            // intro / dark pains / full beat after the reveal
    let s = 0;
    const env = Math.min(1, tbar / 0.6) * (1 - 0.25 * tbar / (beat * 4)), padAmp = sec === 0 ? 0.045 : 0.05;
    for (const n of ch) s += Math.sin(PI2 * hz(n) * t) * 0.5 + Math.sin(PI2 * hz(n) * 1.004 * t) * 0.5;
    s *= padAmp * env;
    if (sec !== 0) s += Math.sin(PI2 * hz(ch[0] - 24) * t) * 0.15 * Math.exp(-tb * 2.2);
    const kickOn = (sec === 2 || (sec === 1 && t > 1.2)) && !(t > 7.2 && t < 8.4);
    if (kickOn) s += Math.sin(PI2 * (45 * tb + 110 * (1 - Math.exp(-30 * tb)) / 30)) * (sec === 2 ? 0.5 : 0.32) * Math.exp(-tb * 9);
    const tq = t % (beat / 2); if (sec !== 0) s += rnd() * 0.05 * Math.exp(-tq * 70) * (Math.floor(t / (beat / 2)) % 2 ? 1 : 0.4);
    if (sec === 2 && bt % 2 === 1) s += rnd() * 0.1 * Math.exp(-tb * 18);
    a[i] = s;
  }
  return a;
}
function sfxTrack(dur, cues) {
  const N = Math.floor(dur * SR), a = new Float32Array(N);
  let seed = 3; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1 };
  const add = (t0, len, fn) => { for (let j = 0; j < len * SR; j++) { const i = Math.floor(t0 * SR) + j; if (i >= 0 && i < N) a[i] += fn(j / SR, j / (len * SR)) } };
  for (const c of cues) {
    const t0 = c.t;
    switch (c.k) {
      case 'pop': add(t0, 0.1, (j, x) => Math.sin(PI2 * (480 + 500 * x) * j) * 0.12 * Math.exp(-x * 5)); break;
      case 'tick': add(t0, 0.06, (j, x) => Math.sin(PI2 * (700 + (c.i || 0) * 70) * j) * 0.09 * Math.exp(-x * 6)); break;
      case 'whoosh': add(t0 - 0.25, 0.7, (j, x) => { const e = Math.pow(Math.sin(Math.PI * x), 2); return rnd() * 0.26 * e + Math.sin(PI2 * (180 + 1800 * x * x) * j) * 0.07 * e }); break;
      case 'hit': add(t0, 0.3, (j, x) => Math.sin(PI2 * (70 + 90 * Math.exp(-x * 14)) * j) * 0.4 * Math.exp(-x * 7) + rnd() * 0.12 * Math.exp(-x * 40)); break;
      case 'boom': add(t0, 0.9, (j, x) => Math.sin(PI2 * (40 + 70 * Math.exp(-x * 10)) * j) * 0.7 * Math.exp(-x * 4) + rnd() * 0.3 * Math.exp(-x * 25)); break;
      case 'swish': add(t0, 0.25, (j, x) => rnd() * 0.13 * Math.sin(Math.PI * x)); break;
      case 'riser': { const L = c.len || 1.4; add(t0, L, (j, x) => rnd() * 0.2 * x * x + Math.sin(PI2 * (300 + 1500 * x * x) * j) * 0.05 * x) } break;
      case 'shimmer': { const L = c.len || 1.2; for (let k = 0; k < 26; k++) add(t0 + k * L / 26, 0.12, (j, x) => Math.sin(PI2 * (1200 + 140 * k) * j) * 0.05 * Math.exp(-x * 5)) } break;
      case 'click': add(t0, 0.06, (j, x) => (rnd() * 0.3 + Math.sin(PI2 * 1400 * j) * 0.2) * Math.exp(-x * 8)); break;
      case 'chime': add(t0, 0.9, (j, x) => (Math.sin(PI2 * 1318 * j) + 0.6 * Math.sin(PI2 * 1760 * j)) * 0.1 * Math.exp(-x * 4)); break;
    }
  }
  return a;
}
const meetLine = (props) => (MEET[props.lang] || MEET.en) + ' ' + props.brand;
async function addAudio(video, props, id, lang, info) {
  const dir = os.tmpdir(), TOTAL = info.total, inputs = ['-i', video], filters = [], labels = ['[m]', '[s]'];
  const mus = path.join(dir, id + '-m.wav'), sfx = path.join(dir, id + '-s.wav');
  writeWav(mus, musicTrack(TOTAL), 0.6); writeWav(sfx, sfxTrack(TOTAL, info.cues), 0);
  inputs.push('-i', mus, '-i', sfx);
  filters.push(`[1:a]volume=0.4,afade=t=in:d=0.6,afade=t=out:st=${TOTAL - 1.6}:d=1.6[m]`, '[2:a]volume=0.85[s]');
  let k = 3;
  const key = langKey(lang), sep = key === 'ar' ? '، ' : ', ', pains = props.pains.join(key === 'ar' ? '، ' : '. ');
  const big = [props.offerBig, props.offerSmall].filter(Boolean).join(' '), v3 = [big, props.proof].filter(Boolean).join('. ') || props.tagline;
  const lines = [props.hook, pains + '. ' + props.painEnd, meetLine(props) + '. ' + props.labels.join(sep), v3, props.tagline + '. ' + props.cta];
  if (lib.ensureEdge()) {
    lines.forEach((tx, i) => {
      if (!tx || !tx.trim()) return;
      const f = path.join(dir, id + '-v' + i + '.mp3');
      if (!lib.tts(tx, VOICE[key], f)) { console.log('voice-over line failed:', i); return }
      const win = info.voT[i], factor = Math.min(1.5, Math.max(1, duration(f) / win.w)), ms = Math.round(win.t * 1000);
      inputs.push('-i', f); filters.push(`[${k}:a]atempo=${factor.toFixed(3)},adelay=${ms}|${ms},volume=1.7[v${i}]`); labels.push(`[v${i}]`); k++;
    });
  } else console.log('voice-over skipped (edge-tts unavailable)');
  filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,alimiter=limit=0.95[a]`);
  const outFile = video.replace(/\.mp4$/, '-a.mp4');
  const r = spawnSync('ffmpeg', ['-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', String(TOTAL), outFile], {stdio: ['ignore', 'ignore', 'inherit']});
  if (r.status !== 0) throw new Error('audio mix failed');
  return outFile;
}

async function mailUsers(map) {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) { console.log('email not configured, skipping'); return }
  const nodemailer = require('nodemailer');
  const tr = nodemailer.createTransport({service: 'gmail', auth: {user, pass}});
  const url = process.env.APP_URL || 'https://aymen0204.github.io/Designverse/';
  for (const d of map.values()) {
    const ar = d.lang === 'Arabic' || d.lang === 'Darija', fr = d.lang === 'French';
    const subject = ar ? 'ريلزك جاهزة!' : fr ? 'Vos reels sont prêts !' : 'Your reels are ready!';
    const body = ar ? `مرحبا ${d.brand || ''}،\nتم تجهيز ${d.n} ريلز جديدة. حمّلها من هنا:\n${url}`
      : fr ? `Bonjour ${d.brand || ''},\n${d.n} nouveau(x) reel(s) sont prêts. Téléchargez-les ici :\n${url}`
      : `Hi ${d.brand || ''},\n${d.n} new reel${d.n > 1 ? 's are' : ' is'} ready. Download ${d.n > 1 ? 'them' : 'it'} here:\n${url}`;
    try { await tr.sendMail({from: `Designverse <${user}>`, to: d.email, subject, text: body}); console.log('emailed', d.email) }
    catch (e) { console.log('email failed', e.message) }
  }
}

async function handle(reel) {
  const claimed = await api('/rest/v1/reels?id=eq.' + reel.id + '&status=eq.queued', {method: 'PATCH', headers: {...J, Prefer: 'return=representation'}, body: JSON.stringify({status: 'rendering'})});
  if (!claimed || !claimed.length) return;
  const [p] = await api('/rest/v1/profiles?id=eq.' + reel.user_id + '&select=*');
  if (!p) throw new Error('profile missing');
  const n = (reel.settings && reel.settings.n) || 1;
  const txt = await copy(p, n);
  const props = {brand: p.brand || 'Brand', niche: p.niche || '', hook: txt.hook, pains: txt.pains, painEnd: txt.pain_end, labels: txt.labels,
    offerBig: txt.offer_big, offerSmall: txt.offer_small, proof: txt.proof, tagline: txt.tagline, cta: txt.cta, con: p.contact || '',
    lang: langKey(p.lang), pre: PRESET[p.style] ?? 0, photos: await photoUrls(p)};
  const out = path.join(os.tmpdir(), reel.id + '.mp4'), info = {};
  await render(props, out, info);
  let fin = out;
  try { fin = await addAudio(out, props, reel.id, p.lang, info) } catch (e) { console.log('audio failed, uploading silent video:', e.message) }
  const objPath = reel.user_id + '/' + reel.id + '.mp4';
  await api('/storage/v1/object/reels/' + objPath, {method: 'POST', headers: {'Content-Type': 'video/mp4', 'x-upsert': 'true'}, body: fs.readFileSync(fin)});
  await patch(reel.id, {status: 'ready', video_path: objPath, delivered_at: new Date().toISOString(), script: {...txt, photos: props.photos.length}});
  console.log('ready', reel.id);
  return {uid: reel.user_id, email: p.email, lang: p.lang, brand: p.brand};
}

async function main() {
  if (!U || !K) throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  await api('/rest/v1/reels?status=eq.rendering&due_at=lte.' + encodeURIComponent(new Date(Date.now() - 36e5).toISOString()), {method: 'PATCH', headers: J, body: JSON.stringify({status: 'queued'})}).catch(() => {});
  const list = await due();
  if (process.argv.includes('--check')) {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'due=' + (list.length > 0) + '\n');
    console.log('due reels:', list.length); return;
  }
  const done = new Map();
  for (const reel of list) {
    try {
      const r = await handle(reel);
      if (r && r.email) { const d = done.get(r.uid) || {...r, n: 0}; d.n++; done.set(r.uid, d) }
    } catch (e) {
      console.error('failed', reel.id, e.message);
      const att = (reel.attempts || 0) + 1, err = {error: String(e.message).slice(0, 300)};
      // retry automatically up to 3 times, 20 minutes apart
      await patch(reel.id, att < 3 ? {status: 'queued', attempts: att, due_at: new Date(Date.now() + 20 * 60000).toISOString(), script: err} : {status: 'failed', attempts: att, script: err}).catch(() => {});
    }
  }
  await mailUsers(done);
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1) });
module.exports = {render, addAudio, lib, copy};
