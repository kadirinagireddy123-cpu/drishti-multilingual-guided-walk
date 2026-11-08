// Thin client for the Drishti FastAPI backend.
export const FALLBACK_LANGUAGES = [
  { code: 'en', bcp47: 'en-US', name: 'English', native: 'English' },
  { code: 'hi', bcp47: 'hi-IN', name: 'Hindi', native: 'हिन्दी' },
  { code: 'kn', bcp47: 'kn-IN', name: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'te', bcp47: 'te-IN', name: 'Telugu', native: 'తెలుగు' },
  { code: 'ta', bcp47: 'ta-IN', name: 'Tamil', native: 'தமிழ்' },
  { code: 'mr', bcp47: 'mr-IN', name: 'Marathi', native: 'मराठी' },
  { code: 'bn', bcp47: 'bn-IN', name: 'Bengali', native: 'বাংলা' },
  { code: 'gu', bcp47: 'gu-IN', name: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'ml', bcp47: 'ml-IN', name: 'Malayalam', native: 'മലയാളം' },
  { code: 'es', bcp47: 'es-ES', name: 'Spanish', native: 'Español' },
  { code: 'fr', bcp47: 'fr-FR', name: 'French', native: 'Français' },
  { code: 'de', bcp47: 'de-DE', name: 'German', native: 'Deutsch' },
  { code: 'ja', bcp47: 'ja-JP', name: 'Japanese', native: '日本語' },
];
export const FALLBACK_MODES = [
  { id: 'safety', title: 'Safety', description: 'Obstacles, stairs, drop-offs and a clear-path check.' },
  { id: 'read', title: 'Read text', description: 'Signs, labels, medicine and menus.' },
  { id: 'currency', title: 'Currency', description: 'Identify banknote denominations.' },
  { id: 'all', title: 'Everything', description: 'Obstacles, text and currency together.' },
];

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export class Api {
  constructor(getBase) { this.getBase = getBase; }

  async #req(path, { method = 'GET', body, signal, timeout = 45000 } = {}) {
    const base = (this.getBase() || '').replace(/\/+$/, '');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new ApiError(signal?.aborted ? 'Cancelled' : 'The request timed out', 0);
      throw new ApiError(`Cannot reach the Drishti server at ${base || 'this origin'}`, 0);
    } finally { clearTimeout(timer); }

    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      let msg = data?.detail ?? data?.error ?? `Server error (${res.status})`;
      if (Array.isArray(msg)) msg = msg.map(m => m.msg || JSON.stringify(m)).join('; ');
      throw new ApiError(String(msg), res.status);
    }
    return data;
  }

  health() { return this.#req('/api/health', { timeout: 6000 }); }
  languages() { return this.#req('/api/languages', { timeout: 6000 }); }
  modes() { return this.#req('/api/modes', { timeout: 6000 }); }
  vision({ image, mode, language, userPrompt }, signal) {
    return this.#req('/api/vision-assist', { method: 'POST', body: { image, mode, language, userPrompt: userPrompt || '' }, signal });
  }
  chat({ message, history, language, image }, signal) {
    const body = { message, history, language };
    if (image) body.image = image;
    return this.#req('/api/chat', { method: 'POST', body, signal });
  }
  tts({ text, language, voice }) {
    return this.#req('/api/tts', { method: 'POST', body: { text, language, voice }, timeout: 8000 });
  }
  transcribe({ audio, mimeType, language }) {
    return this.#req('/api/transcribe', { method: 'POST', body: { audio, mimeType, language }, timeout: 15000 });
  }
}
