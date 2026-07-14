const DEFAULT_MANIFEST_URL = "./audio/openai-marin-v1/manifest.json";

function clipKey(kind, questionIndex) {
  if (kind === "intro") return "intro";
  if (kind === "closing") return "closing";
  const safeIndex = Math.max(0, Number(questionIndex) || 0);
  return `question-${String(safeIndex + 1).padStart(2, "0")}`;
}

function isSafeAudioPath(path) {
  return /^\.\/audio\/openai-marin-v1\/[a-z0-9-]+\/(?:intro|closing|question-\d{2})\.mp3$/.test(
    String(path || ""),
  );
}

export class StaticVoicePlayer {
  constructor(
    audioElement,
    { manifestUrl = DEFAULT_MANIFEST_URL, onAnalyser = () => {} } = {},
  ) {
    this.audioElement = audioElement;
    this.manifestUrl = manifestUrl;
    this.onAnalyser = onAnalyser;
    this.manifest = null;
    this.audioContext = null;
    this.analyser = null;
    this.mediaSource = null;
    this.playbackToken = 0;
    this.primePromise = Promise.resolve(false);
    this.pendingPlayback = null;
  }

  async load() {
    const response = await fetch(this.manifestUrl, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error("No se ha podido cargar la voz OpenAI Marin.");
    }
    const manifest = await response.json();
    if (
      manifest?.schemaVersion !== 1 ||
      manifest?.model !== "gpt-4o-mini-tts" ||
      manifest?.voice !== "marin" ||
      !manifest?.profiles
    ) {
      throw new Error("La configuración de la voz publicada no es válida.");
    }
    this.manifest = manifest;
    return manifest;
  }

  get metadata() {
    if (!this.manifest) return null;
    return {
      model: this.manifest.model,
      voice: this.manifest.voice,
      disclosure: this.manifest.disclosure,
    };
  }

  getClip(profileId, { kind = "question", questionIndex = 0 } = {}) {
    const key = clipKey(kind, questionIndex);
    const clip = this.manifest?.profiles?.[profileId]?.clips?.[key];
    if (!clip || !isSafeAudioPath(clip.path)) return null;
    return { ...clip, key };
  }

  hasClip(profileId, options = {}) {
    return Boolean(this.getClip(profileId, options));
  }

  ensureAudioGraph() {
    if (this.analyser) {
      this.onAnalyser(this.analyser);
      return this.analyser;
    }
    if (!this.audioElement) return null;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      this.audioContext = new AudioContextClass();
      this.mediaSource = this.audioContext.createMediaElementSource(this.audioElement);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.78;
      this.mediaSource.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
      this.onAnalyser(this.analyser);
      return this.analyser;
    } catch {
      this.onAnalyser(null);
      return null;
    }
  }

  resumeAudioContext() {
    this.ensureAudioGraph();
    if (this.audioContext?.state === "suspended") {
      return this.audioContext.resume().catch(() => {});
    }
    return Promise.resolve();
  }

  prime(profileId, options = { kind: "intro", questionIndex: 0 }) {
    const clip = this.getClip(profileId, options);
    if (!clip || !this.audioElement) return Promise.resolve(false);
    this.ensureAudioGraph();
    const audioUrl = new URL(clip.path, window.location.href).href;
    this.audioElement.srcObject = null;
    this.audioElement.src = audioUrl;
    this.audioElement.preload = "auto";
    this.audioElement.muted = true;
    this.audioElement.load();
    this.primePromise = Promise.all([
      this.resumeAudioContext(),
      this.audioElement.play(),
    ])
      .then(() => {
        this.audioElement.pause();
        this.audioElement.currentTime = 0;
        this.audioElement.muted = false;
        return true;
      })
      .catch(() => {
        this.audioElement.muted = false;
        return false;
      });
    return this.primePromise;
  }

  async play(profileId, options = {}) {
    const clip = this.getClip(profileId, options);
    if (!clip) {
      const error = new Error("Este perfil no tiene una voz OpenAI publicada.");
      error.code = "VOICE_CLIP_UNAVAILABLE";
      throw error;
    }
    if (!this.audioElement) throw new Error("El reproductor de voz no está disponible.");

    const token = ++this.playbackToken;
    await this.primePromise.catch(() => {});
    if (token !== this.playbackToken) return false;
    await this.resumeAudioContext();

    const audioUrl = new URL(clip.path, window.location.href).href;
    this.audioElement.srcObject = null;
    this.audioElement.muted = false;
    if (this.audioElement.src !== audioUrl) {
      this.audioElement.src = audioUrl;
      this.audioElement.load();
    } else {
      this.audioElement.currentTime = 0;
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.audioElement.removeEventListener("ended", handleEnded);
        this.audioElement.removeEventListener("error", handleError);
        if (this.pendingPlayback?.token === token) this.pendingPlayback = null;
      };
      const handleEnded = () => {
        cleanup();
        resolve(true);
      };
      const handleError = () => {
        cleanup();
        reject(new Error("No se ha podido reproducir la voz OpenAI Marin."));
      };
      this.audioElement.addEventListener("ended", handleEnded, { once: true });
      this.audioElement.addEventListener("error", handleError, { once: true });
      this.pendingPlayback = { token, resolve, cleanup };
      this.audioElement.play().catch((error) => {
        cleanup();
        reject(
          new Error(
            error?.name === "NotAllowedError"
              ? "El navegador ha bloqueado el audio. Toca «Repetir pregunta» para escucharlo."
              : "No se ha podido reproducir la voz OpenAI Marin.",
          ),
        );
      });
    });
  }

  stop() {
    this.playbackToken += 1;
    if (this.pendingPlayback) {
      const { resolve, cleanup } = this.pendingPlayback;
      cleanup();
      resolve(false);
    }
    if (!this.audioElement) return;
    this.audioElement.pause();
    this.audioElement.muted = false;
    try {
      this.audioElement.currentTime = 0;
    } catch {
      // El medio puede no haber cargado todavía.
    }
  }
}
