# Northflank / any container host build for the Ocean Sandbox web service.
FROM node:20-alpine

# PORT is deliberately not pinned here: with it unset the server binds both
# 8080 and 3000, so whichever port the host routes to reaches the app. Set
# PORT (or PORTS, comma-separated) to override.
ENV NODE_ENV=production \
    HOST=0.0.0.0

WORKDIR /app

# Install production dependencies first so the layer is cached between builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

USER node
EXPOSE 8080 3000

CMD ["node", "server.js"]
