FROM --platform=linux/amd64 node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS javascript
FROM --platform=linux/amd64 python:3.11-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=javascript /usr/local/bin/node /usr/local/bin/node
RUN python -m venv /opt/venv
COPY qa-tools/runtime-requirements.txt /tmp/runtime-requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/runtime-requirements.txt && rm /tmp/runtime-requirements.txt
WORKDIR /app
COPY cloud/cloudflare/native-service.mjs ./cloud/cloudflare/native-service.mjs
COPY cloud/worker/native-runtime.mjs cloud/worker/reference-inspector.mjs ./cloud/worker/
COPY integration ./integration
COPY snapshot/app ./snapshot/app
RUN useradd --create-home --uid 10001 vdj && chown -R vdj:vdj /app
ENV NODE_ENV=production OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
USER vdj
EXPOSE 8080
CMD ["node", "cloud/cloudflare/native-service.mjs"]
