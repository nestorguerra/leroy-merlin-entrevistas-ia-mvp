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
    mode: body?.mode === "preview" ? "preview" : "realtime",
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

  const participantEntries = record.transcript.filter((entry) => entry.speaker === "participant");
  record.questions.forEach((question, questionIndex) => {
    lines.push(`## ${questionIndex + 1}. ${question}`, "");
    const answers = participantEntries
      .filter((entry) => entry.questionIndex === questionIndex)
      .map((entry) =>
        entry.partial ? `${entry.text}\n\n_Transcripción parcial._` : entry.text,
      );
    lines.push(answers.length ? answers.join("\n\n") : "_Sin respuesta registrada._", "");
  });

  lines.push("---", "", "## Transcripción completa", "");
  for (const entry of record.transcript) {
    const speaker = entry.speaker === "interviewer" ? "Entrevistadora" : "Participante";
    const partialLabel = entry.partial ? " (transcripción parcial)" : "";
    lines.push(`**${speaker}${partialLabel}:** ${entry.text}`, "");
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
  const files = (await readdir(INTERVIEWS_DIR)).filter((file) => file.endsWith(".json"));
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
      });
    } catch {
      // Un archivo incompleto no debe romper el listado completo.
    }
  }
  return summaries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
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
