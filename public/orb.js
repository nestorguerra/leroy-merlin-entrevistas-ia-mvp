const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function roundedBlobPath(points) {
  const path = new Path2D();
  if (!points.length) return path;
  const firstMidpoint = {
    x: (points[0].x + points.at(-1).x) / 2,
    y: (points[0].y + points.at(-1).y) / 2,
  };
  path.moveTo(firstMidpoint.x, firstMidpoint.y);
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    const midpoint = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
    path.quadraticCurveTo(point.x, point.y, midpoint.x, midpoint.y);
  }
  path.closePath();
  return path;
}

export class FluidPresence {
  constructor(canvas, { theme = "light", seed = 1 } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: true });
    this.theme = theme;
    this.seed = seed;
    this.state = "idle";
    this.energy = 0.08;
    this.targetEnergy = 0.08;
    this.analyser = null;
    this.audioData = null;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.running = true;
    this.startedAt = performance.now();
    this.particles = Array.from({ length: 32 }, (_, index) => ({
      angle: (index / 32) * TAU + Math.sin(index * 7.31) * 0.3,
      radius: 0.7 + ((index * 17) % 13) / 16,
      speed: 0.05 + ((index * 11) % 9) / 130,
      size: 0.65 + ((index * 23) % 7) / 7,
      alpha: 0.18 + ((index * 19) % 11) / 34,
    }));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    const pixelWidth = Math.max(1, Math.round(rect.width * this.dpr));
    const pixelHeight = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
  }

  setState(state) {
    this.state = state;
    const stateEnergy = {
      idle: 0.07,
      connecting: 0.16,
      thinking: 0.2,
      listening: 0.28,
      speaking: 0.44,
      completed: 0.12,
      error: 0.06,
    };
    this.targetEnergy = stateEnergy[state] ?? 0.1;
  }

  setAnalyser(analyser) {
    this.analyser = analyser || null;
    this.audioData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  }

  setExternalEnergy(value) {
    this.targetEnergy = clamp(Number(value) || 0, 0, 1);
  }

  sampleAudio() {
    if (!this.analyser || !this.audioData) return null;
    this.analyser.getByteFrequencyData(this.audioData);
    let sum = 0;
    const upper = Math.min(this.audioData.length, 90);
    for (let index = 2; index < upper; index += 1) {
      const weighted = this.audioData[index] / 255;
      sum += weighted * weighted;
    }
    return clamp(Math.sqrt(sum / Math.max(1, upper - 2)) * 1.9, 0, 1);
  }

  frame(timestamp) {
    if (!this.running) return;
    const audioEnergy = this.sampleAudio();
    const baseTarget = audioEnergy === null ? this.targetEnergy : Math.max(this.targetEnergy * 0.4, audioEnergy);
    this.energy = lerp(this.energy, baseTarget, audioEnergy === null ? 0.045 : 0.16);
    this.draw((timestamp - this.startedAt) / 1000);
    requestAnimationFrame(this.frame);
  }

  draw(time) {
    const ctx = this.context;
    if (!ctx || !this.width || !this.height) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const centerX = this.width * 0.5;
    const centerY = this.height * (this.theme === "dark" ? 0.43 : 0.5);
    const baseRadius = Math.min(this.width, this.height) * (this.theme === "dark" ? 0.22 : 0.34);
    const pulse = Math.sin(time * 1.55) * 0.5 + 0.5;
    const movement = 0.035 + this.energy * 0.16;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    const haloRadius = baseRadius * (this.theme === "dark" ? 2.25 : 1.48);
    const halo = ctx.createRadialGradient(
      centerX,
      centerY,
      baseRadius * 0.08,
      centerX,
      centerY,
      haloRadius,
    );
    if (this.theme === "dark") {
      halo.addColorStop(0, `rgba(197, 227, 158, ${0.16 + this.energy * 0.18})`);
      halo.addColorStop(0.32, `rgba(120, 190, 32, ${0.11 + this.energy * 0.12})`);
      halo.addColorStop(1, "rgba(24, 136, 3, 0)");
    } else {
      halo.addColorStop(0, `rgba(120, 190, 32, ${0.16 + this.energy * 0.13})`);
      halo.addColorStop(0.45, `rgba(70, 166, 16, ${0.07 + this.energy * 0.08})`);
      halo.addColorStop(1, "rgba(24, 136, 3, 0)");
    }
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(centerX, centerY, haloRadius, 0, TAU);
    ctx.fill();

    const layers = [
      { scale: 1.13, speed: 0.32, alpha: 0.15, hue: "24, 136, 3", offset: 0.7 },
      { scale: 1.0, speed: -0.43, alpha: 0.24, hue: "120, 190, 32", offset: 2.2 },
      { scale: 0.83, speed: 0.57, alpha: 0.28, hue: "197, 227, 158", offset: 4.1 },
      { scale: 0.61, speed: -0.69, alpha: 0.22, hue: "255, 255, 255", offset: 5.7 },
    ];

    for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
      const layer = layers[layerIndex];
      const points = [];
      const pointCount = 84;
      for (let index = 0; index < pointCount; index += 1) {
        const angle = (index / pointCount) * TAU;
        const waveA = Math.sin(angle * 3 + time * layer.speed * 2.2 + layer.offset);
        const waveB = Math.sin(angle * 5 - time * layer.speed * 1.45 + layer.offset * 0.7);
        const waveC = Math.cos(angle * 2 + time * 0.31 + this.seed);
        const audioRipple = Math.sin(angle * 7 - time * 2.8) * this.energy;
        const radius =
          baseRadius *
          layer.scale *
          (1 + waveA * movement + waveB * movement * 0.48 + waveC * 0.018 + audioRipple * 0.08);
        const squeeze = 0.94 + Math.sin(time * 0.41 + layerIndex) * 0.025;
        points.push({
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius * squeeze,
        });
      }

      const path = roundedBlobPath(points);
      const gradient = ctx.createRadialGradient(
        centerX - baseRadius * 0.28,
        centerY - baseRadius * 0.32,
        baseRadius * 0.05,
        centerX,
        centerY,
        baseRadius * layer.scale * 1.1,
      );
      const alpha = layer.alpha + this.energy * 0.11;
      gradient.addColorStop(0, `rgba(${layer.hue}, ${Math.min(0.68, alpha + 0.22)})`);
      gradient.addColorStop(0.52, `rgba(${layer.hue}, ${alpha})`);
      gradient.addColorStop(1, `rgba(${layer.hue}, 0.015)`);
      ctx.fillStyle = gradient;
      ctx.fill(path);
      ctx.strokeStyle = `rgba(${layer.hue}, ${Math.min(0.48, alpha + 0.08)})`;
      ctx.lineWidth = this.theme === "dark" ? 0.75 : 0.6;
      ctx.stroke(path);
    }

    const core = ctx.createRadialGradient(
      centerX - baseRadius * 0.2,
      centerY - baseRadius * 0.22,
      0,
      centerX,
      centerY,
      baseRadius * 0.65,
    );
    core.addColorStop(0, `rgba(255,255,255,${0.76 + pulse * 0.08})`);
    core.addColorStop(0.28, `rgba(197,227,158,${0.42 + this.energy * 0.2})`);
    core.addColorStop(1, "rgba(120,190,32,0)");
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(centerX, centerY, baseRadius * 0.68, 0, TAU);
    ctx.fill();

    for (const particle of this.particles) {
      const angle = particle.angle + time * particle.speed;
      const drift = Math.sin(time * 0.6 + particle.angle * 4) * 0.07;
      const radius = baseRadius * (particle.radius + drift + this.energy * 0.12);
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius * 0.93;
      const size = particle.size * (0.7 + this.energy * 1.1);
      ctx.fillStyle = `rgba(${this.theme === "dark" ? "197,227,158" : "24,136,3"},${
        particle.alpha * (0.45 + this.energy)
      })`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  destroy() {
    this.running = false;
    this.resizeObserver.disconnect();
  }
}
