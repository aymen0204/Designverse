// Designverse render worker: picks up due reels, writes copy with Gemini, renders an MP4, uploads it.
const {spawn} = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
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

const LANG = {Arabic: 'Modern Standard Arabic, simple and friendly', Darija: 'Algerian Darija written in Arabic letters', French: 'French', English: 'English'};
const PRESET = {'Modern & clean': 0, 'Luxury': 1, 'Fun & colorful': 2, 'Minimal': 1, 'Bold & energetic': 0};
const FALLBACK = {
  ar: {headline: 'اكتشفوا جديدنا', benefits: ['جودة عالية', 'تصاميم عصرية', 'خدمة ممتازة'], cta: 'اطلب الآن'},
  fr: {headline: 'Découvrez notre nouveauté', benefits: ['Haute qualité', 'Designs modernes', 'Service soigné'], cta: 'Commander'},
  en: {headline: 'Discover what is new', benefits: ['High quality', 'Modern designs', 'Great service'], cta: 'Order now'}
};
async function copy(p, n) {
  const lang = p.lang || 'Arabic', key = lang === 'French' ? 'fr' : lang === 'English' ? 'en' : 'ar';
  const prompt = `You write short on-screen copy for a 14-second vertical promo reel.
Brand: ${p.brand}. Niche: ${p.niche}. Language: ${LANG[lang] || LANG.Arabic}.
Goal: ${p.goal}. Reel type: ${p.type}. Style: ${p.style}. Wanted call to action: ${p.cta}.
This is reel ${n} of 3 for the same brand, so use a different angle from a generic one.
Return JSON only: {"headline":"max 6 words","benefits":["max 4 words","max 4 words","max 4 words"],"cta":"max 3 words"}.
Never invent prices, discounts, numbers or specific facts about the brand.`;
  try {
    if (!G) throw new Error('no key');
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GM}:generateContent`, {
      method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': G},
      body: JSON.stringify({contents: [{parts: [{text: prompt}]}], generationConfig: {responseMimeType: 'application/json', temperature: 0.9}})
    });
    const j = await r.json();
    const o = JSON.parse(j.candidates[0].content.parts[0].text);
    if (typeof o.headline !== 'string' || !Array.isArray(o.benefits) || o.benefits.length < 3 || typeof o.cta !== 'string') throw new Error('bad shape');
    return {headline: o.headline.slice(0, 60), benefits: o.benefits.slice(0, 3).map(b => String(b).slice(0, 36)), cta: o.cta.slice(0, 24), ai: true};
  } catch (e) {
    console.log('Gemini failed, using fallback:', e.message);
    return {...FALLBACK[key], ai: false};
  }
}

async function render(props, out) {
  const {chromium} = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({viewport: {width: 720, height: 1280}});
    await page.goto('file://' + path.resolve(__dirname, 'template.html') + '#render');
    await page.evaluate(() => Promise.all([
      document.fonts.load('800 60px "Bricolage Grotesque"'), document.fonts.load('600 40px "Noto Kufi Arabic"'), document.fonts.load('700 40px "Noto Kufi Arabic"')
    ]).catch(() => {}));
    await page.evaluate(p => {
      const set = (id, v) => { document.getElementById(id).value = v };
      set('brand', p.brand); set('niche', p.niche); set('head', p.head); set('ben', p.ben.join('\n'));
      set('cta', p.cta); set('con', p.con); set('lang', p.lang); set('pre', String(p.pre));
    }, props);
    const total = await page.evaluate(() => window.TOTAL), frames = Math.round(total * 30);
    const ff = spawn('ffmpeg', ['-y', '-f', 'image2pipe', '-framerate', '30', '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'veryfast', '-movflags', '+faststart', out], {stdio: ['pipe', 'ignore', 'inherit']});
    const done = new Promise((res, rej) => { ff.on('close', c => c === 0 ? res() : rej(new Error('ffmpeg exit ' + c))); ff.on('error', rej) });
    for (let f = 0; f < frames; f++) {
      const b64 = await page.evaluate(t => { window.frame(t); return document.getElementById('cv').toDataURL('image/jpeg', 0.92).split(',')[1] }, f / 30);
      await new Promise(r => ff.stdin.write(Buffer.from(b64, 'base64'), r));
    }
    ff.stdin.end();
    await done;
  } finally { await browser.close() }
}

async function handle(reel) {
  // claim the reel: only succeeds if it is still queued
  const claimed = await api('/rest/v1/reels?id=eq.' + reel.id + '&status=eq.queued', {method: 'PATCH', headers: {...J, Prefer: 'return=representation'}, body: JSON.stringify({status: 'rendering'})});
  if (!claimed || !claimed.length) return;
  const [p] = await api('/rest/v1/profiles?id=eq.' + reel.user_id + '&select=*');
  if (!p) throw new Error('profile missing');
  const n = (reel.settings && reel.settings.n) || 1;
  const txt = await copy(p, n);
  const props = {brand: p.brand || 'Brand', niche: p.niche || '', head: txt.headline, ben: txt.benefits, cta: txt.cta, con: p.contact || '',
    lang: (p.lang === 'Arabic' || p.lang === 'Darija') ? 'ar' : 'en', pre: PRESET[p.style] ?? 0};
  const out = path.join(os.tmpdir(), reel.id + '.mp4');
  await render(props, out);
  const objPath = reel.user_id + '/' + reel.id + '.mp4';
  await api('/storage/v1/object/reels/' + objPath, {method: 'POST', headers: {'Content-Type': 'video/mp4', 'x-upsert': 'true'}, body: fs.readFileSync(out)});
  await patch(reel.id, {status: 'ready', video_path: objPath, delivered_at: new Date().toISOString(), script: {headline: txt.headline, benefits: txt.benefits, cta: txt.cta, ai: txt.ai}});
  console.log('ready', reel.id);
}

(async () => {
  if (!U || !K) throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  // put reels stuck in 'rendering' for over an hour back in the queue
  await api('/rest/v1/reels?status=eq.rendering&due_at=lte.' + encodeURIComponent(new Date(Date.now() - 36e5).toISOString()), {method: 'PATCH', headers: J, body: JSON.stringify({status: 'queued'})}).catch(() => {});
  const list = await due();
  if (process.argv.includes('--check')) {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'due=' + (list.length > 0) + '\n');
    console.log('due reels:', list.length); return;
  }
  for (const reel of list) {
    try { await handle(reel) }
    catch (e) { console.error('failed', reel.id, e.message); await patch(reel.id, {status: 'failed', script: {error: String(e.message).slice(0, 300)}}).catch(() => {}) }
  }
})().catch(e => { console.error(e); process.exit(1) });
