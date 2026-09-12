# Upgrade to Node 20 to satisfy package engine requirements
FROM node:20-alpine

# Install git, python, build-base, and native canvas/graphics C++ dependencies
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    build-base \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev \
    pixman-dev \
    pkgconfig

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
