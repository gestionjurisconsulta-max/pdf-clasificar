# Despliegue en el VPS

Guía para poner PdfClasificar en un VPS que ya aloja otros proyectos, con el
nginx del host publicando en **https://gestion.pdf.iages.es**.

La premisa de todo lo que sigue es no molestar a los vecinos: el proyecto vive
en su propia carpeta bajo `/opt`, no publica ningún puerto al exterior, tiene
techo de CPU, memoria y logs, y nada de lo que se ejecuta aquí toca imágenes,
volúmenes o redes que no sean suyos.

## Qué hace falta en el VPS

| | |
|---|---|
| Docker Engine con el plugin `compose` v2 | `docker compose version` |
| nginx en el host | `nginx -v` |
| certbot | `dnf install epel-release certbot` / `apt install certbot` |
| git | `git --version` |
| Disco | ~3 GB para las imágenes, más lo que ocupen los lotes en curso |
| RAM | ~1 GB en reposo; el pico de OCR está limitado a 2 GB |

El `docker-compose` antiguo (el binario con guion, v1) no vale: el fichero usa
`name:` y anclas YAML.

## Dónde vive

```
/opt/pdf-clasificar/          <- el repositorio, tal cual
├── .env                      <- NO está en git: se crea a mano en el VPS
├── docker-compose.yml
├── scripts/deploy.sh
└── deploy/nginx/pdf-clasificar.conf
```

Los datos **no** viven en `/opt`, sino en volúmenes de Docker, que compose
prefija con el nombre del proyecto y por tanto no chocan con nada:

| Volumen | Qué guarda |
|---|---|
| `pdf-clasificar_db-data` | La base de datos |
| `pdf-clasificar_storage` | PDF subidos, documentos generados, miniaturas |

Por el mismo motivo los contenedores se llaman `pdf-clasificar-backend-1`,
`pdf-clasificar-db-1` y `pdf-clasificar-frontend-1`, y la red interna es
`pdf-clasificar_default`. Nada se llama `db` ni `backend` a secas.

## Primera instalación

### 1. Clonar

```bash
sudo mkdir -p /opt
sudo git clone https://github.com/gestionjurisconsulta-max/pdf-clasificar.git /opt/pdf-clasificar
cd /opt/pdf-clasificar
```

Si no quieres trabajar como root, haz tuya la carpeta y métete en el grupo
`docker` (cerrando y abriendo sesión después):

```bash
sudo chown -R "$USER:$USER" /opt/pdf-clasificar
sudo usermod -aG docker "$USER"
```

### 2. Configurar

```bash
cp .env.example .env
openssl rand -base64 32
```

Pega el resultado en `POSTGRES_PASSWORD`, revisa el resto y protege el fichero,
que contiene la contraseña de la base de datos:

```bash
nano .env
chmod 600 .env
```

Comprueba que el puerto de `HTTP_PORT` está libre. En un VPS con varios
proyectos, lo normal es que el 8080 ya esté cogido:

```bash
ss -ltnp | grep :8080
```

Si contesta algo, busca el primero libre y ponlo en `.env`:

```bash
for p in $(seq 8080 8130); do ss -ltn | grep -q ":$p " || { echo "primer puerto libre: $p"; break; }; done
```

`deploy.sh` lo comprueba también antes de construir, así que no te dejará
llegar a medio despliegue para descubrirlo. El vhost se ajusta solo al puerto
del `.env` en el paso 7.

### 3. Arrancar

```bash
./scripts/deploy.sh
```

El script comprueba los requisitos, construye las imágenes, espera a que los
healthchecks pasen y llama a `/api/health`. Si termina sin error, la aplicación
ya responde en el puerto que pusiste — todavía sólo desde dentro del VPS. El
propio script lo dice en su última línea.

### 4. El DNS

Un registro `A` de `gestion.pdf.iages.es` a la IP del VPS. Compruébalo antes de
pedir el certificado, porque Let's Encrypt limita los intentos fallidos:

```bash
dig +short gestion.pdf.iages.es
```

### 5. Dónde van los vhosts en tu distro

Las dos familias colocan la configuración de nginx en sitios distintos, y los
pasos siguientes usan esta variable para no depender de ello. Elige la línea
que corresponda:

```bash
# Debian / Ubuntu
VHOST=/etc/nginx/sites-available/pdf-clasificar.conf
```

```bash
# Rocky / AlmaLinux / RHEL
VHOST=/etc/nginx/conf.d/pdf-clasificar.conf
```

En Debian y Ubuntu hace falta además un enlace en `sites-enabled` para
activarlo; en Rocky y derivados no, porque `nginx.conf` ya incluye
`/etc/nginx/conf.d/*.conf` entero.

### 6. El certificado

Es el paso con trampa: el vhost definitivo tiene un bloque `listen 443` que
referencia un certificado que aún no existe, y nginx se niega a arrancar si le
falta un fichero — lo que tumbaría también a los demás proyectos del VPS. Por
eso primero va un vhost temporal que sólo sirve el desafío de ACME.

```bash
sudo mkdir -p /var/www/certbot
```

```bash
printf 'server {
    listen 80;
    server_name gestion.pdf.iages.es;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 404; }
}
' | sudo tee "$VHOST"
```

Sólo en Debian y Ubuntu, activarlo:

```bash
sudo ln -sf "$VHOST" /etc/nginx/sites-enabled/
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Si no tienes certbot: en Debian y Ubuntu es `apt install certbot`; en Rocky,
`dnf install epel-release && dnf install certbot`, porque vive en EPEL.

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d gestion.pdf.iages.es
```

### 7. El vhost definitivo

Ya con el certificado en su sitio, se sustituye por el del repositorio. El
`sed` ajusta el `proxy_pass` al puerto que tengas en `.env`: el fichero viene
con 8080, y si tuviste que cambiarlo porque otro proyecto lo ocupaba, sin esto
el resultado es un 502 desconcertante.

```bash
PUERTO=$(grep -E '^HTTP_PORT=' /opt/pdf-clasificar/.env | tail -1 | cut -d= -f2 | tr -d '[:space:]')
```

```bash
sed "s|proxy_pass http://127.0.0.1:8080;|proxy_pass http://127.0.0.1:${PUERTO:-8080};|" /opt/pdf-clasificar/deploy/nginx/pdf-clasificar.conf | sudo tee "$VHOST" >/dev/null
```

Comprueba que quedó el puerto correcto antes de recargar:

```bash
grep proxy_pass "$VHOST"
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` antes del reload no es adorno: si la configuración tiene un error y
recargas igual, se cae el nginx que sirve a todos los proyectos.

Certbot deja instalado su propio temporizador de renovación. El bloque
`/.well-known/acme-challenge/` del vhost definitivo está puesto antes de la
redirección a HTTPS precisamente para que las renovaciones sigan funcionando.
Puedes ensayarla sin gastar cuota:

```bash
sudo certbot renew --dry-run
```

### 8. SELinux (sólo Rocky, AlmaLinux y RHEL)

Estas distribuciones traen SELinux en `enforcing`, y por defecto **prohíben a
nginx abrir conexiones de red**. El síntoma es un 502 en el que la aplicación
está perfectamente viva: `curl` desde la propia máquina funciona, pero a través
de nginx no, y en `/var/log/nginx/error.log` aparece un `Permission denied` al
conectar con `127.0.0.1`.

Compruébalo y, si está activo, permite la conexión:

```bash
getenforce
```

```bash
sudo setsebool -P httpd_can_network_connect 1
```

El `-P` hace el cambio permanente; sin él se pierde al reiniciar. Es un
booleano de SELinux, no una regla para este puerto: afecta a todo lo que sirva
nginx en la máquina.

### 9. El cortafuegos

Al exterior sólo se abren 80 y 443. El puerto de la aplicación no: ya está
atado a `127.0.0.1`, pero si algún día alguien pone `HTTP_BIND=0.0.0.0` en
`.env`, el cortafuegos es la segunda línea de defensa.

En Rocky, AlmaLinux y RHEL:

```bash
sudo firewall-cmd --permanent --add-service=http --add-service=https && sudo firewall-cmd --reload
```

En Debian y Ubuntu:

```bash
sudo ufw allow 'Nginx Full' && sudo ufw status
```

Listo: **https://gestion.pdf.iages.es**

## Quién puede entrar

Conviene tenerlo claro antes de dar la dirección a nadie: **la aplicación no
tiene inicio de sesión**. Cada navegador trabaja aislado de los demás con un
identificador anónimo, así que nadie ve los ficheros de otro ni puede
descargarse su ZIP —eso está resuelto—, pero cualquiera que conozca la URL puede
usar el servicio: subir PDF, gastar CPU de OCR y llenar el disco del VPS.

Si el subdominio no debe quedar abierto, la forma más sencilla es una
contraseña en el propio nginx. Instala `apache2-utils` y crea el fichero:

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-pdf-clasificar despacho
```

Y descomenta las dos líneas `auth_basic` del bloque `location /` del vhost
(están ahí puestas para esto) antes de recargar:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Protege la aplicación entera, `/api` incluida, y el navegador reenvía las
credenciales en las llamadas de la SPA sin que haya que tocar nada del código.
No sustituye a un inicio de sesión de verdad —la contraseña es una sola para
todos—, pero deja el servicio fuera del alcance de quien pase por ahí.

## Si usas Nginx Proxy Manager

Si el VPS publica los proyectos con NPM en vez de con un nginx a pelo, olvida
los pasos 5 a 9 y crea un *Proxy Host*:

| Campo | Valor |
|---|---|
| Domain Names | `gestion.pdf.iages.es` |
| Scheme | `http` |
| Forward Hostname / IP | la IP del host en `docker0`, normalmente `172.17.0.1` |
| Forward Port | `8080` |
| Websockets Support | no hace falta |
| SSL | *Request a new certificate* + *Force SSL* + *HTTP/2* |

Dos cosas que NPM no trae bien por defecto para esta aplicación, y que van en
*Advanced → Custom Nginx Configuration*:

```nginx
client_max_body_size 200M;
proxy_read_timeout 600s;
proxy_send_timeout 600s;
proxy_request_buffering off;
```

Sin lo primero, las subidas grandes dan 413. Sin lo segundo, un lote con OCR
que tarde más de un minuto muere con un 504 aunque el backend siga trabajando.

Ojo: NPM corre dentro de un contenedor, así que `127.0.0.1` allí es él mismo, no
el host. Si prefieres no depender de la IP de `docker0`, conecta el contenedor
`pdf-clasificar-frontend-1` a la red de NPM y apunta al nombre del contenedor.

Con NPM, además, `HTTP_BIND=127.0.0.1` no basta: el contenedor de NPM no llega
a la interfaz local del host. Usa `HTTP_BIND=172.17.0.1` para publicar sólo en
la interfaz de `docker0`, que sigue sin estar expuesta a internet.

## Actualizar

```bash
cd /opt/pdf-clasificar && ./scripts/deploy.sh
```

Hace `git pull --ff-only`, reconstruye lo que haya cambiado y espera a los
healthchecks. Las migraciones de la base de datos las aplica el propio backend
al arrancar, así que no hay ningún paso manual.

Corta el servicio unos segundos, mientras los contenedores se reemplazan. Si
prefieres revisar antes qué va a entrar:

```bash
git fetch && git log --oneline HEAD..@{u}
```

Y si sólo quieres reconstruir sin traer nada nuevo:

```bash
./scripts/deploy.sh --no-pull
```

## Operación diaria

Todos los comandos se ejecutan desde `/opt/pdf-clasificar`, y `docker compose`
sólo actúa sobre este proyecto.

| | |
|---|---|
| Estado | `docker compose ps` |
| Logs en vivo | `docker compose logs -f backend` |
| Últimas 100 líneas | `docker compose logs --tail 100` |
| Reiniciar | `docker compose restart` |
| Parar | `docker compose stop` |
| Arrancar | `docker compose start` |
| Consumo | `docker stats --no-stream $(docker compose ps -q)` |
| Ocupación de los datos | `docker system df -v` |

Los contenedores llevan `restart: unless-stopped`, así que vuelven solos tras un
reinicio del VPS. No hace falta ninguna unidad de systemd.

Si paras con `docker compose stop`, siguen parados tras un reinicio hasta que
los arranques a mano: es justo lo que quiere decir `unless-stopped`.

## Copias de seguridad

**De los datos de la aplicación no hace falta ninguna.** Son efímeros a
propósito: un trabajo empieza al subir el Excel y termina al descargar el ZIP,
momento en el que el servidor borra los PDF, los documentos y la lista de
clientes; lo que alguien deja a medias caduca a las `PURGE_AFTER_HOURS`. En la
base de datos no hay nada que valga la pena conservar de un día para otro.

Lo único irreemplazable es el `.env`, porque contiene la contraseña de la base
de datos. Guárdalo donde guardes el resto de secretos del VPS.

Si aun así quieres una copia puntual de la base de datos:

```bash
docker compose exec -T db pg_dump -U pdfclasificar pdfclasificar | gzip > ~/pdf-clasificar-$(date +%F).sql.gz
```

## Problemas frecuentes

**502 Bad Gateway.** Tres causas, por orden de probabilidad. La primera: el
puerto del vhost no coincide con `HTTP_PORT` del `.env` (`grep proxy_pass` en
el vhost lo enseña). La segunda, sólo en Rocky, AlmaLinux y RHEL con SELinux en
`enforcing`: nginx tiene prohibido conectar por red y hace falta
`sudo setsebool -P httpd_can_network_connect 1`; se reconoce porque `curl` a
`127.0.0.1:PUERTO` funciona desde la máquina y a través de nginx no, con un
`Permission denied` en `/var/log/nginx/error.log`. La tercera: la pila no está
en pie (`docker compose ps`). Y si el vhost dice `localhost` en vez de
`127.0.0.1`, nginx puede resolver a `::1`, donde el contenedor no escucha.

**413 Request Entity Too Large.** Hay tres límites en serie y manda el más bajo:
`MAX_UPLOAD_BYTES` en `.env`, `client_max_body_size` en `docker/nginx.conf` (el
del contenedor) y `client_max_body_size` en el vhost del host. Súbelos los tres.

**504 Gateway Time-out con lotes grandes.** Falta subir `proxy_read_timeout` en
el vhost del host. El backend sigue trabajando; es nginx quien se cansa.

**El backend se reinicia solo.** Probablemente el OOM killer. Confírmalo con
`docker inspect pdf-clasificar-backend-1 --format '{{.State.OOMKilled}}'` y sube
`BACKEND_MEMORY` en `.env`.

**`port is already allocated` al desplegar.** Otro proyecto del VPS ocupa ese
puerto. Cambia `HTTP_PORT` en `.env` y el `proxy_pass` del vhost.

**`detected dubious ownership in repository`.** Clonaste con `sudo` y ahora
ejecutas `git` con otro usuario. Lo correcto es darle la carpeta a ese usuario
(`sudo chown -R "$USER:$USER" /opt/pdf-clasificar`), no añadir la excepción a
`safe.directory`: si el repositorio sigue siendo de root, el `git pull` del
despliegue tampoco podrá escribir.

**La pila no arranca y el log del backend habla de la base de datos.** Suele ser
que `POSTGRES_PASSWORD` cambió después de crear el volumen: Postgres fija la
contraseña al inicializarse y no la actualiza sola. O recuperas la antigua, o
borras el volumen (`docker compose down -v`), que con datos efímeros no cuesta
nada.

**Se llena el disco.** Los logs están limitados a 30 MB por contenedor, así que
casi siempre son imágenes viejas de *otros* proyectos. `docker system df` lo
enseña. No lances `docker system prune -a` en un VPS compartido: se lleva las
imágenes de todo lo que esté parado en ese momento.

## Desinstalar

```bash
cd /opt/pdf-clasificar && docker compose down -v
```

`-v` borra también los volúmenes de datos, y sólo los de este proyecto.

```bash
sudo rm -rf /opt/pdf-clasificar
```

```bash
sudo rm -f /etc/nginx/conf.d/pdf-clasificar.conf /etc/nginx/sites-enabled/pdf-clasificar.conf /etc/nginx/sites-available/pdf-clasificar.conf
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

```bash
sudo certbot delete --cert-name gestion.pdf.iages.es
```
