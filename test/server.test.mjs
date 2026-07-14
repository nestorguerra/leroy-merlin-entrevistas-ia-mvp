import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 4193;
const BASE_URL = `http://127.0.0.1:${PORT}`;
let serverProcess;
const generatedIds = [];

async function waitForServer() {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) return;
    } catch {
      // El proceso todavía está arrancando.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("El servidor de prueba no ha arrancado a tiempo.");
}

async function api(path, options) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body };
}

function statusWithHost(host) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: "/api/health",
        headers: { Host: host },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  serverProcess = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer();
});

after(async () => {
  serverProcess?.kill("SIGTERM");
  await Promise.all(
    generatedIds.flatMap((id) =>
      ["json", "md", "txt"].map((extension) =>
        rm(join(ROOT, "data", "interviews", `${id}.${extension}`), { force: true }),
      ),
    ),
  );
});

test("sirve el MVP y anuncia el modelo Realtime correcto", async () => {
  const home = await fetch(`${BASE_URL}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Una conversación pensada para ti/);

  const { response, body } = await api("/api/config");
  assert.equal(response.status, 200);
  assert.equal(body.model, "gpt-realtime-2.1");
  assert.equal(typeof body.keyConfigured, "boolean");
  assert.equal("apiKey" in body, false);
});

test("cada perfil incluye entre 12 y 15 preguntas personalizadas", async () => {
  const { response, body } = await api("/api/interviewees");
  assert.equal(response.status, 200);
  assert.ok(body.interviewees.length >= 3);
  for (const person of body.interviewees) {
    assert.ok(person.questions.length >= 12 && person.questions.length <= 15);
    assert.ok(person.role);
    assert.ok(person.context);
  }
  assert.notDeepEqual(body.interviewees[0].questions, body.interviewees[1].questions);
});

test("rechaza una carga con menos de 12 preguntas sin alterar los perfiles", async () => {
  const { response, body } = await api("/api/interviewees", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      interviewees: [
        {
          id: "invalido",
          name: "Prueba",
          fullName: "Prueba",
          role: "Prueba",
          area: "Prueba",
          questions: ["Solo una pregunta"],
        },
      ],
    }),
  });
  assert.equal(response.status, 400);
  assert.match(body.error, /entre 12 y 15 preguntas/);

  const current = await api("/api/interviewees");
  assert.ok(current.body.interviewees.length >= 3);
});

test("guarda y exporta una entrevista en JSON, Markdown y texto", async () => {
  const interviewees = (await api("/api/interviewees")).body.interviewees;
  const person = interviewees[0];
  const payload = {
    status: "completed",
    mode: "preview",
    participant: person,
    questions: person.questions,
    startedAt: new Date(Date.now() - 120000).toISOString(),
    endedAt: new Date().toISOString(),
    durationSeconds: 120,
    model: "gpt-realtime-2.1",
    voice: "marin",
    transcript: [
      {
        id: "q1",
        speaker: "interviewer",
        questionIndex: 0,
        text: person.questions[0],
      },
      {
        id: "a1",
        speaker: "participant",
        questionIndex: 0,
        text: "Respuesta de prueba con contenido concreto.",
      },
    ],
  };

  const saved = await api("/api/interviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(saved.response.status, 200);
  assert.match(saved.body.sessionId, /^[a-f0-9-]{36}$/);
  generatedIds.push(saved.body.sessionId);

  for (const format of ["json", "md", "txt"]) {
    const exported = await fetch(
      `${BASE_URL}/api/interviews/${saved.body.sessionId}/export?format=${format}`,
    );
    assert.equal(exported.status, 200);
    const content = await exported.text();
    assert.match(content, /Respuesta de prueba con contenido concreto/);
  }
});

test("nunca acepta una clave con formato inválido", async () => {
  const { response, body } = await api("/api/settings/openai-key", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "esto-no-es-una-clave" }),
  });
  assert.equal(response.status, 400);
  assert.match(body.error, /formato válido/);
});

test("rechaza hosts y orígenes ajenos en las rutas locales", async () => {
  assert.equal(await statusWithHost("sitio-ajeno.example"), 403);

  const foreignOrigin = await api("/api/interviews", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://sitio-ajeno.example",
    },
    body: JSON.stringify({ status: "in_progress" }),
  });
  assert.equal(foreignOrigin.response.status, 403);
  assert.match(foreignOrigin.body.error, /origen/i);
});

test("conserva el indicador de una transcripción parcial", async () => {
  const interviewees = (await api("/api/interviewees")).body.interviewees;
  const person = interviewees[0];
  const saved = await api("/api/interviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "cancelled",
      mode: "realtime",
      participant: person,
      questions: person.questions,
      transcript: [
        {
          id: "respuesta-parcial",
          itemId: "item-parcial",
          speaker: "participant",
          questionIndex: 0,
          text: "Respuesta interrumpida que debe conservarse.",
          partial: true,
        },
      ],
    }),
  });
  assert.equal(saved.response.status, 200);
  generatedIds.push(saved.body.sessionId);

  const exported = await fetch(
    `${BASE_URL}/api/interviews/${saved.body.sessionId}/export?format=json`,
  );
  const record = await exported.json();
  assert.equal(record.status, "cancelled");
  assert.equal(record.transcript[0].partial, true);
});

test("una escritura tardía no degrada una entrevista finalizada", async () => {
  const interviewees = (await api("/api/interviewees")).body.interviewees;
  const person = interviewees[0];
  const completed = await api("/api/interviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "completed",
      mode: "realtime",
      participant: person,
      questions: person.questions,
      transcript: [
        {
          id: "respuesta-final",
          speaker: "participant",
          questionIndex: 0,
          text: "Esta es la versión final confirmada.",
        },
      ],
    }),
  });
  assert.equal(completed.response.status, 200);
  generatedIds.push(completed.body.sessionId);

  const lateAutosave = await api("/api/interviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: completed.body.sessionId,
      status: "in_progress",
      mode: "realtime",
      participant: person,
      questions: person.questions,
      transcript: [
        {
          id: "respuesta-antigua",
          speaker: "participant",
          questionIndex: 0,
          text: "Versión antigua que no debe sobrescribir la final.",
        },
      ],
    }),
  });
  assert.equal(lateAutosave.response.status, 200);

  const exported = await fetch(
    `${BASE_URL}/api/interviews/${completed.body.sessionId}/export?format=json`,
  );
  const record = await exported.json();
  assert.equal(record.status, "completed");
  assert.match(record.transcript[0].text, /versión final confirmada/i);
});
