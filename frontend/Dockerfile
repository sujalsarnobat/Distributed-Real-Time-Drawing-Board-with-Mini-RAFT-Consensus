FROM node:20-alpine

WORKDIR /app

# Use http-server to serve static files
RUN npm install -g http-server

COPY . .

EXPOSE 8080

CMD ["http-server", ".", "-p", "8080"]
