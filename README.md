# Escucha · entrevistas IA para Leroy Merlin

MVP para realizar entrevistas por voz con una guía distinta para cada persona y guardado automático de la transcripción. El modo local usa `gpt-realtime-1.5` con la voz `marin` de OpenAI.

## Demo en GitHub Pages

[Abrir la demo visual](https://nestorguerra.github.io/leroy-merlin-entrevistas-ia-mvp/)

La demo pública permite recorrer las preguntas, responder hablando o escribiendo y descargar la transcripción en Markdown, TXT y JSON. La entrevistadora se oye con audios generados previamente mediante OpenAI `gpt-4o-mini-tts` y la voz `marin`; la interfaz indica expresamente que es una voz generada por IA.

Las pausas no hacen avanzar la entrevista: cada fragmento se acumula en la respuesta actual y solo se pasa a la siguiente pregunta al pulsar **He terminado de responder**.

GitHub Pages no contiene ninguna clave ni hace llamadas a OpenAI durante la entrevista: sirve los MP3 ya publicados. Si se importa un perfil que todavía no tiene su paquete de audio, la entrevista continúa por texto, sin sustituirlo por una voz distinta del navegador. La conversación Realtime completa sigue disponible en la copia local descrita abajo.

## Abrir el MVP

La forma fácil es hacer doble clic en **`Abrir MVP.command`**. Se abrirá el navegador en:

`http://127.0.0.1:4177`

También se puede iniciar desde Terminal con Node 20 o posterior:

```bash
npm start
```

## Primera configuración

1. Abre el engranaje de **Ajustes**.
2. Pega la clave de OpenAI en **Clave de OpenAI**.
3. Pulsa **Guardar clave de forma segura**.
4. Elige voz y empieza una entrevista.

La clave estándar se guarda solo en `.env.local` y nunca se incluye en el HTML, los audios ni GitHub Pages. El navegador recibe de OpenAI una credencial temporal para establecer la conexión WebRTC con `gpt-realtime-1.5` y la voz `marin`.

## Cargar personas y preguntas

En **Ajustes → Personas** puedes descargar una plantilla JSON y cargar la lista real. Cada ficha requiere:

- nombre, cargo y área;
- contexto privado para ajustar el tono;
- entre 12 y 15 preguntas personalizadas;
- duración orientativa entre 15 y 30 minutos.

El archivo activo es `data/interviewees.json`. El MVP incluye tres perfiles ficticios para probar Operaciones, Datos y Personas.

## Crear entrevistas personalizadas con IA

En **Ajustes → Crear con IA** puedes generar la ficha completa de una persona sin escribir las preguntas a mano. Indica nombre, cargo, área, el proceso a mapear y las dudas concretas que quieres resolver, y la IA diseña entre 12 y 15 preguntas hiperpersonalizadas orientadas a modelar el proceso end to end (pasos, actores, sistemas, tiempos, excepciones y dependencias). El perfil se añade a `data/interviewees.json` y se puede revisar o ajustar como cualquier otro. Requiere la clave de OpenAI configurada; usa el modelo definido en `OPENAI_TEXT_MODEL` (por defecto `gpt-5.1`).

## Repreguntas de profundización

Con la opción **Repreguntas de profundización** activada (Ajustes → Voz y modelo), al pulsar «He terminado de responder» la IA valora si a la respuesta le falta información clave para modelar el proceso (pasos, actores, sistemas, frecuencia, tiempos, excepciones). Si es así, la entrevistadora hace una única repregunta antes de avanzar; como máximo una por pregunta. Si la valoración falla o no hay clave configurada, la entrevista continúa con normalidad. En GitHub Pages esta función está desactivada.

## Modelado de procesos

Desde **Ajustes → Historial**:

- **Modelar proceso** convierte una entrevista en un modelo estructurado: resumen ejecutivo, tabla de pasos (actividad, actor, sistemas, entradas/salidas, frecuencia, duración, carga manual), dolores con citas textuales, oportunidades de IA/automatización clasificadas por impacto y esfuerzo, dependencias entre equipos, preguntas abiertas para el shadowing y un diagrama Mermaid del flujo. Se guarda como `data/interviews/<id>.proceso.md` y `.proceso.json`.
- **Generar síntesis global** combina todos los modelos individuales en una visión transversal de la cadena de valor: fases, dolores comunes, portafolio priorizado de oportunidades, contradicciones entre personas y recomendaciones para el shadowing. Se guarda como `data/interviews/sintesis-global.md` y `.json`.

## Resultados

Cada turno se guarda automáticamente en:

`data/interviews/`

Al terminar se generan tres archivos con el mismo identificador:

- `.md` — documento legible y preparado para trabajar;
- `.txt` — texto plano;
- `.json` — datos estructurados para análisis posterior.

La transcripción se puede corregir desde la propia interfaz antes de descargarla.

## Generar la voz de GitHub Pages

Con una clave válida guardada en `.env.local`, genera o actualiza todos los MP3 y el manifiesto con:

```bash
npm run generate:voice
```

El proceso usa `gpt-4o-mini-tts` y `marin`, y guarda únicamente los audios publicados en `public/audio/openai-marin-v1/`. Para regenerar un clip concreto o ajustar la concurrencia:

```bash
npm run generate:voice -- --only=demo-operaciones:intro --force
npm run generate:voice -- --concurrency=3
```

La clave se lee solo desde el entorno local y nunca se escribe en el manifiesto.

## Privacidad del MVP

- En el modo local Realtime, el audio viaja en tiempo real a OpenAI para mantener la conversación.
- En ese modo, OpenAI procesa también el nombre, cargo, área, contexto y preguntas necesarios para personalizarla.
- En GitHub Pages, la voz de la entrevistadora es audio generado por IA y publicado previamente; la página no envía las respuestas a OpenAI.
- En **Probar el recorrido** y en GitHub Pages, el reconocimiento hablado puede usar el servicio de voz del navegador; siempre se puede responder por escrito.
- El servidor local no guarda audio.
- Solo se conserva la transcripción y la ficha de la entrevista.
- La pantalla pide consentimiento antes de empezar.
- La configuración de la clave solo acepta conexiones desde este ordenador.
- El servidor está fijado a `127.0.0.1` y rechaza otros hosts u orígenes.

Antes de usarlo con empleados reales hay que definir formalmente finalidad, acceso, plazo de conservación y borrado conforme a la política de privacidad de Leroy Merlin.

## Comprobaciones

```bash
npm run check
npm test
```

El modo **Probar el recorrido** permite revisar la interfaz, la secuencia de preguntas y las exportaciones sin hacer llamadas nuevas a la API de OpenAI. En Pages reproduce los audios de OpenAI ya publicados.

## Fuentes técnicas y visuales

- [OpenAI Realtime con WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [Modelo GPT‑Realtime‑1.5](https://developers.openai.com/api/docs/models/gpt-realtime-1.5)
- [Texto a voz de OpenAI](https://developers.openai.com/api/docs/guides/text-to-speech)
- [Opciones de voz de Realtime](https://developers.openai.com/api/docs/guides/realtime-conversations#voice-options)
- [Detección de voz y control manual de turnos](https://developers.openai.com/api/docs/guides/realtime-vad)
- [Eventos de Realtime](https://developers.openai.com/api/reference/resources/realtime/server-events)
- [Recursos gráficos oficiales de Leroy Merlin](https://corporativo.leroymerlin.es/recursos-graficos)
- [Web actual de Leroy Merlin España](https://www.leroymerlin.es/)
