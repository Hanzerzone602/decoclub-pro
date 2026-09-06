FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    librsvg2-bin gcc g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* requirements.txt ./
RUN npm install --omit=dev || npm install --omit=dev --legacy-peer-deps || true

RUN python3 -m venv /venv \
  && /venv/bin/pip install --upgrade pip \
  && /venv/bin/pip install -r requirements.txt

COPY . .

ENV PATH="/venv/bin:${PATH}"
ENV INVENT_WARP_PYTHON=/venv/bin/python3

EXPOSE 3000
CMD ["node", "server.js"]
