FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
RUN mkdir -p /app/data /app/camera && chown -R node:node /app/data /app/camera
USER node
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3080/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
