import { Api, ApiError, FALLBACK_LANGUAGES, FALLBACK_MODES } from './api.js';
import { Speaker, listen, playChime, requestMicrophonePermission, recognitionSupported } from './speech.js';

const $ = (id) => document.getElementById(id);
function resolveApiBase() {
  const host = (location.hostname || '').toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '';
  // When deployed to Vercel or any remote domain, ALWAYS use same-origin relative URLs
  if (!isLocal) return '';
  // When running locally on port 5000 (FastAPI unified server), also use relative URLs
  if (location.port === '5000') return '';
  // Only if running standalone frontend on a separate dev port (e.g. 8080 or 3000)
  return 'http://localhost:5000';
}

const DEFAULTS = {
  apiBase: resolveApiBase(),
  language: 'kn', mode: 'safety', engine: 'server', voice: 'neutral', rate: 1.0,
  autoSpeak: true, interval: 5, vibrate: true, quietClear: false, contrast: false, fontSize: 100,
};
const store = {
  load() {
    try {
      const saved = JSON.parse(localStorage.getItem('drishti.prefs') || '{}');
      const prefs = { ...DEFAULTS, ...saved, engine: 'server' };
      const host = (location.hostname || '').toLowerCase();
      const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '';
      // Sanitize: If deployed on Vercel or running on port 5000, never allow a stale localhost URL
      if (!isLocal || (prefs.apiBase && prefs.apiBase.includes('localhost') && (location.port === '5000' || !location.port))) {
        prefs.apiBase = '';
      }
      return prefs;
    } catch {
      return { ...DEFAULTS };
    }
  },
  save(p) { try { localStorage.setItem('drishti.prefs', JSON.stringify(p)); } catch {} },
};

const state = {
  prefs: store.load(), languages: FALLBACK_LANGUAGES, modes: FALLBACK_MODES,
  stream: null, source: null /* 'camera' | 'photo' */, photoData: null,
  busy: false, auto: false, autoTimer: null, ctl: null,
  lastResult: null, lastSpoken: { text: '', at: 0 }, history: [], chatBusy: false, walkActive: false, walkPaused: false,
};

const api = new Api(() => state.prefs.apiBase);
const lang = () => state.languages.find(l => l.code === state.prefs.language) || state.languages[0];
const speaker = new Speaker(api, () => ({ ...state.prefs, bcp47: lang().bcp47 }));

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
}
let toastT;
function toast(msg, ms = 5000) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}
const errMsg = (e) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
async function say(text, opts) {
  if (!text) return;
  const hud = $('voiceHud'), status = $('voiceHudStatus');
  if (hud) hud.classList.add('speaking');
  if (status) status.textContent = '🔊 Drishti Speaking…';
  try {
    return await (state.prefs.autoSpeak || opts?.force ? speaker.speak(text, opts) : null);
  } finally {
    if (hud) hud.classList.remove('speaking');
    if (status) {
      status.textContent = voiceAssistantActive ? '🎙️ Voice Mode Active · Listening for commands' : '🎙️ Voice Standby';
    }
  }
}
const persist = () => store.save(state.prefs);

/* ---------------------------------------------------------- tabs */
const tabs = ['vision', 'chat', 'settings'];
function showTab(name) {
  for (const t of tabs) {
    const sel = t === name;
    $('tab-' + t).setAttribute('aria-selected', sel);
    $('tab-' + t).tabIndex = sel ? 0 : -1;
    $('panel-' + t).hidden = !sel;
  }
  if (name !== 'vision' && state.auto) setAuto(false);
}
tabs.forEach((t) => {
  $('tab-' + t).addEventListener('click', () => showTab(t));
  $('tab-' + t).addEventListener('keydown', (e) => {
    const i = tabs.indexOf(t);
    const j = e.key === 'ArrowRight' ? (i + 1) % 3 : e.key === 'ArrowLeft' ? (i + 2) % 3 : -1;
    if (j >= 0) { showTab(tabs[j]); $('tab-' + tabs[j]).focus(); }
  });
});

/* ---------------------------------------------------------- settings UI */
function applyDisplay() {
  document.documentElement.dataset.contrast = state.prefs.contrast ? 'high' : '';
  document.documentElement.style.fontSize = state.prefs.fontSize + '%';
  document.documentElement.lang = state.prefs.language;
}
function bindSettings() {
  const p = state.prefs;
  const bind = (id, key, { out, fmt = (v) => v, num = false } = {}) => {
    const n = $(id), isCheck = n.type === 'checkbox';
    isCheck ? (n.checked = p[key]) : (n.value = p[key]);
    if (out) $(out).textContent = fmt(p[key]);
    n.addEventListener('input', () => {
      p[key] = isCheck ? n.checked : num ? Number(n.value) : n.value;
      if (out) $(out).textContent = fmt(p[key]);
      persist(); applyDisplay();
      if (id === 'interval' && state.auto) setAuto(true);
    });
  };
  bind('apiBase', 'apiBase'); bind('engine', 'engine'); bind('voice', 'voice');
  bind('rate', 'rate', { out: 'rateOut', fmt: (v) => v.toFixed(2) + '×', num: true });
  bind('interval', 'interval', { out: 'intervalOut', fmt: (v) => v + 's', num: true });
  bind('fontSize', 'fontSize', { out: 'fontOut', fmt: (v) => v + '%', num: true });
  bind('autoSpeak', 'autoSpeak'); bind('vibrate', 'vibrate'); bind('quietClear', 'quietClear'); bind('contrast', 'contrast');
  $('apiBase').addEventListener('change', () => { refreshServerInfo(); });
  $('btnTest').addEventListener('click', () => refreshServerInfo(true));
  $('btnTestVoice').addEventListener('click', () => speaker.speak('Drishti voice test. Path is clear.'));
}

function renderLanguages() {
  const sel = $('language'); sel.replaceChildren();
  for (const l of state.languages) sel.append(el('option', { value: l.code, text: l.name === l.native ? l.name : `${l.name} — ${l.native}` }));
  sel.value = state.prefs.language;
}
const TEST_PHRASES = {
  kn: "ದೃಷ್ಟಿ ಧ್ವನಿ ಸಕ್ರಿಯವಾಗಿದೆ. ಸುರಕ್ಷತಾ ಮಾರ್ಗ ಸ್ಪಷ್ಟವಾಗಿದೆ.",
  hi: "दृष्टि वॉयस सक्रिय है। रास्ता साफ़ है।",
  te: "దృష్టి వాయిస్ ప్రారంభమైంది. దారి స్పష్టంగా ఉంది.",
  ta: "திருஷ்டி குரல் இயங்குகிறது. பாதை தெளிவாக உள்ளது.",
  en: "Drishti voice is active. Path is clear.",
};

function testCurrentLanguageVoice() {
  const currentLang = state.prefs.language || 'kn';
  const phrase = TEST_PHRASES[currentLang] || TEST_PHRASES.en;
  playChime('success');
  say(phrase, { force: true });
}

$('language').addEventListener('change', (e) => {
  state.prefs.language = e.target.value;
  persist();
  applyDisplay();
  const confirmationPhrases = {
    kn: "ಕನ್ನಡ ಭಾಷೆಯನ್ನು ಆಯ್ಕೆ ಮಾಡಲಾಗಿದೆ.",
    hi: "हिंदी भाषा चुनी गई है।",
    te: "తెలుగు భాష ఎంపిక చేయబడింది.",
    ta: "தமிழ் மொழி தேர்ந்தெடுக்கப்பட்டது.",
    en: "English language selected.",
  };
  const msg = confirmationPhrases[e.target.value] || `Selected ${e.target.value}`;
  say(msg, { force: true });
});

function renderModes() {
  const g = $('modes'); g.replaceChildren();
  state.modes.forEach((m, i) => {
    const b = el('button', { class: 'mode', role: 'radio', type: 'button', 'data-id': m.id, title: `${m.description} (${i + 1})` },
      el('strong', { text: shortTitle(m) }),
      el('small', { text: m.description }));
    b.addEventListener('click', () => setMode(m.id, true));
    g.append(b);
  });
  setMode(state.prefs.mode);
}
const shortTitle = (m) => ({ safety: 'Safety', read: 'Read text', currency: 'Currency', all: 'Everything' }[m.id] || m.title);
function setMode(id, announce) {
  if (!state.modes.some((m) => m.id === id)) id = 'safety';
  state.prefs.mode = id; persist();
  document.querySelectorAll('.mode').forEach((b) => { const on = b.dataset.id === id; b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1; });
  if (announce) say(shortTitle({ id }) + ' mode', { interrupt: true, force: true });
}

async function refreshServerInfo(verbose) {
  const pill = $('status'), out = $('testOut'), info = $('healthInfo');
  pill.textContent = 'Connecting…'; pill.dataset.state = '';
  try {
    const h = await api.health();
    const demo = h.aiConfig?.isDemoMode;
    pill.textContent = demo ? 'Demo mode' : 'Live AI'; pill.dataset.state = demo ? 'demo' : 'live';
    pill.title = demo ? 'No Gemini API key on the server — using simulated responses' : `Model: ${h.aiConfig.primaryModel}`;
    out.textContent = 'Connected ✓';
    info.replaceChildren(...[['Product', h.product], ['Version', h.version], ['Mode', demo ? 'Demo (simulated)' : 'Live Gemini'],
      ['Primary model', h.aiConfig?.primaryModel], ['Fallback model', h.aiConfig?.fallbackModel], ['Uptime', h.uptime]]
      .flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v ?? '—') })]));
    try {
      const [l, m] = await Promise.all([api.languages(), api.modes()]);
      if (l.languages?.length) { state.languages = l.languages; renderLanguages(); }
      if (m.modes?.length) { state.modes = m.modes; renderModes(); }
    } catch {}
  } catch (e) {
    pill.textContent = 'Offline'; pill.dataset.state = 'off'; pill.title = errMsg(e);
    out.textContent = errMsg(e); info.replaceChildren();
    if (verbose) toast(errMsg(e));
  }
}

/* ---------------------------------------------------------- camera */
const video = $('video'), still = $('still'), overlay = $('overlay'), stage = $('stage');

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return toast('Camera is not available here. Use HTTPS or localhost, or upload a photo.');
  try {
    // Proactively request device microphone permission alongside camera
    requestMicrophonePermission().catch(() => {});

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    } catch (e1) {
      // Fallback for laptop webcams & desktops where environment facingMode fails
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    state.stream = stream;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
    state.source = 'camera'; state.photoData = null;
    still.hidden = true; video.hidden = false; $('stageEmpty').hidden = true; $('btnStopCam').hidden = false;
    video.addEventListener('loadedmetadata', fitStage, { once: true });
    fitStage();
    clearOverlay();
    say('Camera started', { force: true });
  } catch (e) {
    toast(e.name === 'NotAllowedError' ? 'Camera permission was denied.' : `Could not start the camera: ${e.message}`);
  }
}
function stopCamera() {
  state.walkActive = false; state.walkPaused = false; updateWalkState();
  state.stream?.getTracks().forEach((t) => t.stop()); state.stream = null; video.srcObject = null;
  if (state.source === 'camera') { state.source = null; $('stageEmpty').hidden = false; }
  $('btnStopCam').hidden = true; setAuto(false); clearOverlay();
}
function fitStage() {
  const w = video.videoWidth || still.naturalWidth || 16, h = video.videoHeight || still.naturalHeight || 9;
  stage.style.aspectRatio = `${w} / ${h}`;
  requestAnimationFrame(sizeOverlay);
}
function sizeOverlay() {
  const r = stage.getBoundingClientRect(), d = devicePixelRatio || 1;
  overlay.width = Math.round(r.width * d); overlay.height = Math.round(r.height * d);
  if (state.lastResult) drawBoxes(state.lastResult);
}
new ResizeObserver(sizeOverlay).observe(stage);

function loadPhoto(file) {
  if (!file) return;
  const rd = new FileReader();
  rd.onload = () => {
    stopCamera(); state.source = 'photo'; state.photoData = rd.result;
    still.onload = () => { fitStage(); };
    still.src = rd.result; still.hidden = false; video.hidden = true; $('stageEmpty').hidden = true;
    clearOverlay();
    analyze();
  };
  rd.readAsDataURL(file);
}

function captureFrame(maxW = 1024, quality = 0.72) {
  if (state.source === 'photo' && still.naturalWidth) return downscale(still, still.naturalWidth, still.naturalHeight, maxW, quality);
  if (state.source === 'camera' && video.videoWidth) return downscale(video, video.videoWidth, video.videoHeight, maxW, quality);
  return null;
}
function downscale(src, w, h, maxW, q) {
  const s = Math.min(1, maxW / w), c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}

/* ---------------------------------------------------------- overlay boxes */
const SEV_COLOR = { none: '#4ade80', low: '#facc15', medium: '#fb923c', high: '#f87171' };
function clearOverlay() { overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height); }
function drawBoxes(res) {
  const ctx = overlay.getContext('2d'), W = overlay.width, H = overlay.height, d = devicePixelRatio || 1;
  ctx.clearRect(0, 0, W, H);
  const draw = (box, color, label) => {
    if (!Array.isArray(box) || box.length !== 4) return;
    let [y1, x1, y2, x2] = box.map((n) => Math.max(0, Math.min(1000, Number(n) || 0)));
    const x = (x1 / 1000) * W, y = (y1 / 1000) * H, w = ((x2 - x1) / 1000) * W, h = ((y2 - y1) / 1000) * H;
    ctx.lineWidth = 3 * d; ctx.strokeStyle = color; ctx.strokeRect(x, y, w, h);
    ctx.font = `600 ${13 * d}px system-ui, sans-serif`;
    const t = label.length > 40 ? label.slice(0, 38) + '…' : label, tw = ctx.measureText(t).width + 10 * d, th = 20 * d;
    const ly = y - th < 0 ? y : y - th;
    ctx.fillStyle = color; ctx.fillRect(x, ly, tw, th);
    ctx.fillStyle = '#0b0f14'; ctx.textBaseline = 'middle'; ctx.fillText(t, x + 5 * d, ly + th / 2);
  };
  res.detectedObjects?.forEach((o) => {
    const group = detectionGroup(o.label);
    const isSharp = o.isSharpHazard || o.hazardCategory === 'sharp' || group === 'Sharp Hazards';
    const isChem = o.isChemicalHazard || o.hazardCategory === 'chemical' || group === 'Chemical Hazards';
    const isBio = o.isBiologicalHazard || o.hazardCategory === 'biological' || group === 'Biological Hazards';

    let color = SEV_COLOR[o.severity] || SEV_COLOR.low;
    let prefix = '';
    if (isSharp) { color = '#ef4444'; prefix = '⚠️ SHARP: '; }
    else if (isChem) { color = '#ea580c'; prefix = '☣️ CHEMICAL: '; }
    else if (isBio) { color = '#a855f7'; prefix = '🪲 BIO/PEST: '; }

    const surface = o.surfaceLocation ? ` [${o.surfaceLocation}]` : '';
    draw(o.box2d, color, `${prefix}${o.label}${surface} · ${o.clockPosition} · ${o.distanceMeters}m`);
  });
  res.textReadings?.forEach((t) => draw(t.box2d, '#60a5fa', t.text));
}

/* ---------------------------------------------------------- vision analysis */
function setBusy(b) {
  state.busy = b; $('scanning').hidden = !b; $('btnAnalyze').disabled = b;
  $('btnAnalyze').textContent = b ? 'Analyzing…' : 'Analyze now';
}
async function analyze({ fromAuto = false } = {}) {
  if (state.busy) return;
  const image = captureFrame();
  if (!image) { if (!fromAuto) { toast('Start the camera or upload a photo first.'); say('Start the camera or upload a photo first', { force: true }); } return; }
  setBusy(true); state.ctl = new AbortController();
  try {
    const res = await api.vision({ image, mode: state.prefs.mode, language: state.prefs.language, userPrompt: $('userPrompt').value.trim() }, state.ctl.signal);
    state.lastResult = res.data; renderResult(res);
    drawBoxes(res.data);
    announce(res.data, fromAuto);
  } catch (e) {
    if (e.message !== 'Cancelled') { toast(errMsg(e)); if (!fromAuto) say('Sorry, analysis failed. ' + errMsg(e), { force: true }); }
    if (fromAuto && e instanceof ApiError && e.status === 0) setAuto(false);
  } finally { setBusy(false); }
}
function demoModeNotice() {
  const notices = {
    en: 'Demo mode is active. Camera-based safety guidance is unavailable. Please pause and use your usual mobility aid.',
    hi: 'डेमो मोड चालू है। कैमरे से सुरक्षा मार्गदर्शन उपलब्ध नहीं है। कृपया रुकें और अपने सामान्य सहायक साधन का उपयोग करें।',
    kn: 'ಡೆಮೋ ಮೋಡ್ ಸಕ್ರಿಯವಾಗಿದೆ. ಕ್ಯಾಮೆರಾ ಆಧಾರಿತ ಸುರಕ್ಷತಾ ಮಾರ್ಗದರ್ಶನ ಲಭ್ಯವಿಲ್ಲ. ದಯವಿಟ್ಟು ನಿಲ್ಲಿಸಿ, ನಿಮ್ಮ ಸಾಮಾನ್ಯ ಸಹಾಯಕ ಸಾಧನ ಬಳಸಿ.',
    te: 'డెమో మోడ్ ప్రారంభంలో ఉంది. కెమెరా ఆధారిత భద్రతా మార్గదర్శకం అందుబాటులో లేదు. దయచేసి ఆగి, మీ సాధారణ సహాయక పరికరాన్ని ఉపయోగించండి.',
    ta: 'டெமோ முறை இயங்குகிறது. கேமரா பாதுகாப்பு வழிகாட்டல் கிடைக்கவில்லை. தயவுசெய்து நின்று, உங்கள் வழக்கமான உதவி சாதனத்தைப் பயன்படுத்தவும்.',
    mr: 'डेमो मोड सुरू आहे. कॅमेरा-आधारित सुरक्षा मार्गदर्शन उपलब्ध नाही. कृपया थांबा आणि नेहमीचे सहाय्यक साधन वापरा.',
    bn: 'ডেমো মোড চালু আছে। ক্যামেরাভিত্তিক নিরাপত্তা নির্দেশনা পাওয়া যাচ্ছে না। দয়া করে থামুন এবং আপনার পরিচিত সহায়ক উপকরণ ব্যবহার করুন.',
    gu: 'ડેમો મોડ ચાલુ છે. કેમેરા આધારિત સુરક્ષા માર્ગદર્શન ઉપલબ્ધ નથી. કૃપા કરીને થોભો અને તમારા સામાન્ય સહાયક સાધનનો ઉપયોગ કરો.',
    ml: 'ഡെമോ മോഡ് പ്രവർത്തിക്കുന്നു. ക്യാമറ അടിസ്ഥാനത്തിലുള്ള സുരക്ഷാ നിർദ്ദേശം ലഭ്യമല്ല. ദയവായി നിർത്തി പതിവ് സഹായ ഉപകരണം ഉപയോഗിക്കുക.'
  };
  return notices[state.prefs.language] || notices.en;
}

function announce(d, fromAuto) {
  // Never turn simulated sample objects into movement instructions during a walk.
  if (state.walkActive && d.isDemoMode) {
    const demoNotice = demoModeNotice();
    const dupDemo = demoNotice === state.lastSpoken.text && Date.now() - state.lastSpoken.at < 20000;
    if (!dupDemo) {
      state.lastSpoken = { text: demoNotice, at: Date.now() };
      say(demoNotice, { force: true });
    }
    return;
  }
  const alertText = d.spokenAlert || d.sceneSummary || '';
  const actionText = d.immediateAction || '';
  const text = actionText && !alertText.toLowerCase().includes(actionText.toLowerCase())
    ? `${alertText}. ${actionText}` : alertText;
  const isSharp = d.sharpHazardDetected || d.detectedObjects?.some(o => o.isSharpHazard || detectionGroup(o.label) === 'Sharp Hazards');
  const isChem = d.chemicalHazardDetected || d.detectedObjects?.some(o => o.isChemicalHazard || detectionGroup(o.label) === 'Chemical Hazards');
  const isBio = d.biologicalHazardDetected || d.detectedObjects?.some(o => o.isBiologicalHazard || detectionGroup(o.label) === 'Biological Hazards');
  const isCriticalHazard = isSharp || isChem || isBio;
  const hazard = d.hazardSeverity === 'high' || d.hazardSeverity === 'medium' || isCriticalHazard;
  if (state.prefs.vibrate && navigator.vibrate) {
    if (isSharp) navigator.vibrate([400, 100, 400, 100, 400]);
    else if (isChem) navigator.vibrate([600, 150, 600, 150]);
    else if (isBio) navigator.vibrate([300, 100, 300, 100, 300]);
    else if (d.hazardSeverity === 'high') navigator.vibrate([300, 100, 300, 100, 300]);
    else if (d.hazardSeverity === 'medium') navigator.vibrate([200, 100, 200]);
  }
  if (fromAuto) {
    if (state.prefs.quietClear && d.isPathClear && !hazard) return;
    const dup = text === state.lastSpoken.text && Date.now() - state.lastSpoken.at < 12000;
    if (dup && d.hazardSeverity !== 'high') return;
    if (speechSynthesis?.speaking && !hazard) return; // don't talk over ourselves
  }
  state.lastSpoken = { text, at: Date.now() };
  // In text-heavy modes, read the content aloud as well as the alert.
  let full = text;
  if (!fromAuto && d.textReadings?.length && state.prefs.mode !== 'safety') full += '. ' + d.textReadings.map((t) => t.text).join('. ');
  if (!fromAuto && d.currencyDetected?.present && d.currencyDetected.description) full += '. ' + d.currencyDetected.description;
  // Guided Walk always speaks safety instructions, even if general auto-speech is disabled.
  say(full, { force: state.walkActive });
}


function detectionGroup(label) {
  const s = String(label || '').toLowerCase();
  if (/\b(knife|knives|blade|blades|razor|scissor|scissors|needle|needles|pin|pins|nail|nails|screw|screws|glass|shard|shards|ceramic|cutter|scalpel|sharp|dagger|staple|stapler)\b/.test(s)) return 'Sharp Hazards';
  if (/\b(acid|acids|bleach|bleaching|chemical|chemicals|poison|toxic|corrosive|caustic|detergent|cleaner|pesticide|insecticide|solvent|spill)\b/.test(s)) return 'Chemical Hazards';
  if (/\b(insect|insects|spider|spiders|scorpion|scorpions|wasp|wasps|bee|bees|centipede|centipedes|bedbug|bedbugs|cockroach|cockroaches|ant|ants|bug|bugs|fungus|mold|mould|spore|spores)\b/.test(s)) return 'Biological Hazards';
  if (/\b(car|truck|bus|van|motorcycle|motorbike|scooter|bike|bicycle|auto|vehicle|train)\b/.test(s)) return 'Vehicles';
  if (/\b(person|people|pedestrian|man|woman|child|crowd|human)\b/.test(s)) return 'People';
  if (/\b(dog|cat|cow|goat|horse|animal|bird|monkey|cattle|sheep)\b/.test(s)) return 'Animals';
  return 'Obstacles';
}
function updateDetectionSummary(objects = []) {
  const groups = { 'Sharp Hazards': 0, 'Chemical Hazards': 0, 'Biological Hazards': 0, Obstacles: 0, Vehicles: 0, People: 0, Animals: 0 };
  objects.forEach(o => {
    let grp = 'Obstacles';
    if (o.isSharpHazard || o.hazardCategory === 'sharp') grp = 'Sharp Hazards';
    else if (o.isChemicalHazard || o.hazardCategory === 'chemical') grp = 'Chemical Hazards';
    else if (o.isBiologicalHazard || o.hazardCategory === 'biological') grp = 'Biological Hazards';
    else grp = detectionGroup(o.label);

    if (groups[grp] !== undefined) groups[grp]++;
    else groups.Obstacles++;
  });
  const summary = $('detectionSummary');
  if (!summary) return;
  summary.replaceChildren();
  const entries = Object.entries(groups).filter(([, count]) => count > 0);
  if (!entries.length) {
    summary.append(el('span', { text: 'No objects reported in the latest scan' }));
    return;
  }
  entries.forEach(([name, count]) => {
    let cls = '';
    if (name === 'Sharp Hazards') cls = 'tag-sharp';
    else if (name === 'Chemical Hazards') cls = 'tag-chemical';
    else if (name === 'Biological Hazards') cls = 'tag-biological';
    summary.append(el('span', { class: cls, text: `${name}: ${count}` }));
  });
}
function updateWalkState() {
  const pill = $('walkState'), pause = $('btnWalkPause'), end = $('btnWalkEnd'), start = $('btnWalkStart');
  if (!pill) return;
  pill.textContent = !state.walkActive ? 'Not started' : state.walkPaused ? 'Paused' : 'Scanning';
  pill.dataset.state = !state.walkActive ? 'off' : state.walkPaused ? 'demo' : 'live';
  pause.textContent = state.walkPaused ? 'Resume' : 'Pause';
  pause.disabled = !state.walkActive;
  end.disabled = !state.walkActive;
  start.disabled = state.walkActive;
  $('walkHelp').textContent = !state.walkActive
    ? 'Starting a walk turns on continuous safety scans. It does not provide GPS turn-by-turn navigation.'
    : state.walkPaused
      ? 'Scanning is paused. Resume when you are safely ready to continue.'
      : 'Safety scanning is active. Do not rely on this prototype as your only source of mobility or traffic awareness.';
}
async function startGuidedWalk() {
  if (state.source !== 'camera') {
    await startCamera();
    if (state.source !== 'camera') return;
  }
  setMode('safety', true);
  state.walkActive = true;
  state.walkPaused = false;
  updateWalkState();
  setAuto(true);
  say('Guided walk started. Please remain aware of your surroundings.', { force: true });
}
function pauseGuidedWalk() {
  if (!state.walkActive) return;
  state.walkPaused = !state.walkPaused;
  if (state.walkPaused) setAuto(false);
  else setAuto(true);
  updateWalkState();
  say(state.walkPaused ? 'Guided walk paused.' : 'Guided walk resumed.', { force: true });
}
function endGuidedWalk() {
  state.walkActive = false;
  state.walkPaused = false;
  setAuto(false);
  updateWalkState();
  say('Guided walk ended.', { force: true });
}

function renderResult(res) {
  const d = res.data, box = $('result');
  const isSharp = d.sharpHazardDetected || d.detectedObjects?.some(o => o.isSharpHazard || o.hazardCategory === 'sharp' || detectionGroup(o.label) === 'Sharp Hazards');
  const isChem = d.chemicalHazardDetected || d.detectedObjects?.some(o => o.isChemicalHazard || o.hazardCategory === 'chemical' || detectionGroup(o.label) === 'Chemical Hazards');
  const isBio = d.biologicalHazardDetected || d.detectedObjects?.some(o => o.isBiologicalHazard || o.hazardCategory === 'biological' || detectionGroup(o.label) === 'Biological Hazards');
  const isCritical = isSharp || isChem || isBio;
  const sev = isCritical ? 'high' : (d.hazardSeverity || 'none');
  box.className = 'result sev-' + sev;
  const kids = [];

  if (isSharp) {
    kids.push(el('div', { class: 'hazard-banner banner-sharp', role: 'alert' },
      el('span', { class: 'hazard-banner-icon', text: '⚠️' }),
      el('div', { class: 'hazard-banner-body' },
        el('strong', { text: 'CRITICAL SHARP HAZARD DETECTED ON SURFACE' }),
        el('p', { text: d.surfaceAlert || 'Caution: Sharp object (knife, razor, blade, or glass) detected. Avoid blind physical contact.' })
      )
    ));
  }
  if (isChem) {
    kids.push(el('div', { class: 'hazard-banner banner-chemical', role: 'alert' },
      el('span', { class: 'hazard-banner-icon', text: '☣️' }),
      el('div', { class: 'hazard-banner-body' },
        el('strong', { text: 'HAZARDOUS CHEMICAL OR ACID DETECTED' }),
        el('p', { text: d.surfaceAlert || 'Danger: Acid, bleaching powder, or corrosive chemical bottle detected. Do not touch or inhale.' })
      )
    ));
  }
  if (isBio) {
    kids.push(el('div', { class: 'hazard-banner banner-biological', role: 'alert' },
      el('span', { class: 'hazard-banner-icon', text: '🪲' }),
      el('div', { class: 'hazard-banner-body' },
        el('strong', { text: 'BIOLOGICAL PEST OR FUNGAL HAZARD DETECTED' }),
        el('p', { text: d.surfaceAlert || 'Warning: Insect, pest, or fungal mold spotted on surface. Check before sitting or touching.' })
      )
    ));
  }

  let sevBadgeText = 'Hazard: ' + sev;
  let sevBadgeClass = 'badge sev';
  if (isSharp) { sevBadgeText = 'SHARP HAZARD'; sevBadgeClass += ' sev-sharp'; }
  else if (isChem) { sevBadgeText = 'CHEMICAL HAZARD'; sevBadgeClass += ' sev-chem'; }
  else if (isBio) { sevBadgeText = 'BIO HAZARD'; sevBadgeClass += ' sev-bio'; }

  kids.push(el('div', { class: 'hero' },
    el('span', { class: 'badge ' + (d.isPathClear && !isCritical ? 'ok' : 'bad'), text: d.isPathClear && !isCritical ? 'Path clear' : 'Hazard alert' }),
    el('span', { class: sevBadgeClass, text: sevBadgeText }),
    d.isDemoMode ? el('span', { class: 'badge demo', text: 'Demo' }) : null,
    el('h2', { class: 'alert', text: d.spokenAlert }),
    d.immediateAction ? el('p', { class: 'action' }, el('strong', { text: 'Recommended action: ' }), d.immediateAction) : null));
  if (d.detectedObjects?.length) kids.push(section('Detected objects', el('ul', { class: 'list' }, d.detectedObjects.map((o) => {
    const group = detectionGroup(o.label);
    const sharpObj = o.isSharpHazard || o.hazardCategory === 'sharp' || group === 'Sharp Hazards';
    const chemObj = o.isChemicalHazard || o.hazardCategory === 'chemical' || group === 'Chemical Hazards';
    const bioObj = o.isBiologicalHazard || o.hazardCategory === 'biological' || group === 'Biological Hazards';

    let itemClass = '';
    let prefix = '';
    let color = SEV_COLOR[o.severity] || SEV_COLOR.low;

    if (sharpObj) { itemClass = 'item-sharp'; prefix = '⚠️ SHARP: '; color = '#ef4444'; }
    else if (chemObj) { itemClass = 'item-chem'; prefix = '☣️ CHEM: '; color = '#ea580c'; }
    else if (bioObj) { itemClass = 'item-bio'; prefix = '🪲 BIO: '; color = '#a855f7'; }

    const surfaceTag = o.surfaceLocation ? ` [on ${o.surfaceLocation}]` : '';
    const statusNote = sharpObj ? 'SHARP HAZARD' : chemObj ? 'CHEMICAL HAZARD' : bioObj ? 'BIO HAZARD' : o.severity;

    return el('li', { class: itemClass },
      el('span', { class: 'dot', style: `background:${color}` }),
      el('strong', { text: prefix + o.label + surfaceTag }),
      ` — ${o.clockPosition}, ${o.distanceMeters} m `,
      el('em', { text: `(${statusNote})` }));
  }))));
  if (d.textReadings?.length) kids.push(section('Text found', el('ul', { class: 'list' }, d.textReadings.map((t) =>
    el('li', {}, el('span', { class: 'tag', text: t.category }), el('q', { text: t.text }), el('small', { text: ` ${Math.round((t.confidence ?? 0) * 100)}%` }))))));
  const c = d.currencyDetected;
  if (c?.present) kids.push(section('Currency', el('p', {}, el('strong', { text: `${c.currency || ''} ${c.denomination ?? ''}`.trim() }),
    c.confidence != null ? ` (${Math.round(c.confidence * 100)}% sure)` : '', c.description ? el('br') : null, c.description || '')));
  kids.push(section('Scene', el('p', { text: d.sceneSummary })));
  if (d.safetyNote) kids.push(section('Safety tip', el('p', { text: d.safetyNote })));
  const meta = [new Date(res.timestamp).toLocaleTimeString(), d.modelUsed, d.fallbackReason && `fallback: ${d.fallbackReason}`].filter(Boolean).join(' · ');
  kids.push(el('p', { class: 'meta', text: meta }));
  box.replaceChildren(...kids);
  updateDetectionSummary(d.detectedObjects || []);
}
const section = (title, body) => el('section', { class: 'sec' }, el('h3', { text: title }), body);


function installDetectionSummary() {
  const result = $('result');
  if (!result || $('detectionSummary')) return;
  const wrap = el('section', { class: 'sec' },
    el('h3', { text: 'Latest detection categories' }),
    el('div', { id: 'detectionSummary', class: 'object-summary', 'aria-live': 'polite' },
      el('span', { text: 'Waiting for the first scan' })));
  result.parentNode.insertBefore(wrap, result);
}

/* ---------------------------------------------------------- auto-scan */
function setAuto(on) {
  if (on && !state.source) { toast('Start the camera first.'); on = false; }
  if (on && state.source === 'photo') on = false;
  clearInterval(state.autoTimer); state.auto = on;
  $('btnAuto').setAttribute('aria-pressed', on); $('btnAuto').textContent = 'Auto-scan: ' + (on ? 'on' : 'off');
  $('btnAuto').classList.toggle('active', on);
  if (state.walkActive && !on && !state.walkPaused) { state.walkPaused = true; updateWalkState(); }
  if (state.walkActive && on && state.walkPaused) { state.walkPaused = false; updateWalkState(); }
  if (on) { analyze({ fromAuto: true }); state.autoTimer = setInterval(() => analyze({ fromAuto: true }), state.prefs.interval * 1000); }
}

/* ---------------------------------------------------------- voice input */
async function dictate(btn, input, then) {
  if (btn.classList.contains('listening')) return;
  speaker.stop();
  btn.classList.add('listening'); btn.setAttribute('aria-pressed', 'true');
  const old = input.placeholder;
  input.placeholder = '🎙️ Listening… speak now';
  input.value = '';
  showTranscript('🎙️ Listening…');

  // Detect HTTP on mobile → MediaRecorder path needs apiBase to call /api/transcribe
  const apiBase = resolveApiBase();

  try {
    const t = await listen(lang().bcp47, {
      apiBase,
      onInterim: (x) => {
        if (x) {
          input.value = x;
          input.placeholder = x;   // show on placeholder too in case value not visible
          showTranscript(x);
        }
      }
    });
    if (t) {
      input.value = t;
      showTranscript(t);
      playChime('success');
      then?.(t);
    } else {
      input.value = '';
      toast('I did not hear anything. Try speaking again or type your question.');
    }
  } catch (e) {
    toast(errMsg(e));
  } finally {
    btn.classList.remove('listening');
    btn.setAttribute('aria-pressed', 'false');
    input.placeholder = old;
  }
}
const micVision = () => dictate($('btnMicPrompt'), $('userPrompt'), () => analyze());
const micChat   = () => dictate($('btnMicChat'),   $('chatInput'),   () => sendChat());

/* ---------------------------------------------------------- chat */
function addMsg(role, text, extra) {
  const m = el('div', { class: 'msg ' + role }, el('div', { class: 'bubble ' + (extra?.urgency || '') }, text));
  if (extra?.note) m.firstChild.append(el('small', { class: 'note', text: extra.note }));
  $('chatLog').append(m); $('chatLog').scrollTop = $('chatLog').scrollHeight; return m;
}
function setChips(list) {
  const c = $('chips'); c.replaceChildren();
  (list || []).forEach((s) => c.append(el('button', { class: 'chip', type: 'button', onclick: () => { $('chatInput').value = s; sendChat(); } }, s)));
}
async function sendChat() {
  const msg = $('chatInput').value.trim();
  if (!msg || state.chatBusy) return;
  state.chatBusy = true; $('chatInput').value = ''; setChips([]);
  addMsg('user', msg);
  const pending = addMsg('model pending', 'Thinking…');
  const image = $('chatWithFrame').checked ? captureFrame(800, 0.65) : null;
  if ($('chatWithFrame').checked && !image) toast('No camera view available — sending text only.');
  try {
    const r = await api.chat({ message: msg, history: state.history.slice(-10), language: state.prefs.language, image });
    const d = r.data; pending.remove();
    addMsg('model', d.reply, { urgency: d.urgency, note: d.isDemoMode ? 'Demo response' : null });
    state.history.push({ role: 'user', text: msg }, { role: 'model', text: d.reply });
    setChips(d.suggestedActions);
    if (d.urgency === 'critical' && state.prefs.vibrate && navigator.vibrate) navigator.vibrate([300, 100, 300]);
    say(d.spokenText || d.reply);
  } catch (e) {
    pending.remove(); addMsg('model error', 'Sorry, something went wrong: ' + errMsg(e));
  } finally { state.chatBusy = false; }
}

/* ---------------------------------------------------------- wiring */
$('btnCamera').addEventListener('click', startCamera);
$('btnWalkStart').addEventListener('click', startGuidedWalk);
$('btnWalkPause').addEventListener('click', pauseGuidedWalk);
$('btnWalkEnd').addEventListener('click', endGuidedWalk);
$('btnStopCam').addEventListener('click', stopCamera);
$('btnAnalyze').addEventListener('click', () => analyze());
$('btnAuto').addEventListener('click', () => setAuto(!state.auto));
$('fileInput').addEventListener('change', (e) => { loadPhoto(e.target.files[0]); e.target.value = ''; });
$('userPrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });
$('btnMicPrompt').addEventListener('click', micVision);
$('btnMicChat').addEventListener('click', micChat);
$('btnRepeat').addEventListener('click', () => { const t = state.lastSpoken.text; t ? speaker.speak(t) : toast('Nothing to repeat yet.'); });
$('btnStop').addEventListener('click', () => speaker.stop());
$('chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
$('btnClearChat').addEventListener('click', () => {
  state.history = []; setChips([]);
  $('chatLog').replaceChildren(el('div', { class: 'msg model' }, el('div', { class: 'bubble', text: 'Conversation cleared.' })));
});
$('modes').addEventListener('keydown', (e) => {
  const ids = state.modes.map((m) => m.id), i = ids.indexOf(state.prefs.mode);
  const j = ['ArrowRight', 'ArrowDown'].includes(e.key) ? (i + 1) % ids.length : ['ArrowLeft', 'ArrowUp'].includes(e.key) ? (i + ids.length - 1) % ids.length : -1;
  if (j >= 0) { e.preventDefault(); setMode(ids[j], true); document.querySelector(`.mode[data-id="${ids[j]}"]`).focus(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { speaker.stop(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
  const k = e.key.toLowerCase(), onChat = !$('panel-chat').hidden, onVision = !$('panel-vision').hidden;
  if (k === 'm' && (onVision || onChat)) { e.preventDefault(); (onChat ? micChat : micVision)(); }
  if (!onVision) return;
  if (k === 'a') { e.preventDefault(); analyze(); }
  else if (k === 's') setAuto(!state.auto);
  else if (k === 'r') $('btnRepeat').click();
  else if (/^[1-9]$/.test(k) && state.modes[+k - 1]) setMode(state.modes[+k - 1].id, true);
});
window.addEventListener('beforeunload', () => { speaker.stop(); stopCamera(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && state.auto) setAuto(false); });

if (!recognitionSupported()) ['btnMicPrompt', 'btnMicChat'].forEach((id) => { $(id).title = 'Voice input needs Chrome or Edge'; $(id).classList.add('unsupported'); });

/* ---------------------------------------------------------- Voice-First Assistant */
let continuousRec = null;
let voiceAssistantActive = false;
let lastScreenTapTime = 0;

const VOICE_WELCOME = {
  kn: "ದೃಷ್ಟಿ ಧ್ವನಿ ಸಹಾಯಕ ಪ್ರಾರಂಭವಾಗಿದೆ. ಕ್ಯಾಮರಾ ಮತ್ತು ಸುರಕ್ಷತಾ ಸ್ಕ್ಯಾನಿಂಗ್ ಸಕ್ರಿಯವಾಗಿದೆ. ನೀವು ಯಾವುದೇ ಸಮಯದಲ್ಲಿ ಧ್ವನಿ ಆಜ್ಞೆಗಳನ್ನು ನೀಡಬಹುದು.",
  hi: "दृष्टि वॉयस असिस्टेंट शुरू हो गया है। कैमरा और सुरक्षा स्कैनिंग सक्रिय है। आप बोलकर निर्देश दे सकते हैं।",
  te: "దృష్టి వాయిస్ అసిస్టెంట్ ప్రారంభమైంది. కెమెరా మరియు భద్రతా స్కానింగ్ పనిచేస్తున్నాయి. మాట్లాడి ఆదేశాలు ఇవ్వండి.",
  ta: "திருஷ்டி குரல் உதவியாளர் தொடங்கியது. கேமரா மற்றும் பாதுகாப்பு ஸ்கேனிங் இயங்குகிறது. எப்போது வேண்டுமானாலும் பேசுங்கள்.",
  en: "Welcome to Drishti. Camera is active and continuous safety scanning is on. Everything can be controlled by voice. Tap anywhere to speak or say any command."
};

function updateHud(statusText, isListening = false, isSpeaking = false) {
  const hud = $('voiceHud'), status = $('voiceHudStatus'), btn = $('btnVoiceFloat');
  if (status) status.textContent = statusText;
  if (hud) {
    hud.classList.toggle('listening', isListening);
    hud.classList.toggle('speaking', isSpeaking);
  }
  if (btn) {
    btn.classList.toggle('listening', isListening);
    const txt = btn.querySelector('.voice-float-text');
    if (txt) txt.textContent = isListening ? 'Listening…' : 'Tap to Speak';
  }
}

function showTranscript(text) {
  const t = $('voiceHudTranscript');
  if (t) t.textContent = text ? `“${text}”` : '';
}

let consecutiveSpeechErrors = 0;
let speechRetryTimer = null;

function initVoiceAssistant() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  try {
    continuousRec = new SR();
    continuousRec.continuous = true;
    continuousRec.interimResults = true;
    continuousRec.maxAlternatives = 1;
    continuousRec.lang = lang().bcp47 || 'en-US';

    continuousRec.onstart = () => {
      consecutiveSpeechErrors = 0;
      updateHud('🎙️ Voice Active · Listening for commands', true, false);
    };

    continuousRec.onresult = (e) => {
      if (speaker.isSpeaking()) return;
      let interim = '';
      let finalStr = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const trans = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalStr += trans;
        else interim += trans;
      }
      const cur = (finalStr || interim).trim();
      if (cur) showTranscript(cur);
      if (finalStr.trim()) {
        handleVoiceCommand(finalStr.trim());
      }
    };

    continuousRec.onerror = (e) => {
      if (e.error === 'network') {
        consecutiveSpeechErrors++;
        console.warn('SpeechRecognition network issue (count:', consecutiveSpeechErrors, ')');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('SpeechRecognition error:', e.error);
      }
    };

    continuousRec.onend = () => {
      if (voiceAssistantActive && !speaker.isSpeaking()) {
        // Back off gently on network errors to avoid rapid loop
        const delay = consecutiveSpeechErrors > 2 ? 3000 : 600;
        clearTimeout(speechRetryTimer);
        speechRetryTimer = setTimeout(() => {
          if (voiceAssistantActive && !speaker.isSpeaking()) {
            try {
              // If regional tag has persistent network issues in browser, fallback to en-US for commands
              continuousRec.lang = consecutiveSpeechErrors > 3 ? 'en-US' : (lang().bcp47 || 'en-US');
              continuousRec.start();
            } catch {}
          }
        }, delay);
      } else {
        updateHud('🎙️ Voice Standby', false, false);
      }
    };
  } catch (e) {
    console.warn('Could not init continuous speech recognition:', e);
  }
}

function startContinuousListening() {
  voiceAssistantActive = true;
  if (!continuousRec) initVoiceAssistant();
  if (continuousRec) {
    try {
      continuousRec.lang = lang().bcp47;
      continuousRec.start();
    } catch {}
  }
  updateHud('🎙️ Voice Active · Listening for commands', true, false);
}

function stopContinuousListening() {
  voiceAssistantActive = false;
  if (continuousRec) {
    try { continuousRec.stop(); } catch {}
  }
  updateHud('🎙️ Voice Paused', false, false);
}

async function handleVoiceCommand(raw) {
  const t = raw.toLowerCase().trim();
  showTranscript(raw);

  // 1. Language switching
  if (/\b(kannada|kannad)\b/i.test(t) || /ಕನ್ನಡ/.test(t)) {
    playChime('success');
    switchLanguage('kn', 'ಕನ್ನಡ ಭಾಷೆಯನ್ನು ಆಯ್ಕೆ ಮಾಡಲಾಗಿದೆ.');
    return;
  }
  if (/\b(hindi)\b/i.test(t) || /हिंदी/.test(t)) {
    playChime('success');
    switchLanguage('hi', 'हिंदी भाषा चुनी गई है।');
    return;
  }
  if (/\b(telugu)\b/i.test(t) || /తెలుగు/.test(t)) {
    playChime('success');
    switchLanguage('te', 'తెలుగు భాష ఎంపిక చేయబడింది.');
    return;
  }
  if (/\b(tamil)\b/i.test(t) || /தமிழ்/.test(t)) {
    playChime('success');
    switchLanguage('ta', 'தமிழ் மொழி தேர்ந்தெடுக்கப்பட்டது.');
    return;
  }
  if (/\b(english)\b/i.test(t)) {
    playChime('success');
    switchLanguage('en', 'Switched to English.');
    return;
  }

  // 2. Mode switching
  if (/\b(read|reading|text|sign|signs|board|medicine|label|odhu|padho|chaduvu|padi)\b/i.test(t) || /ಓದು|ಪಠ್ಯ|पढ़|చదువు|படி/.test(t)) {
    playChime('success');
    setMode('read', true);
    analyze();
    return;
  }
  if (/\b(currency|money|cash|note|rupee|banknote|hana|paise|dabbulu|panam)\b/i.test(t) || /ಹಣ|ನೋಟು|करेंसी|पैसे|నోటు|பணம்/.test(t)) {
    playChime('success');
    setMode('currency', true);
    analyze();
    return;
  }
  if (/\b(safety|hazard|obstacle|suraksha|bhadrata|kavach)\b/i.test(t) || /ಸುರಕ್ಷತೆ|सुरक्षा|రక్షణ|பாதுகாப்பு/.test(t)) {
    playChime('success');
    setMode('safety', true);
    analyze();
    return;
  }
  if (/\b(everything|all|comprehensive|yella|sab|anni|ellam)\b/i.test(t)) {
    playChime('success');
    setMode('all', true);
    analyze();
    return;
  }

  // 3. Navigation controls
  if (/\b(walk|start walk|guided walk|begin|nadiri|chalo|nadavandi|nada)\b/i.test(t) || /ನಡೆಯಿರಿ|चलना|నడవండి/.test(t)) {
    playChime('success');
    startGuidedWalk();
    return;
  }
  if (/\b(stop|halt|end walk|stop walk|nillisu|ruko|aagu|aagandi|nillu)\b/i.test(t) || /ನಿಲ್ಲಿಸು|रुको|ఆపు|நிறுத்து/.test(t)) {
    playChime('stop');
    speaker.stop();
    endGuidedWalk();
    say('Walk stopped. Standing by.', { force: true });
    return;
  }
  if (/\b(pause|virama|rok|aagisi)\b/i.test(t) || /ವಿರಾಮ|रोकें|పాజ్/.test(t)) {
    playChime('stop');
    pauseGuidedWalk();
    return;
  }
  if (/\b(resume|continue|munaduvarsi|jaari|malli)\b/i.test(t) || /ಮುಂದುವರಿಸಿ|जारी|కొనసాగించు/.test(t)) {
    playChime('success');
    if (state.walkPaused) pauseGuidedWalk();
    return;
  }
  if (/\b(scan|analyze|check|what is in front|what's in front|what do you see|mundhe enidhe|kya hai|mundu emundi|enna irukku)\b/i.test(t) || /ಮುಂದೆ ಏನಿದೆ|सामने क्या है/.test(t)) {
    playChime('listen');
    analyze();
    return;
  }
  if (/\b(repeat|again|matthe heli|phir se|malli cheppu|marupadiyum)\b/i.test(t) || /ಮತ್ತೆ ಹೇಳಿ|फिर से|మళ్ళీ/.test(t)) {
    playChime('success');
    const prev = state.lastSpoken.text;
    if (prev) speaker.speak(prev, { force: true });
    else say('Nothing to repeat yet.', { force: true });
    return;
  }

  // 4. Help
  if (/\b(help|commands|instructions|what can i say)\b/i.test(t)) {
    playChime('success');
    say("You can say: Read text, Currency, Safety, Start walk, Stop, Pause, Repeat, or name a language like Kannada, Hindi, or English. You can also ask any question about what is in front of you.", { force: true });
    return;
  }

  // 5. Conversational / Visual Q&A
  playChime('listen');
  const frame = captureFrame(800, 0.65);
  say("Checking: " + raw, { force: true });
  try {
    const r = await api.chat({ message: raw, history: state.history.slice(-6), language: state.prefs.language, image: frame });
    const d = r.data;
    state.history.push({ role: 'user', text: raw }, { role: 'model', text: d.reply });
    say(d.spokenText || d.reply, { force: true });
  } catch (err) {
    say("Could not answer question: " + errMsg(err), { force: true });
  }
}

function switchLanguage(code, confirmationText) {
  state.prefs.language = code;
  persist();
  applyDisplay();
  const sel = $('language');
  if (sel) sel.value = code;
  if (continuousRec) continuousRec.lang = lang().bcp47;
  say(confirmationText, { force: true });
}

async function startVoiceNavigation() {
  const overlay = $('voiceOverlay');
  if (overlay) overlay.hidden = true;
  playChime('start');

  // Start camera if not running
  if (state.source !== 'camera') {
    await startCamera();
  }

  // Start guided walk continuous scanning
  startGuidedWalk();

  // Welcome Announcement
  const welcome = VOICE_WELCOME[state.prefs.language] || VOICE_WELCOME.en;
  await say(welcome, { force: true });

  // Activate continuous voice listener
  startContinuousListening();
}

async function triggerVoiceInput() {
  playChime('listen');
  updateHud('🎙️ Listening to you now… speak your question or command', true, false);
  const promptInput = $('userPrompt');
  const chatInput = $('chatInput');
  const targetInput = !$('panel-chat').hidden ? chatInput : promptInput;
  const oldPlaceholder = targetInput ? targetInput.placeholder : '';
  if (targetInput) {
    targetInput.value = '';
    targetInput.placeholder = '🎙️ Listening… speak now';
  }

  const apiBase = resolveApiBase();

  try {
    const text = await listen(lang().bcp47, {
      apiBase,
      onInterim: (x) => {
        showTranscript(x);
        if (targetInput && x) {
          targetInput.value = x;
          targetInput.placeholder = x;
        }
      }
    });
    if (text) {
      if (targetInput) targetInput.value = text;
      showTranscript(text);
      playChime('success');
      handleVoiceCommand(text);
    } else {
      updateHud('🎙️ Voice Active · Listening for commands', true, false);
    }
  } catch (err) {
    toast(errMsg(err));
    updateHud('🎙️ Voice Active · Listening for commands', true, false);
  } finally {
    if (targetInput) targetInput.placeholder = oldPlaceholder;
  }
}

/* Screen Tap Gestures for Blind Navigation */
document.addEventListener('click', (e) => {
  // If voice overlay is active, clicking anywhere starts voice navigation!
  const overlay = $('voiceOverlay');
  if (overlay && !overlay.hidden) {
    startVoiceNavigation();
    return;
  }

  // If clicking on specific interactive controls, allow standard behavior
  const tag = e.target.tagName;
  if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A', 'LABEL'].includes(tag) || e.target.closest('button, input, select, textarea, a, label, .mode')) {
    return;
  }

  // Double tap detection (within 350ms) = repeat last spoken alert
  const now = Date.now();
  if (now - lastScreenTapTime < 350) {
    lastScreenTapTime = 0;
    playChime('success');
    const t = state.lastSpoken.text;
    if (t) speaker.speak(t, { force: true });
    return;
  }
  lastScreenTapTime = now;

  // Single tap on background = trigger voice input
  triggerVoiceInput();
});

// Spacebar / Enter shortcut when overlay is open
document.addEventListener('keydown', (e) => {
  const overlay = $('voiceOverlay');
  if (overlay && !overlay.hidden) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      startVoiceNavigation();
    }
  }
});

// Floating Voice Button & Overlay Button & Header Test Voice Button
$('btnStartVoiceMode')?.addEventListener('click', (e) => { e.stopPropagation(); startVoiceNavigation(); });
$('voiceTapBanner')?.addEventListener('click', (e) => { e.stopPropagation(); startVoiceNavigation(); });
$('btnVoiceFloat')?.addEventListener('click', (e) => { e.stopPropagation(); triggerVoiceInput(); });
$('btnHeaderTestVoice')?.addEventListener('click', (e) => { e.stopPropagation(); testCurrentLanguageVoice(); });

bindSettings(); applyDisplay(); renderLanguages(); renderModes(); installDetectionSummary(); updateWalkState(); showTab('vision'); refreshServerInfo();
if ('speechSynthesis' in window) speechSynthesis.getVoices();
