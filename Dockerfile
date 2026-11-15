
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=10000 DATA_DIR=/data TRUST_PROXY=1
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 10000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:10000/healthz || exit 1
CMD ["node", "server.js"]
