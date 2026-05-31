FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY src/ ./src/
COPY bin/ ./bin/

RUN mkdir -p data

EXPOSE 8118

CMD ["node", "src/server.js"]
