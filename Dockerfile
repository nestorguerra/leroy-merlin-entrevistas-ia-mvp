# Entrevistas IA · imagen para Cloud Run (sin dependencias npm)
FROM node:20-slim

WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
COPY data/interviewees.json data/interviewees.template.json ./data/

ENV NODE_ENV=production
# Cloud Run inyecta PORT; PUBLIC_MODE y ADMIN_TOKEN se definen en el servicio.
EXPOSE 8080
CMD ["node", "server.mjs"]
