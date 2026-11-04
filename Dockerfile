FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=1
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
