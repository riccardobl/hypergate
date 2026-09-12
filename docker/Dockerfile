ARG NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

FROM ${NODE_IMAGE} AS build

WORKDIR /app
RUN chown node:node /app

COPY --chown=node:node package*.json tsconfig.json ./
COPY --chown=node:node src ./src

USER node
RUN npm ci
RUN npm run build

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN chown node:node /app

COPY --chown=node:node package*.json ./

USER node
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/build ./build

LABEL hypergate.EXCLUDE="true"

ENTRYPOINT ["node", "./build/dist/cli.js"]
