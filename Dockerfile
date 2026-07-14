FROM node:24-alpine

# Install Chromium, FFmpeg, and dependencies for Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    ffmpeg \
    font-noto-emoji

# Tell Puppeteer to skip downloading chromium and use the system one
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY package.json .
COPY package-lock.json .

RUN npm ci

COPY . .
CMD ["node", "index.js"]
