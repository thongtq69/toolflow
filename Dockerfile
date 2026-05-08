# Playwright + Node — image chính thức của Microsoft đã cài đủ deps cho Chromium
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js frames.example.json projects.json ./
COPY public/ ./public/

ENV PROFILE_DIR=/app/profile
ENV PORT=3737
ENV HEADLESS=true

EXPOSE 3737

CMD ["node", "server.js"]
