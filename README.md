# PdfClasificar

Trocea PDF con muchas facturas y albaranes y reparte cada documento en la
carpeta de su cliente.

La aplicación tiene **dos modos**, y se cambia entre ellos con el selector de la
cabecera. La elección se recuerda; si no hay ninguna guardada, arranca en
Servidor cuando la API responde y en Local cuando no.

| | Servidor | Local |
|---|---|---|
| Dónde se procesa | En el backend (Python) | En tu navegador |
| Cuántos ficheros | Varios Excel y varios PDF a la vez | Un PDF |
| Separa albaranes | Sí | No |
| Revisión visual | No | Sí: miniaturas, rotar, borrar, agrupar |
| Histórico | No: se borra al descargar el ZIP | No, se pierde al recargar |
| Necesita servidor | Sí | No |

**Servidor** es el modo para el día a día en el VPS: subes los Excel de clientes
y los PDF del mes, y el backend los trocea, separa facturas de albaranes y los
reparte por cliente. Puedes revisar el resultado y corregir el cliente, el tipo
o el troceado antes de descargar.

**No guarda nada.** Al descargar el ZIP, el servidor borra los PDF, los
documentos generados y la lista de clientes. No hay inicio de sesión, pero cada
navegador trabaja aislado de los demás mediante un identificador anónimo: dos
personas pueden usarlo a la vez sin verse. Ver
[docs/arquitectura.md](docs/arquitectura.md).

**Local** es el modo para cuando hace falta ojo humano sobre un documento
concreto: enseña una miniatura por página y deja rotar, borrar y agrupar a mano
antes de trocear. El fichero no sale del equipo, salvo que se active
expresamente el motor de IA (la app pide confirmación antes).

## Arrancar con Docker

```bash
cp .env.example .env    # y rellena POSTGRES_PASSWORD
docker compose up -d --build
```

La aplicación queda en http://localhost:8080 y la API en
http://localhost:8080/api (documentación interactiva en `/api/docs`).

El puerto sólo escucha en la interfaz local. Para abrirlo a tu red, pon
`HTTP_BIND=0.0.0.0` en `.env`.

## Desplegar en el VPS

El proyecto vive en `/opt/pdf-clasificar` y se publica en
**https://gestion.pdf.iages.es** a través del nginx del host. Está pensado para
convivir con otros proyectos en la misma máquina: no expone ningún puerto al
exterior, los volúmenes y contenedores van prefijados con el nombre del
proyecto, y hay techo de CPU, memoria y logs.

```bash
sudo git clone https://github.com/gestionjurisconsulta-max/pdf-clasificar.git /opt/pdf-clasificar
```

```bash
cd /opt/pdf-clasificar && cp .env.example .env && ./scripts/deploy.sh
```

El mismo comando sirve para actualizar. Los pasos completos —certificado,
vhost, cortafuegos y qué mirar cuando algo falla— están en
[docs/despliegue.md](docs/despliegue.md).

## Cómo funciona

1. **Clientes** — subes un Excel con la lista de clientes. La primera hoja debe
   tener una columna con el CIF/NIF y otra con el nombre. Se detectan por el
   nombre de la cabecera (`CIF`, `NIF`, `Cliente`, `Razón social`…) y, si no hay
   cabecera reconocible, inspeccionando el contenido de las primeras filas.
2. **Documento** — subes el PDF. Se genera una miniatura por página.
3. **Organizador** — puedes rotar, borrar y agrupar páginas. Dos páginas de la
   misma factura se unen seleccionándolas y pulsando *Unir*, o escribiendo el
   mismo ID manual en ambas.
4. **División** — con el motor local, primero se detectan las facturas de varias
   hojas (ver abajo). Después cada bloque se analiza para averiguar a qué
   cliente pertenece y se exporta como PDF independiente, en una carpeta por
   cliente. Lo que no se ha podido identificar va a *Pendiente de asignar*.

El resultado se descarga como ZIP o, en navegadores con File System Access API
(Chrome y Edge), se escribe directamente en una carpeta local que elijas.

## Los dos motores

| | OCR LOCAL (por defecto) | AI GEMINI |
|---|---|---|
| Dónde se procesa | En tu navegador | Se envía la imagen a Google |
| Qué busca | Cualquier CIF de tu lista en el texto de la página | El CIF del emisor de la factura |
| Requiere red | Sólo para descargar el motor de OCR de páginas escaneadas | Sí |
| Requiere API key | No | Sí |

El motor local extrae el texto embebido del PDF y, si la página es una imagen
escaneada, le pasa OCR con Tesseract. Cuando un CIF encaja con más de un cliente
la página se marca como ambigua y va a *Pendiente de asignar*, en vez de
asignarla al primero que coincida.

## Facturas de varias hojas

Con el motor local, las hojas que no son una factura por sí solas se unen
automáticamente a la anterior. Una hoja se considera continuación si:

- dice explícitamente ser la página 2 o posterior (*"Página 2 de 3"*), o lleva
  una frase de continuación; **o**
- repite el mismo número de factura que la hoja anterior; **o**
- no tiene número de factura propio y no aporta ningún CIF que no se hubiera
  visto ya en esa factura; **o**
- no tiene texto legible.

Y nunca se une si dice ser la página 1, si trae otro número de factura, si
aparece un CIF nuevo, o si no va **físicamente pegada** a la hoja anterior
(borrar una página rompe la cadena a propósito).

Cada unión queda justificada en el log detallado, con el motivo concreto. Si
prefieres el comportamiento antiguo, el interruptor *Facturas de varias hojas*
del panel lateral lo desactiva y vuelve a una factura por hoja.

La agrupación manual (*Unir* o el ID manual) sigue teniendo prioridad: lo que
tú agrupes no pasa por la detección automática.

### Limitaciones conocidas

- **El modo IA sólo funciona en desarrollo.** El endpoint `/api/analyze-invoice`
  vive dentro del servidor de Vite (ver `geminiProxyPlugin` en
  [vite.config.ts](vite.config.ts)), así que `npm run build` genera un sitio
  estático sin ese endpoint. Para desplegarlo hace falta una función serverless.
- **El modo IA busca el CIF del emisor**, pero la base de datos es de clientes
  receptores, así que en la mayoría de facturas no encontrará coincidencia.
- **En modo IA no hay detección de continuaciones**, porque se apoya en el texto
  que extrae el motor local. Con IA, cada página es una factura salvo que la
  agrupes a mano. El campo `isContinuation` que devuelve Gemini no se usa.
- **Dos facturas seguidas del mismo cliente se separan por su número.** Si el
  número no se llega a leer en la primera hoja de la segunda factura, podrían
  unirse por error. El log detallado permite detectarlo.
- **Tesseract descarga su motor de `cdn.jsdelivr.net`** la primera vez que hace
  falta OCR, así que esa parte no funciona sin conexión.

## Desarrollo

Requiere Node.js 20 o superior.

```bash
npm install
cp .env.example .env.local   # y rellena GEMINI_API_KEY si vas a usar el modo IA
npm run dev
```

La app queda en http://localhost:3010.

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Build de producción en `dist/` |
| `npm run preview` | Sirve el build, incluido el proxy de Gemini |
| `npm run test` | Tests unitarios (Vitest) |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript en modo estricto |
| `npm run check` | Los tres anteriores |

### El backend

Requiere Python 3.11. Lo normal es trabajar con los contenedores, pero para
iterar rápido sobre la lógica:

```bash
cd backend
pip install -e ".[dev]"
python -m pytest tests -q
```

Los tests de `backend/tests/` son los mismos casos que `services/*.test.ts`:
si tocas la lógica en un lado, el otro tiene que seguir dando lo mismo.

Para levantar sólo la base de datos y correr la API en local:

```bash
docker compose up -d db
cd backend
DATABASE_URL=postgresql+psycopg://pdfclasificar:TU_PASSWORD@localhost:5432/pdfclasificar   STORAGE_DIR=./.data alembic upgrade head
uvicorn app.main:app --reload
```

(Para esto hace falta publicar el puerto de `db` en `docker-compose.yml`, que
por seguridad viene sin publicar.)

### La API key

`GEMINI_API_KEY` se lee en `vite.config.ts` y se usa sólo en el proceso de
Node: el navegador habla únicamente con `/api/analyze-invoice`, del mismo
origen, y nunca recibe la clave.

El servidor de desarrollo escucha sólo en `localhost` porque ese endpoint no
pide autenticación y cualquiera en tu red podría gastar tu cuota. Si necesitas
abrirlo a la red local, pon `DEV_HOST=0.0.0.0` en `.env.local`.

### Los assets de pdf.js

`vite.config.ts` incluye un plugin que sirve los cmaps, fuentes estándar e
imágenes WASM de pdf.js desde `node_modules`, y los copia a `dist/` al compilar,
junto con un `.htaccess` que fuerza los tipos MIME correctos en hostings Apache.
Sin esto, los PDF escaneados se renderizan en blanco y el worker de pdf.js queda
bloqueado sin lanzar ningún error. Los comentarios del fichero explican el
porqué de cada decisión: conviene leerlos antes de tocarlo.
