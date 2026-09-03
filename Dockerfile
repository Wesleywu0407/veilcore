# Veilcore has no dependencies and no build step -- package.json lists neither
# a dependency nor a devDependency, and the files the browser loads are the
# files in the repo. So there is no install layer, no compile layer, and
# nothing to copy out of a builder stage: this image is a Node runtime with the
# repo in it.
FROM node:22-slim

# Not root. The server reads files and opens a socket; it has no reason to be
# able to write to its own image.
WORKDIR /app
COPY --chown=node:node . .
USER node

# Informational only -- the platform decides the real one and passes it in as
# PORT, which duel-server.mjs reads first. 5174 is what it falls back to.
ENV PORT=5174
EXPOSE 5174

# The health endpoint the share script already polls, reused so the platform
# can tell a booting process from a wedged one. It reports the room count, so
# a 200 here means the WebSocket registry is alive and not merely that Node is.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5174)+'/__veilcore/health').then(r=>r.ok?0:process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/duel-server.mjs"]
