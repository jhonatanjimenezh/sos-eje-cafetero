FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
RUN pip install --no-cache-dir minio==7.2.20
COPY scanner.py /app/scanner.py

USER nobody
CMD ["python", "/app/scanner.py"]
