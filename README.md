# Escucha · entrevistas IA para Leroy Merlin

MVP local para realizar entrevistas por voz con `gpt-realtime-2.1`, una guía distinta para cada persona y guardado automático de la transcripción.

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

La clave estándar se guarda solo en `.env.local` y nunca se incluye en el HTML. El navegador recibe de OpenAI una credencial temporal para establecer la conexión WebRTC.

## Cargar personas y preguntas

En **Ajustes → Personas** puedes descargar una plantilla JSON y cargar la lista real. Cada ficha requiere:

- nombre, cargo y área;
- contexto privado para ajustar el tono;
- entre 12 y 15 preguntas personalizadas;
- duración orientativa entre 15 y 30 minutos.

El archivo activo es `data/interviewees.json`. El MVP incluye tres perfiles ficticios para probar Operaciones, Datos y Personas.

## Resultados

Cada turno se guarda automáticamente en:

`data/interviews/`

Al terminar se generan tres archivos con el mismo identificador:

- `.md` — documento legible y preparado para trabajar;
- `.txt` — texto plano;
- `.json` — datos estructurados para análisis posterior.

La transcripción se puede corregir desde la propia interfaz antes de descargarla.

## Privacidad del MVP

- El audio viaja en tiempo real a OpenAI para mantener la conversación.
- OpenAI procesa también el nombre, cargo, área, contexto y preguntas necesarios para personalizarla.
- En **Probar el recorrido**, el reconocimiento hablado puede usar el servicio de voz del navegador; siempre se puede responder por escrito.
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

El modo **Probar el recorrido** permite revisar la interfaz, la secuencia de preguntas y las exportaciones sin consumir la API de OpenAI.

## Fuentes técnicas y visuales

- [OpenAI Realtime con WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [Modelo GPT‑Realtime‑2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
- [Eventos de Realtime](https://developers.openai.com/api/reference/resources/realtime/server-events)
- [Recursos gráficos oficiales de Leroy Merlin](https://corporativo.leroymerlin.es/recursos-graficos)
- [Web actual de Leroy Merlin España](https://www.leroymerlin.es/)
