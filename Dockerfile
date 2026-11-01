FROM node:20-bookworm-slim AS build
WORKDIR /workspace
COPY SynapseDX/package*.json ./SynapseDX/
COPY SynapseDX/tsconfig.json ./SynapseDX/
COPY SynapseDX/src ./SynapseDX/src
COPY SynapseDX/sdk-js/package*.json ./SynapseDX/sdk-js/
COPY SynapseDX/sdk-js/tsconfig.json ./SynapseDX/sdk-js/
COPY SynapseDX/sdk-js/src ./SynapseDX/sdk-js/src
RUN cd SynapseDX/sdk-js && npm ci && npm run build
RUN cd SynapseDX && npm ci && npm run build

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/SynapseDX/package*.json ./
COPY --from=build /workspace/SynapseDX/node_modules ./node_modules
COPY --from=build /workspace/SynapseDX/dist ./dist
EXPOSE 8082
CMD ["node", "dist/src/server.js"]
