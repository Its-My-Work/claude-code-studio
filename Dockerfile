ARG BASE_IMAGE=node:20-bookworm
FROM ${BASE_IMAGE}

# Базовые пакеты
RUN apt-get update && apt-get install -y \
    git curl python3 python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/*

# Устанавливаем Claude Code CLI глобально
RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g @kilocode/cli


WORKDIR /app

# Устанавливаем только прод-зависимости сервера
COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
RUN npm install --production

# Копируем остальной код
COPY . .

# Готовим директории и конфиг
RUN mkdir -p /app/data /app/workspace /app/skills /home/node/.claude \
    && touch /app/config.json \
    && chown -R node:node /app /home/node/.claude \
    && chmod 664 /app/config.json

# Персистентные директории
VOLUME ["/app/data", "/app/workspace", "/app/skills"]

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV WORKDIR=/app/workspace

# Запускаем под пользователем node
USER node

CMD ["node", "server.js"]
