FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
# poppler-utils, imagemagick and libreoffice are what src/lib/documentProcessor.ts
# shells out to. Without them uploads are still accepted and still stored — they
# are just READ WORSE, silently: a PDF goes to the model unrasterised, a HEIC or
# TIFF cannot be decoded at all, and a .docx holding a scan yields nothing.
# libreoffice-writer/-calc pull in libreoffice-core (~300MB); that is the cost of
# reading a scan someone pasted into Word, which is a common way one arrives.
RUN apt-get update && apt-get install -y openssl ca-certificates poppler-utils imagemagick \
      libreoffice-writer libreoffice-calc \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --production
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src ./src
COPY --from=builder /app/next.config.mjs ./
COPY --from=builder /app/eslint.config.mjs ./
COPY --from=builder /app/jsconfig.json ./

EXPOSE 3005
CMD ["npm", "run", "start"]
