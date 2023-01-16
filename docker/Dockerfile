FROM node:16

RUN mkdir /app && mkdir /conf
RUN apt update&&apt install -y nmap curl jq&& apt clean
VOLUME /conf
WORKDIR /app

ADD *.js /app/
ADD *.json /app/
RUN chown -R node:node /app&&chown -R node:node /conf
USER node
RUN cd /app && npm install --production

ENTRYPOINT [ "node","/app/hypergate-cli.js" ]