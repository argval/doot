FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/db/package.json packages/db/package.json
COPY services/gateway/package.json services/gateway/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci
COPY . .
RUN npm run build --workspace @doot/gateway

FROM node:22-alpine
WORKDIR /app
ENV GATEWAY_HOST=0.0.0.0
ENV GATEWAY_PORT=8787
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/gateway/dist ./services/gateway/dist
COPY --from=build /app/services/gateway/package.json ./services/gateway/package.json
COPY --from=build /app/packages/db ./packages/db
COPY --from=build /app/packages/protocol ./packages/protocol
EXPOSE 8787
CMD ["node", "services/gateway/dist/main.js"]
