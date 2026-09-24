ARG BASE_IMAGE=node:20-bookworm
FROM ${BASE_IMAGE}

RUN apt-get update && apt-get install -y \
    git curl python3 python3-pip build-essential tmux \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally — PINNED. The provider bridge (llm-bridge/) translates
# the requests this exact CLI sends; an unpinned install lets any rebuild pull a CLI whose
# request shape nobody has run the contract test against (test/llm-bridge-contract.test.js).
# Bump deliberately, together with that test: docker build --build-arg CLAUDE_CODE_VERSION=…
ARG CLAUDE_CODE_VERSION=2.1.281
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Install opencode CLI globally — an externalAgents engine (config.json), so it
# must be baked into the image rather than installed live: /app is an image
# layer and a container recreate (redeploy, image update) wipes anything
# installed after build. The bin is `opencode`; the npm package is `opencode-ai`.
RUN npm install -g opencode-ai

WORKDIR /app

COPY package.json ./
COPY scripts/ ./scripts/
RUN npm install --production

COPY . .

RUN mkdir -p /app/data /app/workspace /app/skills /home/node/.claude \
    && touch /app/config.json \
    && chown -R node:node /app/data /app/workspace /app/skills /home/node/.claude /app/.claude \
    && chown node:node /app/config.json

VOLUME ["/app/data", "/app/workspace", "/app/skills"]

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV WORKDIR=/app/workspace

USER node

CMD ["node", "server.js"]
