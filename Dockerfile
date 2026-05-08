# Playwright + Node — image chính thức của Microsoft đã cài đủ deps cho Chromium
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js auth-setup.js test-gen.js frames.example.json ./
COPY public/ ./public/

ENV PROFILE_DIR=/app/profile
ENV OUTPUT_DIR=/app/output
ENV FRAMES_PATH=/app/frames.json
ENV PORT=3737
ENV HEADLESS=true

EXPOSE 3737

CMD ["node", "server.js"]
