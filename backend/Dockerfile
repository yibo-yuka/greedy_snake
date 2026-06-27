FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# System dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy project
COPY . .

# Create non-root user for security
RUN addgroup --system snake && adduser --system --group snake
RUN chown -R snake:snake /app
USER snake

EXPOSE 8000

# Phase 4: Use Daphne (ASGI) to support HTTP + WebSocket
CMD ["daphne", "-b", "0.0.0.0", "-p", "8000", "greedy_snake.asgi:application"]
