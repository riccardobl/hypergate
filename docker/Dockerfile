ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

FROM ${DEBIAN_IMAGE} AS node

# Install the security release directly: Docker Hub can lag behind nodejs.org.
COPY .node-version node-shasums256.txt /tmp/node-download/
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils libatomic1 libstdc++6; \
    cd /tmp/node-download; \
    NODE_VERSION=$(cat .node-version); \
    case "$(dpkg --print-architecture)" in \
        amd64) node_arch=x64 ;; \
        arm64) node_arch=arm64 ;; \
        ppc64el) node_arch=ppc64le ;; \
        *) echo "Unsupported Node.js architecture" >&2; exit 1 ;; \
    esac; \
    archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
        "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" --output "$archive"; \
    sha256sum --check --strict --ignore-missing node-shasums256.txt; \
    tar -xJf "$archive" -C /usr/local --strip-components=1 --no-same-owner; \
    test "$(node --version)" = "v${NODE_VERSION}"; \
    npm --version; \
    apt-get purge -y --auto-remove curl xz-utils; \
    rm -rf /var/lib/apt/lists/* /tmp/node-download; \
    groupadd --gid 1000 node; \
    useradd --uid 1000 --gid node --shell /bin/bash --create-home node

FROM node AS build

WORKDIR /app
RUN chown node:node /app

COPY --chown=node:node package*.json tsconfig.json ./
COPY --chown=node:node src ./src

USER node
RUN npm ci
RUN npm run build

FROM node AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN chown node:node /app

COPY --chown=node:node package*.json ./

USER node
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/build ./build

LABEL hypergate.EXCLUDE="true"

ENTRYPOINT ["node", "./build/dist/cli.js"]
