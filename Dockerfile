# Debian ולא Alpine — better-sqlite3 צריך glibc, ועל musl הוא נשבר בבנייה.
# Chromium לא מותקן כאן בכוונה: הסריקה רצה על המחשב של אופק, לא בשרת.
FROM node:20-bullseye-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

EXPOSE 3000
CMD ["node", "index.js"]
