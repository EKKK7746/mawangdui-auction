FROM node:18-alpine

WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm install --production

COPY server/ ./
COPY client/ /app/client/

EXPOSE 3000

CMD ["node", "index.js"]
