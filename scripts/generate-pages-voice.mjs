import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROFILES_FILE = join(ROOT, "data", "interviewees.json");
const ENV_FILE = join(ROOT, ".env.local");
const OUTPUT_ROOT = join(ROOT, "public", "audio", "openai-marin-v1");
const MODEL = "gpt-4o-mini-tts";
const VOICE = "marin";
const STYLE_INSTRUCTIONS = [
  "Habla siempre en español de España.",
  "Suenas como una mujer adulta hablando cara a cara con una sola persona: cercana, cálida, serena y espontánea.",
  "Usa un ritmo conversacional natural y ligeramente pausado, con pausas breves entre ideas.",
  "No uses tono de locutora, anuncio, audiolibro, podcast, centralita ni presentación corporativa.",
  "No cantes las frases, no alargues las vocales y no eleves sistemáticamente la entonación al final.",
  "Las preguntas deben sonar interesadas y humanas, nunca ensayadas.",
  "Pronuncia IA como i-a y Leroy Merlin de forma natural en español.",
  "Lee el texto literalmente, sin añadir, omitir ni reformular palabras.",
].join(" ");

function parseEnvValue(content, key) {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || match[1] !== key) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return "";
}

function clipDefinitions(person) {
  const intro = [
    `Hola, ${person.name}. Gracias por dedicarme este rato.`,
    "Me gustaría hacerte unas preguntas para entender mejor tu experiencia.",
    "No hay respuestas correctas o incorrectas; me interesa conocer tu punto de vista.",
    person.questions[0],
  ].join(" ");
  const questions = person.questions.map((text, index) => ({
    key: `question-${String(index + 1).padStart(2, "0")}`,
    kind: "question",
    questionIndex: index,
    text,
  }));
  const closing = [
    "Con esto hemos terminado.",
    `Muchas gracias, ${person.name}, por tu tiempo y por todo lo que has compartido.`,
    "Ahora prepararemos la transcripción para poder trabajar con ella.",
  ].join(" ");
  return [
    { key: "intro", kind: "intro", questionIndex: 0, text: intro },
    ...questions,
    { key: "closing", kind: "closing", questionIndex: null, text: closing },
  ];
}

function contentHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function generateSpeech({ apiKey, text, targetPath }) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      voice: VOICE,
      input: text,
      instructions: STYLE_INSTRUCTIONS,
      response_format: "mp3",
    }),
  });
  if (!response.ok) {
    let message = `OpenAI ha respondido con ${response.status}.`;
    try {
      const payload = await response.json();
      if (payload?.error?.message) message = payload.error.message;
    } catch {
      // La respuesta puede no ser JSON.
    }
    throw new Error(message);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1_000) throw new Error("El audio recibido está vacío o incompleto.");
  await mkdir(dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, targetPath);
  return bytes.length;
}

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : true];
  }),
);
const force = args.has("force");
const only = typeof args.get("only") === "string" ? args.get("only") : "";
const concurrency = Math.max(1, Math.min(4, Number(args.get("concurrency")) || 3));
const envContent = await readFile(ENV_FILE, "utf8").catch(() => "");
const apiKey = process.env.OPENAI_API_KEY || parseEnvValue(envContent, "OPENAI_API_KEY");
if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(apiKey)) {
  throw new Error("No hay una clave de OpenAI utilizable en el entorno local.");
}

const profiles = JSON.parse(await readFile(PROFILES_FILE, "utf8"));
const manifestProfiles = {};
const jobs = [];
for (const person of profiles) {
  const clips = clipDefinitions(person);
  manifestProfiles[person.id] = {
    name: person.name,
    clips: Object.fromEntries(
      clips.map((clip) => [
        clip.key,
        {
          kind: clip.kind,
          questionIndex: clip.questionIndex,
          text: clip.text,
          path: `./audio/openai-marin-v1/${person.id}/${clip.key}.mp3`,
          contentHash: contentHash(`${MODEL}\n${VOICE}\n${STYLE_INSTRUCTIONS}\n${clip.text}`),
        },
      ]),
    ),
  };
  for (const clip of clips) {
    const selector = `${person.id}:${clip.key}`;
    if (only && only !== selector) continue;
    jobs.push({
      person,
      clip,
      selector,
      targetPath: join(OUTPUT_ROOT, person.id, `${clip.key}.mp3`),
    });
  }
}

let nextJob = 0;
let generated = 0;
let reused = 0;
async function worker() {
  while (nextJob < jobs.length) {
    const job = jobs[nextJob++];
    if (!force) {
      const existing = await stat(job.targetPath).catch(() => null);
      if (existing?.isFile() && existing.size >= 1_000) {
        reused += 1;
        console.log(`Reutilizado ${job.selector}`);
        continue;
      }
    }
    const size = await generateSpeech({
      apiKey,
      text: job.clip.text,
      targetPath: job.targetPath,
    });
    generated += 1;
    console.log(`Generado ${job.selector} (${Math.round(size / 1024)} KB)`);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

if (!only) {
  const manifest = {
    schemaVersion: 1,
    model: MODEL,
    voice: VOICE,
    disclosure: "Voz generada por inteligencia artificial de OpenAI.",
    styleInstructions: STYLE_INSTRUCTIONS,
    profiles: manifestProfiles,
  };
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await writeFile(join(OUTPUT_ROOT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`Listo: ${generated} generados, ${reused} reutilizados.`);
