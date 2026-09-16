#!/usr/bin/env bash
#
# Despliega o actualiza PdfClasificar en el VPS.
#
#   cd /opt/pdf-clasificar && ./scripts/deploy.sh
#
# Es idempotente: se puede ejecutar tantas veces como haga falta. No toca nada
# fuera de este proyecto, para no romper los demás que comparten el VPS.

set -euo pipefail

cd "$(dirname "$0")/.."
RAIZ="$PWD"

rojo()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
info()  { printf '\033[36m==>\033[0m %s\n' "$*"; }

PULL=1
for arg in "$@"; do
    case "$arg" in
        --no-pull) PULL=0 ;;
        -h|--help)
            sed -n '2,10p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *)
            rojo "Opción desconocida: $arg"
            exit 1 ;;
    esac
done

# --- Comprobaciones previas -------------------------------------------------
# Todas antes de tocar nada: es preferible parar aquí que a medio despliegue,
# con la pila caída y la causa enterrada en el log de compose.

command -v docker >/dev/null 2>&1 || { rojo "Falta docker."; exit 1; }
docker compose version >/dev/null 2>&1 || {
    rojo "Falta el plugin 'docker compose' (v2). El 'docker-compose' antiguo no sirve: este fichero usa 'name:' y anclas."
    exit 1
}

if [ ! -f .env ]; then
    rojo "No hay .env. Cópialo de la plantilla y rellena POSTGRES_PASSWORD:"
    rojo "    cp .env.example .env && \${EDITOR:-nano} .env"
    exit 1
fi

# Sin contraseña, compose aborta con el mensaje de la variable ':?', que es
# correcto pero llega después de haber reconstruido las imágenes.
if ! grep -qE '^POSTGRES_PASSWORD=.+' .env; then
    rojo "POSTGRES_PASSWORD está vacía en .env. Genera una con: openssl rand -base64 32"
    exit 1
fi

# tail -1 porque gana la última si está repetida, igual que hace compose, y el
# sed quita un posible comentario al final de la línea.
PUERTO="$(grep -E '^HTTP_PORT=' .env | tail -1 | cut -d= -f2 | sed -E 's/#.*//' | tr -d '[:space:]')"
PUERTO="${PUERTO:-8080}"

# En un VPS compartido el choque de puertos es el fallo más probable, y Docker
# sólo lo descubre al final: después de reconstruir las imágenes y con la mitad
# de la pila ya levantada. Comprobarlo aquí cuesta nada y falla en el acto.
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PUERTO "; then
    # Que el puerto esté ocupado por NUESTRO frontend de un despliegue anterior
    # es normal: compose lo va a reemplazar.
    MIO="$(docker compose port frontend 80 2>/dev/null || true)"
    case "$MIO" in
        *":$PUERTO") ;;
        *)
            rojo "El puerto $PUERTO ya está ocupado en esta máquina, y no por este proyecto:"
            ss -ltnp 2>/dev/null | grep ":$PUERTO " >&2
            rojo "Elige otro en HTTP_PORT del .env (y cámbialo también en el vhost de nginx)."
            rojo "Para encontrar el primero libre:"
            rojo "    for p in \$(seq $PUERTO $((PUERTO + 50))); do ss -ltn | grep -q \":\$p \" || { echo \$p; break; }; done"
            exit 1 ;;
    esac
fi

# --- Actualizar el código ---------------------------------------------------

if [ "$PULL" -eq 1 ] && [ -d .git ]; then
    if [ -n "$(git status --porcelain)" ]; then
        rojo "Hay cambios locales sin commitear en $RAIZ. Resuélvelos antes de desplegar:"
        git status --short >&2
        exit 1
    fi
    info "Actualizando el código"
    # --ff-only: si alguien ha commiteado en el VPS, es mejor fallar que
    # abrir un merge a ciegas en producción.
    git pull --ff-only
fi

# --- Levantar la pila -------------------------------------------------------

info "Construyendo y arrancando los contenedores"
# --wait no devuelve el control hasta que los healthchecks pasan, así que si
# este comando termina bien, la aplicación responde de verdad.
docker compose up -d --build --wait --wait-timeout 300

# --- Comprobación real ------------------------------------------------------

info "Comprobando la API en 127.0.0.1:$PUERTO"
if curl --fail --silent --show-error --max-time 15 "http://127.0.0.1:$PUERTO/api/health" >/dev/null; then
    info "Listo. La aplicación responde en 127.0.0.1:$PUERTO"
else
    rojo "La pila arrancó pero /api/health no responde. Revisa:"
    rojo "    docker compose logs --tail 50"
    exit 1
fi

# Sólo las capas huérfanas de esta reconstrucción. Nunca 'prune -a' ni
# 'system prune': en un VPS compartido se llevaría por delante las imágenes de
# los proyectos que estén parados en ese momento.
info "Limpiando capas huérfanas"
docker image prune -f >/dev/null
