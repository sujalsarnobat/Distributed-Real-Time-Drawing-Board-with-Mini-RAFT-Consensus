FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm install

COPY . .

# Install nodemon globally for hot-reload via bind mount
RUN npm install -g nodemon

EXPOSE 4002

# nodemon reads watch config from nodemon.json
CMD ["nodemon"]
