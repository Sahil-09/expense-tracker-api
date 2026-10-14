# Multi-stage so the runtime image carries no compiler, no dev dependencies and no source.
FROM node:24-alpine AS build
RUN npm install -g pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build

FROM node:24-alpine
RUN npm install -g pnpm
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=build /app/dist ./dist
# Runs unprivileged: the image has nothing that needs root, and this is a box holding
# bank messages.
USER node
EXPOSE 3000
CMD ["node", "dist/main"]