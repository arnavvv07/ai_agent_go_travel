# Render builds this file. It installs Node, the agent, and the Chromium browser the agent controls.
FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
RUN npx playwright install --with-deps chromium
COPY . .
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "agent-server.js"]
