FROM node:18-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source
COPY index.js ./

# Config is stored in /data so it can be mapped to a persistent volume
ENV CONFIG_DIR=/data
VOLUME ["/data"]

# Port the addon listens on
EXPOSE 7000

# Allow API key to be passed as environment variable
ENV OPENSUBTITLES_API_KEY=""
ENV PORT=7000

CMD ["node", "index.js"]
