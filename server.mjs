import http from "node:http";
import { createReadStream, existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = join(ROOT, "data");
const INTERVIEWS_DIR = join(DATA_DIR, "interviews");
const INTERVIEWEES_FILE = join(DATA_DIR, "interviewees.json");
const TEMPLATE_FILE = join(DATA_DIR, "interviewees.template.json");
const ENV_FILE = join(ROOT, ".env.local");

// Este MVP maneja credenciales y transcripciones: nunca se expone a la red local.
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4177);
const DEFAULT_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-1.5";
const DEFAULT_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";
// Modelo de texto para generar guías de entrevista, repreguntas y síntesis de procesos.
const DEFAULT_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-5.1";
// Transcripción en servidor para el modo asíncrono (pregunta en texto, respuesta por voz).
const DEFAULT_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TRANSCRIBE_PROMPT =
  process.env.OPENAI_TRANSCRIBE_PROMPT ||
  "Entrevista interna de Leroy Merlin España sobre procesos de marketing. Términos habituales: opecom, OPECOM, PAC, PGC, ALV, HG, hoja de gestión, Com360, COPIL, COPILES, Club, mundos, orquestador, Booster, Gira, Jira, Livia, CDP, Dameo, WLL, LYSE, RCO, toolkit, fast pass, MIM, CEXP, 1P, 3P, ADEO, BigQuery, Colab, Power BI, Looker Studio, UTM, retail media, venta flash, marketplace.";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const ALLOWED_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);
const ALLOWED_MODELS = new Set(["gpt-realtime-1.5", "gpt-realtime-2.1"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

let runtimeApiKey = process.env.OPENAI_API_KEY?.trim() || "";
const interviewWriteQueues = new Map();

await mkdir(INTERVIEWS_DIR, { recursive: true });
await loadLocalEnvironment();

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "microphone=(self)");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.openai.com; media-src 'self' blob:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  setSecurityHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  setSecurityHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      const error = new Error("El contenido supera el máximo permitido.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("El JSON recibido no es válido.");
    error.statusCode = 400;
    throw error;
  }
}

function isLoopback(req) {
  const address = req.socket.remoteAddress || "";
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function requireLoopback(req, res) {
  if (isLoopback(req)) return true;
  sendJson(res, 403, {
    error: "Esta acción de configuración solo está disponible desde este ordenador.",
  });
  return false;
}

function hasAllowedHost(req) {
  const host = String(req.headers.host || "").trim();
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(host);
}

function hasAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.host.toLowerCase() === String(req.headers.host || "").toLowerCase()
    );
  } catch {
    return false;
  }
}

function cleanString(value, maxLength = 500) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function slugify(value) {
  return cleanString(value, 80)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function validateInterviewees(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw validationError("El archivo debe contener entre 1 y 100 personas.");
  }

  const ids = new Set();
  return value.map((raw, index) => {
    const name = cleanString(raw?.name, 80);
    const fullName = cleanString(raw?.fullName, 120) || name;
    const role = cleanString(raw?.role, 160);
    const area = cleanString(raw?.area, 80);
    const context = cleanString(raw?.context, 1200);
    const id = slugify(raw?.id || fullName || `persona-${index + 1}`);
    const durationMinutes = Math.max(15, Math.min(30, Number(raw?.durationMinutes) || 20));
    const questions = Array.isArray(raw?.questions)
      ? raw.questions.map((question) => cleanString(question, 800)).filter(Boolean)
      : [];

    if (!name || !role || !id) {
      throw validationError(`Faltan nombre, cargo o id en la persona ${index + 1}.`);
    }
    if (ids.has(id)) {
      throw validationError(`El id “${id}” está repetido.`);
    }
    if (questions.length < 12 || questions.length > 15) {
      throw validationError(
        `${fullName} debe tener entre 12 y 15 preguntas; ahora tiene ${questions.length}.`,
      );
    }
    ids.add(id);
    return {
      id,
      name,
      fullName,
      role,
      area,
      durationMinutes,
      isDemo: Boolean(raw?.isDemo),
      context,
      questions,
    };
  });
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

async function writeFileAtomic(targetPath, content, options = "utf8") {
  const temporary = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, options);
  await rename(temporary, targetPath);
}

async function loadLocalEnvironment() {
  if (!existsSync(ENV_FILE)) return;
  const content = await readFile(ENV_FILE, "utf8");
  const values = parseEnv(content);
  if (!runtimeApiKey && values.OPENAI_API_KEY) {
    runtimeApiKey = values.OPENAI_API_KEY;
  }
}

function parseEnv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function persistApiKey(apiKey) {
  let current = "";
  if (existsSync(ENV_FILE)) current = await readFile(ENV_FILE, "utf8");

  const safeLine = `OPENAI_API_KEY=${apiKey}`;
  const pattern = /^\s*OPENAI_API_KEY\s*=.*$/m;
  const updated = pattern.test(current)
    ? current.replace(pattern, safeLine)
    : `${current.trimEnd()}${current.trim() ? "\n" : ""}${safeLine}\n`;

  const temporary = `${ENV_FILE}.${randomUUID()}.tmp`;
  await writeFile(temporary, updated, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, ENV_FILE);
  await chmod(ENV_FILE, 0o600);
  runtimeApiKey = apiKey;
}

async function createRealtimeClientSecret({ model, voice }) {
  if (!runtimeApiKey) {
    const error = new Error("Configura primero la clave de OpenAI en Ajustes.");
    error.statusCode = 409;
    throw error;
  }

  const selectedModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
  const selectedVoice = ALLOWED_VOICES.has(voice) ? voice : DEFAULT_VOICE;
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtimeApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        type: "realtime",
        model: selectedModel,
        audio: { output: { voice: selectedVoice } },
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      cleanString(payload?.error?.message, 500) ||
        `OpenAI ha respondido con el código ${response.status}.`,
    );
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }
  if (!payload?.value) {
    const error = new Error("OpenAI no ha devuelto una credencial temporal válida.");
    error.statusCode = 502;
    throw error;
  }

  return {
    value: payload.value,
    expiresAt: payload.expires_at,
    model: selectedModel,
    voice: selectedVoice,
  };
}

function sanitizeTranscriptEntry(entry, index) {
  const speaker = ["interviewer", "participant", "system"].includes(entry?.speaker)
    ? entry.speaker
    : "participant";
  return {
    id: cleanString(entry?.id, 100) || `entry-${index + 1}`,
    itemId: cleanString(entry?.itemId, 160),
    speaker,
    text: cleanString(entry?.text, 20000),
    questionIndex: Number.isInteger(entry?.questionIndex) ? entry.questionIndex : null,
    partial: Boolean(entry?.partial),
    draft: Boolean(entry?.draft),
    segmentOrder: Number.isInteger(entry?.segmentOrder) ? entry.segmentOrder : null,
    createdAt: cleanString(entry?.createdAt, 50) || new Date().toISOString(),
  };
}

function sanitizeInterviewRecord(body) {
  const participant = body?.participant || {};
  const transcript = Array.isArray(body?.transcript)
    ? body.transcript.map(sanitizeTranscriptEntry).filter((entry) => entry.text)
    : [];
  const questions = Array.isArray(body?.questions)
    ? body.questions.map((question) => cleanString(question, 800)).filter(Boolean).slice(0, 15)
    : [];

  const providedId = cleanString(body?.sessionId, 80);
  const sessionId = /^[a-f0-9-]{36}$/i.test(providedId) ? providedId : randomUUID();
  return {
    version: 1,
    sessionId,
    status: ["in_progress", "completed", "cancelled"].includes(body?.status)
      ? body.status
      : "in_progress",
    mode: ["preview", "async"].includes(body?.mode) ? body.mode : "realtime",
    participant: {
      id: cleanString(participant.id, 100),
      name: cleanString(participant.name, 120),
      fullName: cleanString(participant.fullName, 160),
      role: cleanString(participant.role, 180),
      area: cleanString(participant.area, 100),
    },
    questions,
    transcript,
    startedAt: cleanString(body?.startedAt, 50) || new Date().toISOString(),
    endedAt: cleanString(body?.endedAt, 50),
    durationSeconds: Math.max(0, Number(body?.durationSeconds) || 0),
    model: cleanString(body?.model, 100),
    voice: cleanString(body?.voice, 50),
    updatedAt: new Date().toISOString(),
  };
}

function sortTranscriptForExport(entries) {
  const speakerOrder = { interviewer: 0, participant: 1, system: 2 };
  return entries
    .map((entry, originalIndex) => ({ entry, originalIndex }))
    .sort((left, right) => {
      const leftQuestion = Number.isInteger(left.entry.questionIndex)
        ? left.entry.questionIndex
        : Number.MAX_SAFE_INTEGER;
      const rightQuestion = Number.isInteger(right.entry.questionIndex)
        ? right.entry.questionIndex
        : Number.MAX_SAFE_INTEGER;
      if (leftQuestion !== rightQuestion) return leftQuestion - rightQuestion;
      const leftSpeaker = speakerOrder[left.entry.speaker] ?? 3;
      const rightSpeaker = speakerOrder[right.entry.speaker] ?? 3;
      if (leftSpeaker !== rightSpeaker) return leftSpeaker - rightSpeaker;
      if (left.entry.speaker === "participant") {
        const leftOrder = Number.isInteger(left.entry.segmentOrder)
          ? left.entry.segmentOrder
          : Number.MAX_SAFE_INTEGER;
        const rightOrder = Number.isInteger(right.entry.segmentOrder)
          ? right.entry.segmentOrder
          : Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      }
      return left.originalIndex - right.originalIndex;
    })
    .map(({ entry }) => entry);
}

function interviewToMarkdown(record) {
  const title = record.participant.fullName || record.participant.name || "Entrevista";
  const lines = [
    `# Entrevista · ${title}`,
    "",
    `- Cargo: ${record.participant.role || "No indicado"}`,
    `- Área: ${record.participant.area || "No indicada"}`,
    `- Inicio: ${record.startedAt}`,
    `- Fin: ${record.endedAt || "En curso"}`,
    `- Duración: ${Math.round(record.durationSeconds / 60)} min`,
    `- Estado: ${record.status}`,
    "",
  ];

  const participantEntries = record.transcript
    .filter((entry) => entry.speaker === "participant")
    .sort((left, right) => {
      const leftOrder = Number.isInteger(left.segmentOrder)
        ? left.segmentOrder
        : Number.MAX_SAFE_INTEGER;
      const rightOrder = Number.isInteger(right.segmentOrder)
        ? right.segmentOrder
        : Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
    });
  record.questions.forEach((question, questionIndex) => {
    lines.push(`## ${questionIndex + 1}. ${question}`, "");
    const answers = participantEntries
      .filter((entry) => entry.questionIndex === questionIndex)
      .map((entry) => {
        const notes = [];
        if (entry.partial) notes.push("_Transcripción parcial._");
        if (entry.draft) notes.push("_Respuesta en curso; todavía no confirmada._");
        return notes.length ? `${entry.text}\n\n${notes.join("\n")}` : entry.text;
      });
    lines.push(answers.length ? answers.join("\n\n") : "_Sin respuesta registrada._", "");
  });

  lines.push("---", "", "## Transcripción completa", "");
  for (const entry of sortTranscriptForExport(record.transcript)) {
    const speaker = entry.speaker === "interviewer" ? "Entrevistadora" : "Participante";
    const labels = [];
    if (entry.partial) labels.push("transcripción parcial");
    if (entry.draft) labels.push("respuesta en curso");
    const statusLabel = labels.length ? ` (${labels.join(", ")})` : "";
    lines.push(`**${speaker}${statusLabel}:** ${entry.text}`, "");
  }
  return `${lines.join("\n").trim()}\n`;
}

function interviewToText(record) {
  return interviewToMarkdown(record)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-] /gm, "")
    .replace(/\*\*/g, "")
    .replace(/_([^_]+)_/g, "$1");
}

async function persistInterviewRecord(record) {
  const base = join(INTERVIEWS_DIR, record.sessionId);
  const jsonPath = `${base}.json`;
  if (existsSync(jsonPath)) {
    try {
      const existing = JSON.parse(await readFile(jsonPath, "utf8"));
      if (
        ["completed", "cancelled"].includes(existing?.status) &&
        record.status !== existing.status
      ) {
        return existing;
      }
    } catch {
      // Si el archivo previo está dañado, el nuevo guardado atómico lo reparará.
    }
  }
  await Promise.all([
    writeFileAtomic(jsonPath, `${JSON.stringify(record, null, 2)}\n`),
    writeFileAtomic(`${base}.md`, interviewToMarkdown(record)),
    writeFileAtomic(`${base}.txt`, interviewToText(record)),
  ]);
  return record;
}

async function saveInterview(body) {
  const record = sanitizeInterviewRecord(body);
  const previous = interviewWriteQueues.get(record.sessionId) || Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(() => persistInterviewRecord(record));
  interviewWriteQueues.set(record.sessionId, operation);
  try {
    return await operation;
  } finally {
    if (interviewWriteQueues.get(record.sessionId) === operation) {
      interviewWriteQueues.delete(record.sessionId);
    }
  }
}

async function listInterviewSummaries() {
  const files = (await readdir(INTERVIEWS_DIR)).filter(
    (file) => /^[a-f0-9-]{36}\.json$/i.test(file),
  );
  const summaries = [];
  for (const file of files.slice(-100)) {
    try {
      const record = JSON.parse(await readFile(join(INTERVIEWS_DIR, file), "utf8"));
      summaries.push({
        sessionId: record.sessionId,
        name: record.participant?.fullName || record.participant?.name || "Entrevista",
        role: record.participant?.role || "",
        status: record.status,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        hasSynthesis: existsSync(join(INTERVIEWS_DIR, `${record.sessionId}.proceso.json`)),
      });
    } catch {
      // Un archivo incompleto no debe romper el listado completo.
    }
  }
  return summaries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// ---------------------------------------------------------------------------
// Capa de IA generativa: guías de entrevista, repreguntas y síntesis de procesos.
// Todas las llamadas usan la misma clave local y nunca exponen datos a la web pública.
// ---------------------------------------------------------------------------

async function callOpenAIJson({ system, user, maxOutputTokens = 4000, timeoutMs = 120000 }) {
  if (!runtimeApiKey) {
    const error = new Error("Configura primero la clave de OpenAI en Ajustes.");
    error.statusCode = 409;
    throw error;
  }
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtimeApiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: DEFAULT_TEXT_MODEL,
      response_format: { type: "json_object" },
      max_completion_tokens: maxOutputTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      cleanString(payload?.error?.message, 500) ||
        `OpenAI ha respondido con el código ${response.status}.`,
    );
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    const error = new Error("OpenAI no ha devuelto contenido utilizable.");
    error.statusCode = 502;
    throw error;
  }
  try {
    return JSON.parse(content);
  } catch {
    const error = new Error("La respuesta de OpenAI no es un JSON válido.");
    error.statusCode = 502;
    throw error;
  }
}

async function readRawBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("El audio supera el tamaño máximo permitido (25 MB).");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function transcribeAudio(req) {
  if (!runtimeApiKey) {
    const error = new Error("Configura primero la clave de OpenAI en Ajustes.");
    error.statusCode = 409;
    throw error;
  }
  const audio = await readRawBody(req, MAX_AUDIO_BYTES);
  if (audio.length < 200) {
    throw validationError("La grabación está vacía o es demasiado corta.");
  }
  const contentType = String(req.headers["content-type"] || "audio/webm").split(";")[0];
  const extension = contentType.includes("mp4")
    ? "mp4"
    : contentType.includes("ogg")
      ? "ogg"
      : contentType.includes("wav")
        ? "wav"
        : "webm";

  const form = new FormData();
  form.append("file", new Blob([audio], { type: contentType }), `respuesta.${extension}`);
  form.append("model", DEFAULT_TRANSCRIBE_MODEL);
  form.append("language", "es");
  form.append("prompt", TRANSCRIBE_PROMPT);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${runtimeApiKey}` },
    signal: AbortSignal.timeout(120000),
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      cleanString(payload?.error?.message, 500) ||
        `OpenAI ha respondido con el código ${response.status}.`,
    );
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }
  return { text: cleanString(payload?.text, 20000) };
}

const GENERATOR_SYSTEM_PROMPT = `Eres una consultora experta en mapeo de procesos de negocio y descubrimiento de casos de uso de IA, trabajando como Forward Deployed Engineer en el departamento de Marketing de Leroy Merlin España.
Diseñas guías de entrevista en español de España para entender de principio a fin cómo trabaja una persona concreta: sus actividades, herramientas, dependencias, tiempos, dolores y oportunidades de automatización.
Las preguntas deben:
- estar hiperpersonalizadas al cargo, área y proceso descritos;
- ser abiertas, conversacionales y formuladas de tú a tú;
- cubrir el proceso end to end: disparadores, pasos, actores, sistemas, entradas y salidas, tiempos, excepciones, métricas y dependencias entre equipos;
- incluir al menos una pregunta sobre carga manual repetitiva, una sobre datos y herramientas, una sobre qué debería seguir siendo humano y una de cierre orientada a resultados;
- resolver explícitamente las dudas pendientes que se indiquen.
Responde únicamente con un JSON válido.`;

async function generateIntervieweeProfile(body) {
  const fullName = cleanString(body?.fullName, 120);
  const role = cleanString(body?.role, 160);
  const area = cleanString(body?.area, 80);
  const processDescription = cleanString(body?.processDescription, 4000);
  const objectives = cleanString(body?.objectives, 2000);
  const durationMinutes = Math.max(15, Math.min(30, Number(body?.durationMinutes) || 20));
  if (!fullName || !role || !processDescription) {
    throw validationError("Indica al menos nombre, cargo y una descripción del proceso a mapear.");
  }

  const user = [
    `Persona a entrevistar: ${fullName}`,
    `Cargo: ${role}`,
    area ? `Área: ${area}` : "",
    `Duración orientativa: ${durationMinutes} minutos`,
    `Proceso o ámbito de trabajo a mapear:\n${processDescription}`,
    objectives ? `Dudas y objetivos concretos que la entrevista debe resolver:\n${objectives}` : "",
    "",
    'Devuelve un JSON con esta forma exacta: {"context": "resumen privado de 2-4 frases para que la entrevistadora ajuste el tono y sepa qué buscar", "questions": ["...", "..."]} con entre 12 y 15 preguntas ordenadas de apertura a cierre.',
  ]
    .filter(Boolean)
    .join("\n");

  const generated = await callOpenAIJson({
    system: GENERATOR_SYSTEM_PROMPT,
    user,
    maxOutputTokens: 6000,
  });

  const questions = Array.isArray(generated?.questions)
    ? generated.questions.map((question) => cleanString(question, 800)).filter(Boolean)
    : [];
  if (questions.length < 12 || questions.length > 15) {
    throw validationError(
      `La IA ha devuelto ${questions.length} preguntas y deben ser entre 12 y 15. Vuelve a intentarlo.`,
    );
  }

  const name = fullName.split(/\s+/)[0] || fullName;
  const candidate = {
    id: slugify(fullName),
    name,
    fullName,
    role,
    area: area || "Marketing",
    durationMinutes,
    isDemo: false,
    context: cleanString(generated?.context, 1200) || processDescription.slice(0, 1200),
    questions,
  };

  const current = JSON.parse(await readFile(INTERVIEWEES_FILE, "utf8"));
  const existingIndex = current.findIndex((person) => person?.id === candidate.id);
  if (existingIndex >= 0) current[existingIndex] = candidate;
  else current.push(candidate);
  const interviewees = validateInterviewees(current);
  await writeFileAtomic(INTERVIEWEES_FILE, `${JSON.stringify(interviewees, null, 2)}\n`);
  return { interviewee: candidate, interviewees };
}

const FOLLOWUP_SYSTEM_PROMPT = `Eres el motor de repreguntas de una entrevista para mapear procesos de trabajo en Leroy Merlin España.
Recibes una pregunta y la respuesta de la persona. Decide si merece la pena UNA única repregunta breve de profundización para poder modelar bien el proceso.
Solo repregunta si falta información clave: qué pasos concretos sigue, quién interviene, qué herramientas o sistemas usa, con qué frecuencia, cuánto tiempo lleva, qué entradas y salidas tiene o qué pasa cuando algo falla.
Si la respuesta ya es razonablemente concreta, si es personal u opinativa, o si la persona ha preferido no extenderse, NO repreguntes.
La repregunta debe ser natural, en español de España, de tú a tú, de una sola frase y sin sonar a interrogatorio.
Responde únicamente con JSON: {"necesitaRepregunta": true|false, "repregunta": "texto o cadena vacía"}.`;

async function generateFollowup(body) {
  const question = cleanString(body?.question, 800);
  const answer = cleanString(body?.answer, 8000);
  const role = cleanString(body?.role, 160);
  const area = cleanString(body?.area, 80);
  if (!question || !answer) {
    throw validationError("Faltan la pregunta o la respuesta para valorar la repregunta.");
  }
  const result = await callOpenAIJson({
    system: FOLLOWUP_SYSTEM_PROMPT,
    user: `Persona entrevistada: ${role || "sin cargo indicado"}${area ? ` · ${area}` : ""}\nPregunta: ${question}\nRespuesta: ${answer}`,
    maxOutputTokens: 1200,
    timeoutMs: 45000,
  });
  const followup = cleanString(result?.repregunta, 500);
  return {
    followup: result?.necesitaRepregunta && followup ? followup : null,
  };
}

const SYNTHESIS_SYSTEM_PROMPT = `Eres una consultora experta en modelado de procesos (BPM) y descubrimiento de casos de uso de IA generativa dentro del área de Marketing de Leroy Merlin España.
A partir de la transcripción de una entrevista, construyes un modelo estructurado del proceso descrito por la persona.
Sé fiel a lo dicho: no inventes pasos ni sistemas que no se mencionen. Lo que no quede claro va a "preguntasAbiertas".
El campo "mermaid" debe contener un diagrama "flowchart TD" válido de Mermaid (sin fences de código), con los pasos principales del proceso, decisiones si las hay, y los actores entre corchetes en las etiquetas. Usa identificadores simples (P1, P2, D1...) y etiquetas entre comillas dobles.
Responde únicamente con un JSON válido con esta forma:
{
  "resumenEjecutivo": "5-8 frases",
  "pasos": [{"orden": 1, "actividad": "", "actor": "", "sistemas": [""], "entradas": "", "salidas": "", "frecuencia": "", "duracionEstimada": "", "esManual": true}],
  "dolores": [{"descripcion": "", "impacto": "alto|medio|bajo", "cita": "cita textual breve de la persona"}],
  "oportunidades": [{"titulo": "", "descripcion": "", "tipo": "ia_generativa|automatizacion|datos|proceso", "impacto": "alto|medio|bajo", "esfuerzo": "alto|medio|bajo"}],
  "sistemas": [""],
  "dependencias": ["equipo o rol del que depende y para qué"],
  "preguntasAbiertas": [""],
  "mermaid": "flowchart TD..."
}`;

function interviewToQaText(record) {
  const lines = [
    `Entrevista a ${record.participant.fullName || record.participant.name || "persona sin nombre"}`,
    `Cargo: ${record.participant.role || "no indicado"} · Área: ${record.participant.area || "no indicada"}`,
    "",
  ];
  const participantEntries = record.transcript.filter(
    (entry) => entry.speaker === "participant",
  );
  record.questions.forEach((question, index) => {
    lines.push(`PREGUNTA ${index + 1}: ${question}`);
    const answers = participantEntries
      .filter((entry) => entry.questionIndex === index)
      .map((entry) => entry.text);
    lines.push(`RESPUESTA: ${answers.length ? answers.join(" ") : "(sin respuesta)"}`, "");
  });
  return lines.join("\n");
}

function synthesisToMarkdown(record, synthesis) {
  const title = record.participant.fullName || record.participant.name || "Entrevista";
  const lines = [
    `# Modelo de proceso · ${title}`,
    "",
    `- Cargo: ${record.participant.role || "No indicado"}`,
    `- Área: ${record.participant.area || "No indicada"}`,
    `- Entrevista: ${record.startedAt}`,
    `- Generado: ${new Date().toISOString()}`,
    "",
    "## Resumen ejecutivo",
    "",
    synthesis.resumenEjecutivo || "_Sin resumen._",
    "",
    "## Diagrama del proceso",
    "",
    "```mermaid",
    synthesis.mermaid || "flowchart TD\n  A[\"Sin datos suficientes\"]",
    "```",
    "",
    "## Pasos del proceso",
    "",
    "| # | Actividad | Actor | Sistemas | Entradas | Salidas | Frecuencia | Duración | Manual |",
    "|---|-----------|-------|----------|----------|---------|------------|----------|--------|",
  ];
  for (const paso of synthesis.pasos || []) {
    lines.push(
      `| ${paso.orden ?? ""} | ${paso.actividad ?? ""} | ${paso.actor ?? ""} | ${(paso.sistemas || []).join(", ")} | ${paso.entradas ?? ""} | ${paso.salidas ?? ""} | ${paso.frecuencia ?? ""} | ${paso.duracionEstimada ?? ""} | ${paso.esManual ? "Sí" : "No"} |`,
    );
  }
  lines.push("", "## Dolores detectados", "");
  for (const dolor of synthesis.dolores || []) {
    lines.push(`- **[${dolor.impacto || "?"}]** ${dolor.descripcion}${dolor.cita ? ` — «${dolor.cita}»` : ""}`);
  }
  lines.push("", "## Oportunidades de IA y automatización", "");
  for (const opp of synthesis.oportunidades || []) {
    lines.push(
      `- **${opp.titulo}** (${opp.tipo || "?"} · impacto ${opp.impacto || "?"} · esfuerzo ${opp.esfuerzo || "?"}): ${opp.descripcion}`,
    );
  }
  lines.push("", "## Sistemas mencionados", "");
  lines.push((synthesis.sistemas || []).map((s) => `- ${s}`).join("\n") || "_Ninguno._");
  lines.push("", "## Dependencias entre equipos", "");
  lines.push((synthesis.dependencias || []).map((d) => `- ${d}`).join("\n") || "_Ninguna._");
  lines.push("", "## Preguntas abiertas para el shadowing", "");
  lines.push((synthesis.preguntasAbiertas || []).map((q) => `- ${q}`).join("\n") || "_Ninguna._");
  return `${lines.join("\n").trim()}\n`;
}

async function synthesizeInterview(sessionId) {
  const jsonPath = join(INTERVIEWS_DIR, `${sessionId}.json`);
  if (!existsSync(jsonPath)) {
    throw validationError("No existe esa entrevista.");
  }
  const record = JSON.parse(await readFile(jsonPath, "utf8"));
  const answered = record.transcript?.filter((entry) => entry.speaker === "participant") || [];
  if (!answered.length) {
    throw validationError("La entrevista no tiene todavía respuestas que sintetizar.");
  }
  const synthesis = await callOpenAIJson({
    system: SYNTHESIS_SYSTEM_PROMPT,
    user: interviewToQaText(record),
    maxOutputTokens: 12000,
    timeoutMs: 180000,
  });
  const stored = {
    version: 1,
    sessionId,
    participant: record.participant,
    generatedAt: new Date().toISOString(),
    model: DEFAULT_TEXT_MODEL,
    synthesis,
  };
  const base = join(INTERVIEWS_DIR, sessionId);
  await Promise.all([
    writeFileAtomic(`${base}.proceso.json`, `${JSON.stringify(stored, null, 2)}\n`),
    writeFileAtomic(`${base}.proceso.md`, synthesisToMarkdown(record, synthesis)),
  ]);
  return stored;
}

const GLOBAL_SYNTHESIS_SYSTEM_PROMPT = `Eres una consultora experta en modelado de procesos y estrategia de IA generativa para el área de Marketing de Leroy Merlin España.
Recibes los modelos de proceso individuales extraídos de varias entrevistas. Construye una síntesis transversal para el equipo del proyecto.
Sé fiel a los datos: no inventes. Señala contradicciones entre personas cuando existan.
Responde únicamente con un JSON válido con esta forma:
{
  "resumenEjecutivo": "8-12 frases sobre la cadena de valor completa",
  "cadenaDeValor": [{"fase": "", "descripcion": "", "personasImplicadas": [""], "dolorPrincipal": ""}],
  "doloresComunes": [{"descripcion": "", "personasAfectadas": [""], "impacto": "alto|medio|bajo"}],
  "portafolioOportunidades": [{"titulo": "", "descripcion": "", "tipo": "ia_generativa|automatizacion|datos|proceso", "impacto": "alto|medio|bajo", "esfuerzo": "alto|medio|bajo", "prioridad": 1}],
  "contradicciones": [""],
  "recomendacionesShadowing": [""],
  "mermaid": "flowchart LR con la cadena de valor end to end (sin fences de código, etiquetas entre comillas dobles)"
}`;

function globalSynthesisToMarkdown(payload) {
  const s = payload.synthesis;
  const lines = [
    "# Síntesis global · Marketing Activation con IA",
    "",
    `- Entrevistas analizadas: ${payload.sources.map((source) => source.name).join(", ")}`,
    `- Generado: ${payload.generatedAt}`,
    "",
    "## Resumen ejecutivo",
    "",
    s.resumenEjecutivo || "_Sin resumen._",
    "",
    "## Cadena de valor",
    "",
    "```mermaid",
    s.mermaid || "flowchart LR\n  A[\"Sin datos suficientes\"]",
    "```",
    "",
  ];
  for (const fase of s.cadenaDeValor || []) {
    lines.push(`### ${fase.fase}`, "", fase.descripcion || "", "");
    if (fase.personasImplicadas?.length) lines.push(`- Personas: ${fase.personasImplicadas.join(", ")}`);
    if (fase.dolorPrincipal) lines.push(`- Dolor principal: ${fase.dolorPrincipal}`);
    lines.push("");
  }
  lines.push("## Dolores comunes", "");
  for (const dolor of s.doloresComunes || []) {
    lines.push(`- **[${dolor.impacto || "?"}]** ${dolor.descripcion} (${(dolor.personasAfectadas || []).join(", ")})`);
  }
  lines.push("", "## Portafolio de oportunidades (priorizado)", "");
  const sorted = [...(s.portafolioOportunidades || [])].sort(
    (a, b) => (a.prioridad ?? 99) - (b.prioridad ?? 99),
  );
  for (const opp of sorted) {
    lines.push(
      `${opp.prioridad ?? "-"}. **${opp.titulo}** (${opp.tipo || "?"} · impacto ${opp.impacto || "?"} · esfuerzo ${opp.esfuerzo || "?"}): ${opp.descripcion}`,
    );
  }
  lines.push("", "## Contradicciones a contrastar", "");
  lines.push((s.contradicciones || []).map((c) => `- ${c}`).join("\n") || "_Ninguna._");
  lines.push("", "## Recomendaciones para el shadowing", "");
  lines.push((s.recomendacionesShadowing || []).map((r) => `- ${r}`).join("\n") || "_Ninguna._");
  return `${lines.join("\n").trim()}\n`;
}

async function synthesizeGlobal() {
  const files = (await readdir(INTERVIEWS_DIR)).filter((file) => file.endsWith(".proceso.json"));
  if (!files.length) {
    throw validationError(
      "Todavía no hay modelos de proceso individuales. Genera primero al menos uno desde el historial.",
    );
  }
  const sources = [];
  const chunks = [];
  for (const file of files.slice(-30)) {
    try {
      const stored = JSON.parse(await readFile(join(INTERVIEWS_DIR, file), "utf8"));
      sources.push({
        sessionId: stored.sessionId,
        name: stored.participant?.fullName || stored.participant?.name || file,
      });
      chunks.push(
        `=== ${stored.participant?.fullName || "Persona"} (${stored.participant?.role || ""}) ===\n${JSON.stringify(stored.synthesis)}`,
      );
    } catch {
      // Un modelo dañado no debe romper la síntesis global.
    }
  }
  const synthesis = await callOpenAIJson({
    system: GLOBAL_SYNTHESIS_SYSTEM_PROMPT,
    user: chunks.join("\n\n"),
    maxOutputTokens: 16000,
    timeoutMs: 240000,
  });
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    model: DEFAULT_TEXT_MODEL,
    sources,
    synthesis,
  };
  await Promise.all([
    writeFileAtomic(
      join(INTERVIEWS_DIR, "sintesis-global.json"),
      `${JSON.stringify(payload, null, 2)}\n`,
    ),
    writeFileAtomic(join(INTERVIEWS_DIR, "sintesis-global.md"), globalSynthesisToMarkdown(payload)),
  ]);
  return payload;
}

async function handleApi(req, res, url) {
  if (!["GET", "HEAD"].includes(req.method || "") && !hasAllowedOrigin(req)) {
    return sendJson(res, 403, { error: "El origen de la petición no está autorizado." });
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, 200, {
      keyConfigured: Boolean(runtimeApiKey),
      model: DEFAULT_MODEL,
      voice: DEFAULT_VOICE,
      localSettingsEnabled: isLoopback(req),
    });
  }

  if (req.method === "PUT" && url.pathname === "/api/settings/openai-key") {
    if (!requireLoopback(req, res)) return;
    const body = await readJsonBody(req);
    const apiKey = cleanString(body?.apiKey, 500);
    if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(apiKey)) {
      throw validationError("La clave no tiene un formato válido.");
    }
    await persistApiKey(apiKey);
    return sendJson(res, 200, { ok: true, keyConfigured: true });
  }

  if (req.method === "POST" && url.pathname === "/api/realtime/session") {
    const body = await readJsonBody(req);
    const secret = await createRealtimeClientSecret({
      model: cleanString(body?.model, 100),
      voice: cleanString(body?.voice, 50),
    });
    return sendJson(res, 200, secret);
  }

  if (req.method === "GET" && url.pathname === "/api/interviewees") {
    const raw = JSON.parse(await readFile(INTERVIEWEES_FILE, "utf8"));
    return sendJson(res, 200, { interviewees: validateInterviewees(raw) });
  }

  if (req.method === "PUT" && url.pathname === "/api/interviewees") {
    if (!requireLoopback(req, res)) return;
    const body = await readJsonBody(req);
    const interviewees = validateInterviewees(body?.interviewees);
    const temporary = `${INTERVIEWEES_FILE}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(interviewees, null, 2)}\n`, "utf8");
    await rename(temporary, INTERVIEWEES_FILE);
    return sendJson(res, 200, { ok: true, count: interviewees.length, interviewees });
  }

  if (req.method === "GET" && url.pathname === "/api/interviewees/template") {
    const content = await readFile(TEMPLATE_FILE, "utf8");
    setSecurityHeaders(res);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="plantilla-personas-preguntas.json"',
      "Content-Length": Buffer.byteLength(content),
      "Cache-Control": "no-store",
    });
    return res.end(content);
  }

  if (req.method === "POST" && url.pathname === "/api/interviewees/generate") {
    if (!requireLoopback(req, res)) return;
    const body = await readJsonBody(req);
    const result = await generateIntervieweeProfile(body);
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (req.method === "POST" && url.pathname === "/api/transcribe") {
    const result = await transcribeAudio(req);
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/interviews/followup") {
    const body = await readJsonBody(req);
    const result = await generateFollowup(body);
    return sendJson(res, 200, result);
  }

  const synthesisMatch = url.pathname.match(
    /^\/api\/interviews\/([a-f0-9-]{36})\/synthesis$/i,
  );
  if (req.method === "POST" && synthesisMatch) {
    if (!requireLoopback(req, res)) return;
    const stored = await synthesizeInterview(synthesisMatch[1]);
    return sendJson(res, 200, {
      ok: true,
      sessionId: stored.sessionId,
      exports: {
        markdown: `/api/interviews/${stored.sessionId}/synthesis/export?format=md`,
        json: `/api/interviews/${stored.sessionId}/synthesis/export?format=json`,
      },
    });
  }

  const synthesisExportMatch = url.pathname.match(
    /^\/api\/interviews\/([a-f0-9-]{36})\/synthesis\/export$/i,
  );
  if (req.method === "GET" && synthesisExportMatch) {
    const format = url.searchParams.get("format") === "json" ? "json" : "md";
    const path = join(INTERVIEWS_DIR, `${synthesisExportMatch[1]}.proceso.${format}`);
    if (!existsSync(path)) {
      return sendJson(res, 404, { error: "Esa entrevista no tiene todavía modelo de proceso." });
    }
    const content = await readFile(path);
    setSecurityHeaders(res);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[`.${format}`] || "application/octet-stream",
      "Content-Disposition": `attachment; filename="proceso-${synthesisExportMatch[1]}.${format}"`,
      "Content-Length": content.length,
      "Cache-Control": "no-store",
    });
    return res.end(content);
  }

  if (req.method === "POST" && url.pathname === "/api/synthesis/global") {
    if (!requireLoopback(req, res)) return;
    const payload = await synthesizeGlobal();
    return sendJson(res, 200, {
      ok: true,
      sources: payload.sources,
      exports: {
        markdown: "/api/synthesis/global/export?format=md",
        json: "/api/synthesis/global/export?format=json",
      },
    });
  }

  if (req.method === "GET" && url.pathname === "/api/synthesis/global/export") {
    const format = url.searchParams.get("format") === "json" ? "json" : "md";
    const path = join(INTERVIEWS_DIR, `sintesis-global.${format}`);
    if (!existsSync(path)) {
      return sendJson(res, 404, { error: "Todavía no se ha generado la síntesis global." });
    }
    const content = await readFile(path);
    setSecurityHeaders(res);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[`.${format}`] || "application/octet-stream",
      "Content-Disposition": `attachment; filename="sintesis-global.${format}"`,
      "Content-Length": content.length,
      "Cache-Control": "no-store",
    });
    return res.end(content);
  }

  if (req.method === "GET" && url.pathname === "/api/interviews") {
    return sendJson(res, 200, { interviews: await listInterviewSummaries() });
  }

  if (req.method === "POST" && url.pathname === "/api/interviews") {
    const body = await readJsonBody(req);
    const record = await saveInterview(body);
    return sendJson(res, 200, {
      ok: true,
      sessionId: record.sessionId,
      exports: {
        json: `/api/interviews/${record.sessionId}/export?format=json`,
        markdown: `/api/interviews/${record.sessionId}/export?format=md`,
        text: `/api/interviews/${record.sessionId}/export?format=txt`,
      },
    });
  }

  const exportMatch = url.pathname.match(
    /^\/api\/interviews\/([a-f0-9-]{36})\/export$/i,
  );
  if (req.method === "GET" && exportMatch) {
    const format = ["json", "md", "txt"].includes(url.searchParams.get("format"))
      ? url.searchParams.get("format")
      : "json";
    const path = join(INTERVIEWS_DIR, `${exportMatch[1]}.${format}`);
    if (!existsSync(path)) return sendJson(res, 404, { error: "No existe esa entrevista." });
    const content = await readFile(path);
    const mime = MIME_TYPES[`.${format}`] || "application/octet-stream";
    setSecurityHeaders(res);
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Disposition": `attachment; filename="entrevista-${exportMatch[1]}.${format}"`,
      "Content-Length": content.length,
      "Cache-Control": "no-store",
    });
    return res.end(content);
  }

  return sendJson(res, 404, { error: "Ruta no encontrada." });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const relative = normalize(pathname).replace(/^[/\\]+/, "");
  const path = join(PUBLIC_DIR, relative);
  if (!path.startsWith(PUBLIC_DIR) || relative.startsWith(".")) {
    return sendText(res, 403, "Acceso denegado.");
  }

  try {
    const info = await stat(path);
    if (!info.isFile()) return sendText(res, 404, "No encontrado.");
    setSecurityHeaders(res);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(path).toLowerCase()] || "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": path.endsWith("index.html") ? "no-cache" : "public, max-age=300",
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(path).pipe(res);
  } catch {
    sendText(res, 404, "No encontrado.");
  }
}

const server = http.createServer(async (req, res) => {
  if (!isLoopback(req) || !hasAllowedHost(req)) {
    return sendJson(res, 403, { error: "Este MVP solo admite conexiones locales." });
  }
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else if (["GET", "HEAD"].includes(req.method || "")) {
      await serveStatic(req, res, url);
    } else {
      sendJson(res, 405, { error: "Método no permitido." });
    }
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    if (statusCode >= 500) console.error("Error interno:", error?.message || error);
    if (!res.headersSent) {
      sendJson(res, statusCode, {
        error: statusCode >= 500 ? "Ha ocurrido un error interno." : error.message,
      });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Entrevistas IA · http://${HOST}:${PORT}`);
  console.log(`Clave OpenAI: ${runtimeApiKey ? "configurada" : "pendiente"}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
