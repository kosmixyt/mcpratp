# dont work on docker

FROM debian:bookworm

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl unzip ca-certificates gettext \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install Go
RUN curl -sSL https://golang.org/dl/go1.21.1.linux-amd64.tar.gz | tar -C /usr/local -xzf - \
    && ln -s /usr/local/go/bin/go /usr/bin/go \
    && go version

ENV GO111MODULE=off
ENV CGO_ENABLED=0
ENV GOOS=linux

WORKDIR /app

COPY . .
COPY openapi.yaml /app/openapi.yaml
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

RUN bun install \
    && chmod +x node_modules/cycletls/dist/index

ENV NODE_ENV=production
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "run", "/app/main.ts"]
