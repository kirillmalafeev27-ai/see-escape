const DEFAULT_LANG = "ru-RU";
const QUEUE_LIMIT = 10;

const SPOKEN_REPLACEMENTS = [
  [/\bWASD\b/g, "W A S D"],
  [/\bW\/S\b/g, "W и S"],
  [/\bA\/D\b/g, "A и D"],
  [/\bE\b/g, "E"],
  [/\bF\b/g, "F"],
  [/\bG\b/g, "G"],
  [/ЛКМ/g, "левая кнопка мыши"],
  [/·/g, ". "],
  [/—/g, ". "],
  [/\[[^\]]+\]/g, ""],
  [/\s+/g, " "],
];

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function normalizeId(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function toSpeechText(text) {
  let value = String(text || "").replace(/<[^>]*>/g, " ");
  for (const [from, to] of SPOKEN_REPLACEMENTS) value = value.replace(from, to);
  return value.trim();
}

export class AudioGuide {
  constructor({ button = null, lang = DEFAULT_LANG } = {}) {
    this.button = button;
    this.lang = lang;
    this.enabled = true;
    this.activated = false;
    this.supported = typeof window !== "undefined" && "fetch" in window && "Audio" in window;
    this.queue = [];
    this.lastTimes = new Map();
    this.spokenIds = new Set();
    this.lastPrompt = "";
    this.speaking = false;
    this.voice = null;
    this.audioCache = new Map();
    this.currentAudio = null;
    this.currentObjectUrl = "";

    this._pickVoice();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      if (window.speechSynthesis.addEventListener) {
        window.speechSynthesis.addEventListener("voiceschanged", () => this._pickVoice());
      } else if ("onvoiceschanged" in window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = () => this._pickVoice();
      }
    }
    this._bindButton();
    this._bindActivation();
    this._renderButton();
  }

  _bindButton() {
    if (!this.button) return;
    this.button.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!this.supported) return;
      this.activated = true;
      this.enabled = !this.enabled;
      if (!this.enabled) {
        this._stopCurrentAudio();
        window.speechSynthesis?.cancel?.();
        this.queue.length = 0;
        this.speaking = false;
      } else {
        this.say("Голосовые подсказки включены.", {
          id: "audio-enabled",
          priority: 3,
          interrupt: true,
        });
      }
      this._renderButton();
    });
  }

  _bindActivation() {
    if (!this.supported || typeof window === "undefined") return;
    const activate = () => {
      if (this.activated) return;
      this.activated = true;
      this._speakNext();
      this._renderButton();
    };
    window.addEventListener("pointerdown", activate, { once: true, capture: true });
    window.addEventListener("keydown", activate, { once: true, capture: true });
    window.addEventListener("touchstart", activate, { once: true, capture: true });
  }

  _renderButton() {
    if (!this.button) return;
    if (!this.supported) {
      this.button.textContent = "Голос недоступен";
      this.button.disabled = true;
      this.button.setAttribute("aria-pressed", "false");
      return;
    }
    this.button.disabled = false;
    this.button.textContent = this.enabled ? "Голос: вкл" : "Голос: выкл";
    this.button.setAttribute("aria-pressed", this.enabled ? "true" : "false");
    this.button.title = this.activated
      ? "Включить или выключить голосовые подсказки"
      : "Кликни или нажми клавишу, чтобы браузер разрешил голос";
  }

  _pickVoice() {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const voices = window.speechSynthesis?.getVoices?.() || [];
    this.voice =
      voices.find((voice) => voice.lang === this.lang && /female|milena|alana|oksana|google/i.test(voice.name)) ||
      voices.find((voice) => voice.lang === this.lang) ||
      voices.find((voice) => voice.lang?.startsWith("ru")) ||
      null;
  }

  introduce(lines) {
    for (const [index, line] of lines.entries()) {
      this.say(line, {
        id: `intro-${index}`,
        priority: 2,
        cooldown: 60_000,
      });
    }
  }

  event(text, options = {}) {
    this.say(text, {
      priority: 2,
      cooldown: 1200,
      ...options,
    });
  }

  instruction(text, options = {}) {
    this.say(text, {
      priority: 1,
      cooldown: 8000,
      ...options,
    });
  }

  prompt(text) {
    const clean = toSpeechText(text);
    if (!clean || clean === this.lastPrompt) return;
    this.lastPrompt = clean;
    this.instruction(`Подсказка: ${clean}`, {
      id: `prompt:${normalizeId(clean)}`,
      cooldown: 9000,
    });
  }

  status(key, text, options = {}) {
    this.say(text, {
      id: `status:${key}`,
      priority: 1,
      cooldown: 12_000,
      ...options,
    });
  }

  say(text, options = {}) {
    if (!this.supported || !this.enabled) return false;
    const speechText = toSpeechText(text);
    if (!speechText) return false;

    const id = options.id || normalizeId(speechText);
    const once = options.once ?? true;
    if (once && this.spokenIds.has(id)) return false;

    const t = now();
    const cooldown = options.cooldown ?? 0;
    const last = this.lastTimes.get(id) || 0;
    if (cooldown && t - last < cooldown) return false;
    if (this.queue.some((item) => item.id === id)) return false;
    this.lastTimes.set(id, t);
    if (once) this.spokenIds.add(id);

    const item = {
      id,
      text: speechText,
      priority: options.priority ?? 1,
      rate: options.rate ?? 0.98,
      pitch: options.pitch ?? 1,
      volume: options.volume ?? 1,
    };

    if (options.interrupt) {
      this.queue.length = 0;
      this._stopCurrentAudio();
      window.speechSynthesis?.cancel?.();
      this.speaking = false;
    } else if (item.priority >= 2) {
      this.queue = this.queue.filter((queued) => queued.priority >= 1);
    }

    this.queue.push(item);
    this.queue.sort((a, b) => b.priority - a.priority);
    if (this.queue.length > QUEUE_LIMIT) {
      this.queue.splice(QUEUE_LIMIT);
    }
    this._speakNext();
    return true;
  }

  _stopCurrentAudio() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = "";
      this.currentAudio = null;
    }
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = "";
    }
  }

  async _ttsBuffer(text) {
    const key = String(text);
    const cached = this.audioCache.get(key);
    if (cached) return cached;

    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);

    const entry = {
      buffer: await response.arrayBuffer(),
      contentType: response.headers.get("content-type") || "audio/mpeg",
    };
    this.audioCache.set(key, entry);
    return entry;
  }

  _fallbackSpeech(item) {
    if (typeof window === "undefined" || !("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      return false;
    }
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.lang = this.lang;
    utterance.rate = item.rate;
    utterance.pitch = item.pitch;
    utterance.volume = item.volume;
    if (this.voice) utterance.voice = this.voice;
    utterance.onend = () => {
      this.speaking = false;
      window.setTimeout(() => this._speakNext(), 80);
    };
    utterance.onerror = () => {
      this.speaking = false;
      window.setTimeout(() => this._speakNext(), 120);
    };
    window.speechSynthesis.resume?.();
    window.speechSynthesis.speak(utterance);
    return true;
  }

  _speakNext() {
    if (!this.supported || !this.enabled || !this.activated || this.speaking) return;
    const item = this.queue.shift();
    if (!item) return;

    this.speaking = true;
    this._ttsBuffer(item.text)
      .then(({ buffer, contentType }) => {
        if (!this.enabled) {
          this.speaking = false;
          return;
        }
        this._stopCurrentAudio();
        const blob = new Blob([buffer.slice(0)], { type: contentType });
        this.currentObjectUrl = URL.createObjectURL(blob);
        const audio = new Audio(this.currentObjectUrl);
        this.currentAudio = audio;
        audio.volume = item.volume;
        audio.onended = () => {
          this._stopCurrentAudio();
          this.speaking = false;
          window.setTimeout(() => this._speakNext(), 80);
        };
        audio.onerror = () => {
          this._stopCurrentAudio();
          if (!this._fallbackSpeech(item)) {
            this.speaking = false;
            window.setTimeout(() => this._speakNext(), 120);
          }
        };
        return audio.play();
      })
      .catch(() => {
        this._stopCurrentAudio();
        if (!this._fallbackSpeech(item)) {
          this.speaking = false;
          window.setTimeout(() => this._speakNext(), 120);
        }
      });
  }
}
