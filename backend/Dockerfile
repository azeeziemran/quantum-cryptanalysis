FROM python:3.13-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends tcpdump \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 7070

CMD ["gunicorn", "--bind", "0.0.0.0:7070", "--workers", "1", "--worker-class", "gthread", "--threads", "100", "--access-logfile", "-", "--error-logfile", "-", "app:app"]
