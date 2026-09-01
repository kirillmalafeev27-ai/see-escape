# Northflank / any container host build for the Ocean Sandbox web service.
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

# Install production dependencies first so the layer is cached between builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

USER node
EXPOSE 8080

CMD ["node", "server.js"]
