FROM node:20-alpine

WORKDIR /app

# Copy dependency specifications first for caching
COPY gateway/package*.json ./gateway/
COPY replica1/package*.json ./replica1/
COPY replica2/package*.json ./replica2/
COPY replica3/package*.json ./replica3/

# Install production dependencies
RUN cd gateway && npm install --omit=dev
RUN cd replica1 && npm install --omit=dev
RUN cd replica2 && npm install --omit=dev
RUN cd replica3 && npm install --omit=dev

# Copy application source code
COPY frontend ./frontend
COPY gateway ./gateway
COPY replica1 ./replica1
COPY replica2 ./replica2
COPY replica3 ./replica3
COPY start.sh ./start.sh

# Ensure start script has execution permissions
RUN chmod +x ./start.sh

# Render exposes PORT env var at runtime (defaults to 10000)
EXPOSE 10000

CMD ["/app/start.sh"]
