FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    librsvg2-bin gcc g++ potrace \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* requirements.txt requirements-r2.txt ./
RUN npm install --omit=dev || npm install --omit=dev --legacy-peer-deps || true

RUN python3 -m venv /venv \
  && /venv/bin/pip install --upgrade pip \
  && /venv/bin/pip install -r requirements.txt

# Round-2 tracer (VTracer 1.0.0a4) in its own venv; only used when VECTORIZE_R2=1
RUN python3 -m venv /venv-r2 \
  && /venv-r2/bin/pip install --upgrade pip \
  && /venv-r2/bin/pip install -r requirements-r2.txt

COPY . .

ENV PATH="/venv/bin:${PATH}"
ENV INVENT_WARP_PYTHON=/venv/bin/python3
ENV DIGITIZE_PYTHON=/venv/bin/python3
ENV DIGITIZE_EXPORTER=pyembroidery
ENV VECTORIZE_R2_PYTHON=/venv-r2/bin/python3
ENV VECTORIZE_R2=1

EXPOSE 3000
CMD ["node", "server.js"]
