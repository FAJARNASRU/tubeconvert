FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    python3 \
    unzip && \
    rm -rf /var/lib/apt/lists/*

# Install Deno - recommended JavaScript runtime for yt-dlp
RUN curl -fsSL https://deno.land/install.sh | sh

ENV DENO_INSTALL=/root/.deno
ENV PATH="/root/.deno/bin:${PATH}"

# Install latest official yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Check installations during Docker build
RUN node --version && \
    deno --version && \
    yt-dlp --version

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/downloads

ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
