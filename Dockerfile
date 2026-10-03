FROM node:20-slim AS frontend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx vite build

FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
COPY --from=frontend-builder /app/dist ./dist
EXPOSE 5000
ENV NODE_ENV=production
ENV PORT=5000
ENV DB_PATH=/app/data/bookhaven.db
VOLUME ["/app/data"]
CMD ["npx", "tsx", "server.ts"]
