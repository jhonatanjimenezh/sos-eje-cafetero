import logging
import os
import socket
import struct
import time
from urllib.parse import urlparse

from minio import Minio
from minio.commonconfig import Tags

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("evidence-scanner")

ENDPOINT = os.getenv("S3_ENDPOINT", "http://minio:9000")
ACCESS_KEY = os.environ["S3_SCANNER_ACCESS_KEY"]
SECRET_KEY = os.environ["S3_SCANNER_SECRET_KEY"]
BUCKET = os.getenv("PRIVATE_EVIDENCE_BUCKET", "sos-private-evidence")
PREFIX = os.getenv("EVIDENCE_SCAN_PREFIX", "private/affected/")
CLAMAV_HOST = os.getenv("CLAMAV_HOST", "clamav")
CLAMAV_PORT = int(os.getenv("CLAMAV_PORT", "3310"))
POLL_SECONDS = float(os.getenv("EVIDENCE_SCAN_POLL_SECONDS", "2"))
TAG_KEY = "GuardDutyMalwareScanStatus"
FINAL_STATUSES = {"NO_THREATS_FOUND", "THREATS_FOUND"}

parsed = urlparse(ENDPOINT)
client = Minio(
    parsed.netloc or parsed.path,
    access_key=ACCESS_KEY,
    secret_key=SECRET_KEY,
    secure=parsed.scheme == "https",
)


def clamd_ping() -> None:
    with socket.create_connection((CLAMAV_HOST, CLAMAV_PORT), timeout=5) as sock:
        sock.sendall(b"zPING\0")
        reply = sock.recv(64)
        if b"PONG" not in reply:
            raise RuntimeError(f"clamd no respondió PONG: {reply!r}")


def scan_stream(response) -> str:
    with socket.create_connection((CLAMAV_HOST, CLAMAV_PORT), timeout=15) as sock:
        sock.settimeout(90)
        sock.sendall(b"zINSTREAM\0")
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            sock.sendall(struct.pack("!I", len(chunk)))
            sock.sendall(chunk)
        sock.sendall(struct.pack("!I", 0))
        parts = []
        while True:
            data = sock.recv(4096)
            if not data:
                break
            parts.append(data)
            if b"\0" in data:
                break
        reply = b"".join(parts).decode("utf-8", "replace").strip("\x00\r\n ")
        if reply.endswith(" OK") or reply == "stream: OK":
            return "NO_THREATS_FOUND"
        if reply.endswith(" FOUND"):
            log.warning("ClamAV detectó amenaza: %s", reply)
            return "THREATS_FOUND"
        raise RuntimeError(f"respuesta inesperada de clamd: {reply}")


def tags_for(object_name: str):
    try:
        return client.get_object_tags(BUCKET, object_name)
    except Exception:
        return None


def set_status(object_name: str, status: str) -> None:
    current = tags_for(object_name)
    tags = Tags.new_object_tags()
    if current:
        for key, value in current.items():
            tags[key] = value
    tags[TAG_KEY] = status
    client.set_object_tags(BUCKET, object_name, tags)


def scan_object(object_name: str) -> None:
    current = tags_for(object_name)
    if current and current.get(TAG_KEY) in FINAL_STATUSES:
        return

    response = None
    try:
        response = client.get_object(BUCKET, object_name)
        status = scan_stream(response)
        set_status(object_name, status)
        log.info("escaneado object=%s status=%s", object_name, status)
    except Exception as exc:
        log.exception("falló scan object=%s: %s", object_name, exc)
        try:
            set_status(object_name, "FAILED")
        except Exception:
            log.exception("no fue posible registrar FAILED para %s", object_name)
    finally:
        if response is not None:
            response.close()
            response.release_conn()


def loop() -> None:
    while True:
        try:
            clamd_ping()
            if not client.bucket_exists(BUCKET):
                log.warning("bucket %s todavía no existe", BUCKET)
            else:
                for item in client.list_objects(BUCKET, prefix=PREFIX, recursive=True):
                    if not item.is_dir:
                        scan_object(item.object_name)
        except Exception as exc:
            log.exception("ciclo de scanner falló: %s", exc)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    log.info("scanner iniciado bucket=%s prefix=%s clamav=%s:%s", BUCKET, PREFIX, CLAMAV_HOST, CLAMAV_PORT)
    loop()
