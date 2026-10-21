FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production=false || npm install
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build \
 && rm -f dist/*.test.js dist/*.test.d.ts \
 && npm prune --omit=dev \
 && chown -R node:node /app
ENV PORT=4002
EXPOSE 4002
# Least privilege: never run as root (ports >1024, no need for root).
USER node
CMD ["node", "dist/index.js"]
