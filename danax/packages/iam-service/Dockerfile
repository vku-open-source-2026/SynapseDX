FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production=false || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
ENV PORT=4001
EXPOSE 4001
CMD ["node", "dist/index.js"]
