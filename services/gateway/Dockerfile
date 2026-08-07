FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY services/gateway/package.json services/gateway/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm install
COPY . .
RUN npm run build --workspace @doot/gateway

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/gateway/dist ./services/gateway/dist
COPY --from=build /app/services/gateway/package.json ./services/gateway/package.json
COPY --from=build /app/packages/protocol ./packages/protocol
CMD ["node", "services/gateway/dist/server.js"]
