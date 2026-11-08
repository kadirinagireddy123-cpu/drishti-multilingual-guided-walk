// Text-to-speech (server gTTS audio with browser fallback), earcons/chimes, and voice assistant.

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// Earcon auditory chimes for blind accessibility
export function playChime(type = 'listen') {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'start') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.18);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    } else if (type === 'listen') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.22);
    } else if (type === 'success') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(783.99, now + 0.08);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === 'stop') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(750, now);
      osc.frequency.exponentialRampToValueAtTime(350, now + 0.18);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === 'hazard') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(440, now + 0.1);
      osc.frequency.setValueAtTime(880, now + 0.2);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    }
  } catch {}
}

export class Speaker {
  constructor(api, getPrefs) {
    this.api = api;
    this.getPrefs = getPrefs;
    this.audio = null;
    this.token = 0;
    this.speaking = false;
  }

  isSpeaking() {
    return this.speaking || (typeof window !== 'undefined' && !!window.speechSynthesis?.speaking);
  }

  stop() {
    this.token++;
    this.speaking = false;
    try { speechSynthesis.cancel(); } catch {}
    if (this.audio) {
      try { this.audio.pause(); } catch {}
      this.audio = null;
    }
  }

  async speak(text, { interrupt = true } = {}) {
    if (!text) return;
    const p = this.getPrefs();
    if (interrupt) this.stop();
    const my = ++this.token;
    this.speaking = true;

    // 1. Primary: Server-side gTTS audio (native Kannada, Hindi, Telugu, Tamil, English, etc.)
    try {
      const r = await this.api.tts({
        text,
        language: p.language || 'en',
        voice: p.voice || 'neutral',
      });
      if (my !== this.token) return;
      const d = r?.data;
      if (d && d.audioData) {
        await this.#playAudio(`data:${d.audioMimeType || 'audio/mp3'};base64,${d.audioData}`, p.rate, my);
        if (my === this.token) this.speaking = false;
        return;
      }
    } catch (err) {
      console.warn('Server TTS failed, falling back to browser voice:', err);
    }

    if (my !== this.token) return;

    // 2. Fallback: Browser Web Speech API
    await this.#browserSpeak(text, p.bcp47, p, my);
    if (my === this.token) this.speaking = false;
  }

  #playAudio(src, rate, my) {
    return new Promise((resolve) => {
      try {
        const a = new Audio();
        a.src = src;
        a.playbackRate = Math.min(rate || 1.0, 1.5);
        this.audio = a;

        a.onended = () => {
          if (my === this.token) this.speaking = false;
          resolve();
        };

        a.onerror = (e) => {
          console.warn('Audio element error:', e);
          if (my === this.token) this.speaking = false;
          resolve();
        };

        const playPromise = a.play();
        if (playPromise !== undefined) {
          playPromise.catch((err) => {
            console.warn('Audio autoplay blocked by browser or failed:', err);
            if (my === this.token) this.speaking = false;
            resolve();
          });
        }
      } catch (err) {
        console.warn('Could not play audio:', err);
        if (my === this.token) this.speaking = false;
        resolve();
      }
    });
  }

  #browserSpeak(text, lang, p, my) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) {
        if (my === this.token) this.speaking = false;
        return resolve();
      }
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang;
        u.rate = p.rate || 1.0;
        u.pitch = 1;
        u.volume = 1;
        const voices = speechSynthesis.getVoices();
        const base = (lang || 'en').split('-')[0].toLowerCase();
        let cand = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith(base));
        if (p.voice === 'female') cand = cand.filter(v => /female|woman|zira|samantha|google.*(uk|us)/i.test(v.name)).concat(cand);
        if (p.voice === 'male') cand = cand.filter(v => /\bmale\b|man|david|daniel|alex/i.test(v.name)).concat(cand);
        if (cand[0]) u.voice = cand[0];

        u.onend = u.onerror = () => {
          if (my === this.token) this.speaking = false;
          resolve();
        };

        if (my === this.token) {
          speechSynthesis.speak(u);
        } else {
          resolve();
        }
      } catch {
        if (my === this.token) this.speaking = false;
        resolve();
      }
    });
  }
}

export const recognitionSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);

// Explicitly requests microphone permissions from the browser / device
export async function requestMicrophonePermission() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop tracks to release mic while maintaining permission
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      throw new Error('Microphone permission was denied. Please click the lock icon in the address bar to allow microphone access.');
    }
    return false;
  }
}

// ── MediaRecorder-based fallback (works on plain HTTP on mobile) ────────────
// Records audio for up to maxMs ms, then sends to backend /api/transcribe.
async function listenViaMediaRecorder(bcp47, { onInterim, apiBase = '' } = {}, maxMs = 6000) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    throw new Error('Microphone permission was denied. Please allow microphone access.');
  }

  onInterim?.('🎙️ Recording… speak now');

  return new Promise((resolve, reject) => {
    const chunks = [];
    let mimeType = 'audio/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      if (MediaRecorder.isTypeSupported('audio/ogg')) mimeType = 'audio/ogg';
      else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
      else mimeType = '';
    }

    const opts = mimeType ? { mimeType } : {};
    let rec;
    try {
      rec = new MediaRecorder(stream, opts);
    } catch {
      rec = new MediaRecorder(stream);
      mimeType = rec.mimeType || 'audio/webm';
    }

    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (!chunks.length) return resolve('');

      onInterim?.('⌛ Transcribing…');

      try {
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        const ab = await blob.arrayBuffer();
        const bytes = new Uint8Array(ab);
        // convert to base64
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const b64 = btoa(binary);

        const resp = await fetch((apiBase || '') + '/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: b64, mimeType: mimeType || 'audio/webm', language: bcp47 || 'en-US' }),
        });
        if (!resp.ok) throw new Error(`Server error ${resp.status}`);
        const data = await resp.json();
        const transcript = data?.transcript || '';
        onInterim?.(transcript || '');
        resolve(transcript.trim());
      } catch (e) {
        console.warn('MediaRecorder transcription failed:', e);
        resolve('');
      }
    };

    rec.onerror = () => { stream.getTracks().forEach((t) => t.stop()); resolve(''); };

    rec.start();
    setTimeout(() => { try { rec.stop(); } catch {} }, maxMs);
  });
}

// ── Main listen() — tries Web Speech API first, falls back to MediaRecorder ─
export async function listen(bcp47, { onInterim, apiBase = '' } = {}) {
  // Proactively request / verify device microphone permission
  await requestMicrophonePermission();

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // On mobile HTTP, Web Speech API throws "network" immediately.
  // Detect HTTP + mobile: skip directly to MediaRecorder.
  const isHttp = location.protocol === 'http:';
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!SR || (isHttp && isMobile)) {
    return listenViaMediaRecorder(bcp47, { onInterim, apiBase });
  }

  return new Promise((resolve, reject) => {
    const rec = new SR();
    rec.lang = bcp47 || 'en-US';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    let finalText = '';
    let hasResolved = false;
    let networkFailed = false;

    rec.onresult = (e) => {
      let interim = '';
      for (const r of e.results) {
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      const currentText = finalText || interim;
      onInterim?.(currentText);
    };

    rec.onerror = async (e) => {
      if (hasResolved) return;
      if (e.error === 'no-speech' || e.error === 'aborted') {
        hasResolved = true;
        return resolve('');
      }
      if (e.error === 'network') {
        // Fall back to MediaRecorder → backend transcription
        console.warn('SpeechRecognition: network error — switching to MediaRecorder fallback');
        networkFailed = true;
        hasResolved = true;
        try {
          const t = await listenViaMediaRecorder(bcp47, { onInterim, apiBase });
          resolve(t);
        } catch (err) {
          resolve('');
        }
        return;
      }
      if (e.error === 'not-allowed') {
        hasResolved = true;
        return reject(new Error('Microphone permission was denied. Please allow microphone access in your browser.'));
      }
      hasResolved = true;
      reject(new Error(`Voice input error: ${e.error}`));
    };

    rec.onend = () => {
      if (!hasResolved && !networkFailed) {
        hasResolved = true;
        resolve(finalText.trim());
      }
    };

    try {
      rec.start();
    } catch (e) {
      if (!hasResolved) {
        hasResolved = true;
        resolve('');
      }
    }
  });
}
