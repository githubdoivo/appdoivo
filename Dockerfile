FROM node:24-slim

WORKDIR /app

# Instala apenas dependencias de producao
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Base de dados persistente. Aponta DB_FILE para um volume montado (ex.: /data).
# Por omissao usa /app/data/app.sqlite (efemero se nao houver volume).
ENV PORT=3000
ENV DB_FILE=/data/app.sqlite
EXPOSE 3000

CMD ["npm", "start"]
