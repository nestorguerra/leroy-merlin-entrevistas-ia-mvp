function waitForIceGathering(peerConnection, timeoutMs = 2500) {
  if (peerConnection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs);
    function done() {
      window.clearTimeout(timeout);
      peerConnection.removeEventListener("icegatheringstatechange", handleChange);
      resolve();
    }
    function handleChange() {
      if (peerConnection.iceGatheringState === "complete") done();
    }
    peerConnection.addEventListener("icegatheringstatechange", handleChange);
  });
}

function waitForDataChannel(dataChannel, timeoutMs = 12000) {
  if (dataChannel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("La conexión de voz ha tardado demasiado en abrirse."));
    }, timeoutMs);
    function cleanup() {
      window.clearTimeout(timeout);
      dataChannel.removeEventListener("open", handleOpen);
      dataChannel.removeEventListener("error", handleError);
    }
    function handleOpen() {
      cleanup();
      resolve();
    }
    function handleError() {
      cleanup();
      reject(new Error("No se ha podido abrir el canal de la entrevista."));
    }
    dataChannel.addEventListener("open", handleOpen);
    dataChannel.addEventListener("error", handleError);
  });
}

async function readApiError(response, fallback) {
  try {
    const payload = await response.json();
    return payload?.error?.message || (typeof payload?.error === "string" ? payload.error : fallback);
  } catch {
    return fallback;
  }
}

export class RealtimeInterview {
  constructor({
    model = "gpt-realtime-2.1",
    voice = "marin",
    audioElement,
    onEvent = () => {},
    onConnectionState = () => {},
    onRemoteAnalyser = () => {},
    onInputAnalyser = () => {},
  } = {}) {
    this.model = model;
    this.voice = voice;
    this.audioElement = audioElement;
    this.onEvent = onEvent;
    this.onConnectionState = onConnectionState;
    this.onRemoteAnalyser = onRemoteAnalyser;
    this.onInputAnalyser = onInputAnalyser;
    this.peerConnection = null;
    this.dataChannel = null;
    this.microphoneStream = null;
    this.audioContext = null;
    this.sessionUpdateWaiters = [];
    this.closed = false;
  }

  async connect() {
    this.closed = false;
    this.onConnectionState("requesting_microphone");
    this.microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    this.peerConnection = new RTCPeerConnection();
    this.dataChannel = this.peerConnection.createDataChannel("oai-events");
    this.dataChannel.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed?.type === "session.updated") {
          this.resolveNextSessionUpdate();
        } else if (parsed?.type === "error" && this.sessionUpdateWaiters.length) {
          this.rejectNextSessionUpdate(
            new Error(parsed.error?.message || "OpenAI no ha aceptado la configuración de voz."),
          );
        }
        this.onEvent(parsed);
      } catch {
        this.onEvent({ type: "client.parse_error", raw: String(event.data).slice(0, 500) });
      }
    });

    this.peerConnection.addEventListener("connectionstatechange", () => {
      const state = this.peerConnection?.connectionState || "closed";
      this.onConnectionState(state);
    });

    this.peerConnection.addEventListener("track", async (event) => {
      const stream = event.streams[0];
      if (!stream) return;
      if (this.audioElement) {
        this.audioElement.srcObject = stream;
        await this.audioElement.play().catch(() => {});
      }
      this.setupRemoteAnalyser(stream);
    });

    for (const track of this.microphoneStream.getTracks()) {
      this.peerConnection.addTrack(track, this.microphoneStream);
    }
    this.setupInputAnalyser(this.microphoneStream);

    this.onConnectionState("creating_session");
    const secretResponse = await fetch("/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, voice: this.voice }),
    });
    if (!secretResponse.ok) {
      throw new Error(
        await readApiError(secretResponse, "No se ha podido crear la sesión de OpenAI."),
      );
    }
    const secret = await secretResponse.json();

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    await waitForIceGathering(this.peerConnection);
    const localSdp = this.peerConnection.localDescription?.sdp;
    if (!localSdp) throw new Error("El navegador no ha generado una oferta de audio válida.");

    this.onConnectionState("connecting");
    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret.value}`,
        "Content-Type": "application/sdp",
      },
      body: localSdp,
    });
    if (!sdpResponse.ok) {
      throw new Error(
        await readApiError(sdpResponse, `OpenAI no ha aceptado la conexión (${sdpResponse.status}).`),
      );
    }
    const answerSdp = await sdpResponse.text();
    await this.peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });
    await waitForDataChannel(this.dataChannel);
    this.onConnectionState("connected");
    return this;
  }

  setupInputAnalyser(stream) {
    try {
      this.ensureAudioContext();
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;
      this.audioContext.createMediaStreamSource(stream).connect(analyser);
      this.onInputAnalyser(analyser);
    } catch {
      this.onInputAnalyser(null);
    }
  }

  setupRemoteAnalyser(stream) {
    try {
      this.ensureAudioContext();
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.78;
      this.audioContext.createMediaStreamSource(stream).connect(analyser);
      this.onRemoteAnalyser(analyser);
    } catch {
      this.onRemoteAnalyser(null);
    }
  }

  ensureAudioContext() {
    if (!this.audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("El navegador no permite analizar el audio.");
      this.audioContext = new AudioContextClass();
    }
    if (this.audioContext.state === "suspended") this.audioContext.resume().catch(() => {});
  }

  configure({ instructions }, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timeout: window.setTimeout(() => {
          this.removeSessionUpdateWaiter(waiter);
          reject(new Error("OpenAI ha tardado demasiado en confirmar la configuración de voz."));
        }, timeoutMs),
      };
      this.sessionUpdateWaiters.push(waiter);
      try {
        this.send({
          type: "session.update",
          session: {
            type: "realtime",
            instructions,
            output_modalities: ["audio"],
            audio: {
              input: {
                noise_reduction: { type: "near_field" },
                transcription: {
                  model: "gpt-4o-transcribe",
                  language: "es",
                },
                turn_detection: {
                  type: "semantic_vad",
                  eagerness: "low",
                  create_response: false,
                  interrupt_response: true,
                },
              },
              output: {
                voice: this.voice,
                speed: 1,
              },
            },
            reasoning: { effort: "minimal" },
          },
        });
      } catch (error) {
        this.removeSessionUpdateWaiter(waiter);
        reject(error);
      }
    });
  }

  removeSessionUpdateWaiter(waiter) {
    const index = this.sessionUpdateWaiters.indexOf(waiter);
    if (index >= 0) this.sessionUpdateWaiters.splice(index, 1);
    window.clearTimeout(waiter.timeout);
  }

  resolveNextSessionUpdate() {
    const waiter = this.sessionUpdateWaiters.shift();
    if (!waiter) return;
    window.clearTimeout(waiter.timeout);
    waiter.resolve();
  }

  rejectNextSessionUpdate(error) {
    const waiter = this.sessionUpdateWaiters.shift();
    if (!waiter) return;
    window.clearTimeout(waiter.timeout);
    waiter.reject(error);
  }

  createResponse({ instructions, questionId, kind = "question" }) {
    this.send({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions,
        metadata: {
          question_id: questionId || "",
          interview_event: kind,
        },
      },
    });
  }

  cancelResponse() {
    if (this.dataChannel?.readyState === "open") {
      this.send({ type: "response.cancel" });
    }
  }

  send(event) {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("La conexión de voz todavía no está lista.");
    }
    this.dataChannel.send(JSON.stringify(event));
  }

  setMuted(muted) {
    for (const track of this.microphoneStream?.getAudioTracks() || []) {
      track.enabled = !muted;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.sessionUpdateWaiters.splice(0)) {
      window.clearTimeout(waiter.timeout);
      waiter.reject(new Error("La sesión de voz se ha cerrado antes de confirmar su configuración."));
    }
    try {
      this.cancelResponse();
    } catch {
      // La sesión puede haberse cerrado ya.
    }
    for (const track of this.microphoneStream?.getTracks() || []) track.stop();
    this.dataChannel?.close();
    this.peerConnection?.close();
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
    }
    if (this.audioContext && this.audioContext.state !== "closed") {
      await this.audioContext.close().catch(() => {});
    }
    this.peerConnection = null;
    this.dataChannel = null;
    this.microphoneStream = null;
    this.onInputAnalyser(null);
    this.onRemoteAnalyser(null);
    this.onConnectionState("closed");
  }
}
