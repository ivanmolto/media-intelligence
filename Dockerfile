# One image for the `init`, `web` and `test` services. It keeps dev dependencies:
# `init` runs the TypeScript scripts with tsx and `test` runs Vitest.
FROM node:24-alpine

ENV NEXT_TELEMETRY_DISABLED=1
RUN mkdir /app && chown node:node /app
WORKDIR /app
USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

COPY --chown=node:node . .
RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "start"]
