FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production=false || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && rm -f dist/*.test.js dist/*.test.d.ts \
  && npm prune --omit=dev \
  && chown -R node:node /app
ENV PORT=4009
EXPOSE 4009
USER node
CMD ["node", "dist/index.js"]
