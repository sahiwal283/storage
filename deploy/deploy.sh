#!/usr/bin/env bash
# Deploy the storage app to its LXC on pve (192.168.1.190).
# Usage: ./deploy/deploy.sh [--skip-build]
# Mirrors the tarball flow used by zoho-integration-service's deploy_ct9503.sh.
set -euo pipefail

PVE=root@192.168.1.190
CTID="${CTID:-9600}"
APP_DIR=/opt/storage-app
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS=$(date +%Y%m%d_%H%M%S)
TARBALL="storage-app_${TS}.tar.gz"

cd "$REPO_ROOT"

if [[ "${1:-}" != "--skip-build" ]]; then
  echo "==> Building frontend"
  (cd frontend && npm run build)
fi

echo "==> Packing"
tar czf "/tmp/$TARBALL" \
  --exclude='backend/venv' --exclude='__pycache__' --exclude='.git' \
  --exclude='node_modules' --exclude='._*' \
  backend deploy

echo "==> Shipping to pve"
scp -q "/tmp/$TARBALL" "$PVE:/tmp/$TARBALL"
rm "/tmp/$TARBALL"

echo "==> Installing in CT $CTID"
ssh "$PVE" "pct push $CTID /tmp/$TARBALL /tmp/$TARBALL && rm /tmp/$TARBALL && pct exec $CTID -- bash -c '
  set -euo pipefail
  mkdir -p $APP_DIR
  if [ -d $APP_DIR/backend ]; then
    tar czf /opt/storage-app-backup_${TS}.tar.gz -C $APP_DIR backend deploy 2>/dev/null || true
  fi
  tar xzf /tmp/$TARBALL -C $APP_DIR
  rm /tmp/$TARBALL
  find $APP_DIR -name \"._*\" -delete
  cd $APP_DIR/backend
  if [ ! -d venv ]; then python3 -m venv venv; fi
  ./venv/bin/pip install -q -r requirements.txt
  id -u storage >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin storage
  chown -R storage:storage $APP_DIR
  cp $APP_DIR/deploy/storage-app.service /etc/systemd/system/storage-app.service
  systemctl daemon-reload
  systemctl enable --now storage-app
  systemctl restart storage-app
  sleep 2
  systemctl is-active storage-app
  curl -fsS http://127.0.0.1:8300/healthz
'"
echo
echo "==> Deployed."
