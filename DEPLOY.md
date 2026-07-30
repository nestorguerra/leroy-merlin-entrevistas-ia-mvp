# Despliegue en Google Cloud Run

Guía para publicar el MVP de entrevistas con acceso por enlace personal. Región europea (RGPD) y coste prácticamente cero para decenas de entrevistas.

## Modelo de seguridad en modo público

Con `PUBLIC_MODE=1` el servidor deja de restringirse a localhost y aplica esta política:

- **Participantes**: solo con enlace personal válido (`?soy=<token>`). Con él pueden hacer su entrevista, transcribir audio y descargar su transcripción. Reciben únicamente su ficha, sin el contexto privado ni el resto de personas.
- **Administración** (`ADMIN_TOKEN`, obligatorio): historial, exportaciones, síntesis de procesos, gestión de personas y clave de OpenAI. Se accede con `https://<servicio>/?elige&admin=<ADMIN_TOKEN>`.
- Sin token válido no se puede leer ni escribir nada relevante.

## Requisitos

- Proyecto de GCP con facturación y `gcloud` autenticado.
- APIs: Cloud Run, Cloud Build, Secret Manager, Cloud Storage.

## Pasos

```bash
PROJECT=<tu-proyecto>
REGION=europe-west1
BUCKET=entrevistas-lm-datos
ADMIN_TOKEN=$(openssl rand -hex 16)   # guárdalo en un gestor de contraseñas

gcloud config set project $PROJECT
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com

# 1. Bucket europeo para datos persistentes (personas + entrevistas)
gcloud storage buckets create gs://$BUCKET --location=$REGION --uniform-bucket-level-access

# 2. Sube las personas reales (el fichero con tokens)
gcloud storage cp data/interviewees.local.json gs://$BUCKET/interviewees.local.json

# 3. Clave de OpenAI como secreto
printf '%s' 'sk-...' | gcloud secrets create openai-api-key --data-file=-

# 4. Despliegue (compila la imagen desde el Dockerfile del repo)
gcloud run deploy entrevistas-lm \
  --source . \
  --region $REGION \
  --allow-unauthenticated \
  --max-instances 1 \
  --set-env-vars "PUBLIC_MODE=1,DATA_DIR=/data,ADMIN_TOKEN=$ADMIN_TOKEN" \
  --set-secrets "OPENAI_API_KEY=openai-api-key:latest" \
  --add-volume "name=datos,type=cloud-storage,bucket=$BUCKET" \
  --add-volume-mount "volume=datos,mount-path=/data"
```

Notas:

- `--max-instances 1` evita escrituras concurrentes sobre el volumen; sobra de capacidad para decenas de entrevistas simultáneas.
- `--allow-unauthenticated` es necesario para que los enlaces personales funcionen sin cuenta de Google; la protección real son los tokens.
- El volumen GCS se monta en `/data`: ahí viven `interviewees.local.json` y `interviews/` (las respuestas). Nada de esto entra en la imagen ni en el repositorio.
- Para dominio propio: `gcloud run domain-mappings create --service entrevistas-lm --domain entrevistas.tudominio.com --region $REGION`.

## Después del despliegue

1. Copia la URL del servicio (`https://entrevistas-lm-xxxx-ew.a.run.app`).
2. Ábrela como administrador: `https://<url>/?elige&admin=<ADMIN_TOKEN>` y verifica que ves a las 15 personas.
3. Prueba un enlace personal (`https://<url>/?soy=<token>`): debe mostrar solo esa entrevista.
4. Actualiza la celda **B1** del Excel `enlaces-entrevistas-leroy-merlin.xlsx` con la URL del servicio: los 15 enlaces se regeneran solos.
5. Las transcripciones quedan en `gs://$BUCKET/interviews/`; también puedes descargarlas desde el historial como administrador.

## Actualizar personas o la aplicación

- Personas: edita y vuelve a subir `gs://$BUCKET/interviewees.local.json` (o usa Ajustes → Personas como administrador).
- Código: repite el `gcloud run deploy` desde el repo actualizado.

## Retirada al acabar la campaña

```bash
gcloud storage cp -r gs://$BUCKET/interviews ./respaldo-entrevistas   # respaldo
gcloud run services delete entrevistas-lm --region $REGION
gcloud storage rm -r gs://$BUCKET                                     # cuando ya no haga falta
```

Conforme a la política acordada: definir con Leroy Merlin finalidad, acceso, plazo de conservación y borrado antes de enviar los enlaces.
