FROM node:22

RUN mkdir -p /app
WORKDIR /app

COPY src ./src
COPY package*.json ./
COPY tsconfig.json ./

RUN chown -R node:node /app

USER node
RUN ls /app
RUN npm i
RUN npm run build

LABEL hypergate.EXCLUDE="true"

ENTRYPOINT [ "npm", "run", "start" , "--" ]