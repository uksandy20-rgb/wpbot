FROM node:18-alpine

# Install git and system build dependencies
RUN apk add --no-cache git python3 make g++

WORKDIR /app

# Copy dependency definitions and install bot packages
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Expose Railway web port
EXPOSE 3000

# Start the bot
CMD ["node", "server.js"]
