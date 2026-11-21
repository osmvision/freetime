# freetime on the web (phones, tablets, browsers): the Rust server plus the app's own UI.
# Any container host can run it; render.yaml sets it up on Render. It listens on $PORT.
#
#   docker build -t freetime-web .
#   docker run --rm -p 10000:10000 freetime-web      ->  http://localhost:10000

# 1. The browser side: the sign-in bundle, the service worker and the offline file list.
FROM node:26-bookworm-slim AS ui
WORKDIR /app
COPY desktop/ui desktop/ui
COPY web web
RUN cd web && npm ci && npm run build

# 2. The server. It looks for the UI at a path fixed when it is compiled (/app/web/../desktop/ui),
#    so the final image keeps that same layout.
FROM rust:1-bookworm AS server
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY core core
COPY cli cli
COPY desktop desktop
COPY web web
# A faster build on a small builder: no link-time optimisation, parallel code generation.
ENV CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
RUN cargo build --release --locked -p freetime-web

# 3. What runs: the binary, the generated browser files and the UI. No compiler, no sources.
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 freetime
COPY --from=server /app/target/release/freetime-web /usr/local/bin/freetime-web
COPY --from=ui /app/web/dist /app/web/dist
COPY web/public /app/web/public
COPY desktop/ui /app/desktop/ui
WORKDIR /app/web
USER freetime
ENV PORT=10000
EXPOSE 10000
CMD ["sh", "-c", "FREETIME_WEB_BIND=0.0.0.0:${PORT} exec freetime-web"]
