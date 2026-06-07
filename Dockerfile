FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY index.js ./
COPY icon.png ./
COPY icon.svg ./
COPY favicon.ico ./
COPY favicon.png ./

ENV CONFIG_DIR=/data
VOLUME ["/data"]
EXPOSE 7000

ENV OPENSUBTITLES_API_KEY=""
ENV PORT=7000
# Set this to your public HTTPS URL so subtitle proxy links work correctly
# e.g. PUBLIC_URL=https://fes.gallagherhome.au
ENV PUBLIC_URL=""

CMD ["node", "index.js"]
