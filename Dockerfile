FROM debian:13.1-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux \
 && rm -rf /var/lib/apt/lists/*

COPY docker/omp-web-host.sh /usr/local/bin/omp-web-host

ENTRYPOINT ["/bin/bash", "/usr/local/bin/omp-web-host"]
