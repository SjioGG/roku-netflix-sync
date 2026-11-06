# Cloud-hosted relay for the Roku + Chrome sync room.
#
# The relay keeps no Roku connection of its own: a home-LAN `roku_client.py`
# bridges ECP traffic through /roku-bridge/*. Set SYNC_TOKEN at run time so the
# room token survives restarts.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    SYNC_HOST=0.0.0.0 \
    SYNC_PORT=8766 \
    ROKU_BRIDGE_ONLY=1

WORKDIR /app

# Stdlib-only relay: no dependency install step and no build tooling in the image.
COPY sync_server.py ./

# Run unprivileged; port 8766 is above 1024 so no capabilities are needed.
RUN useradd --create-home --shell /usr/sbin/nologin relay
USER relay

EXPOSE 8766

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python3 -c "import urllib.request,os;a=urllib.request.Request('http://127.0.0.1:'+os.environ.get('SYNC_PORT','8766')+'/sync',headers={'Authorization':'Bearer '+os.environ['SYNC_TOKEN']});urllib.request.urlopen(a,timeout=2)"

CMD ["python3", "sync_server.py"]
