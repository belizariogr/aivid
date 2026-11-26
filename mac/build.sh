#!/bin/sh
# Gera dist/Takes.app. Uso: sh mac/build.sh [--install]
#   --install instala em /Applications (aparece no Spotlight e no Launchpad).
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
APP="$ROOT/dist/Takes.app"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "→ Compilando o app nativo"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
swiftc -O -swift-version 5 -target arm64-apple-macos14 \
  -framework Cocoa -framework WebKit \
  "$ROOT/mac/Takes.swift" -o "$APP/Contents/MacOS/Takes"

echo "→ Copiando servidor e interface"
cp -R "$ROOT/server" "$ROOT/public" "$ROOT/package.json" "$APP/Contents/Resources/app/"
sed "s/__VERSION__/$VERSION/g" "$ROOT/mac/Info.plist" > "$APP/Contents/Info.plist"

echo "→ Gerando o ícone"
swiftc -O "$ROOT/mac/icon.swift" -o "$WORK/icon" -framework AppKit
"$WORK/icon" "$WORK/icon.png"
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$WORK/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

echo "→ Assinando (ad-hoc, uso local)"
codesign --force --deep --sign - "$APP" >/dev/null

if [ "${1:-}" = "--install" ]; then
  DEST=/Applications/Takes.app
  # Fecha o app aberto sem perder nada: o servidor sai deixando o LTX terminar a geração atual
  # (o Takes reaberto a recupera e segue a fila), e o app fecha sem o aviso de tarefas em andamento.
  if pgrep -f "Takes.app/Contents/MacOS/Takes" >/dev/null; then
    curl -s --max-time 5 -X POST http://127.0.0.1:4477/api/shutdown -H "X-Takes: 1" -H "Content-Type: application/json" -d '{"cancel":false}' >/dev/null || true
    for _ in $(seq 1 20); do pgrep -f "Takes.app/Contents/Resources/app/server/index.js" >/dev/null || break; sleep 0.5; done
    osascript -e 'tell application id "com.belizariogr.takes" to quit' >/dev/null 2>&1 || true
    for _ in $(seq 1 40); do pgrep -f "Takes.app/Contents/MacOS/Takes" >/dev/null || break; sleep 0.5; done
  fi
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  # Versões antigas instaladas na pasta do usuário.
  rm -rf "$HOME/Applications/Takes.app"
  echo "✓ Instalado em $DEST"
else
  echo "✓ $APP"
fi
