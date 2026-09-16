# Arquitectura

```
                    ┌──────────────────────────────┐
  navegador ──────▶ │ frontend  (nginx + SPA)       │  puerto 8080
                    │  · sirve el build de Vite     │
                    │  · /api/* ─▶ backend          │
                    └───────────────┬──────────────┘
                                    │  red interna de compose
                    ┌───────────────▼──────────────┐
                    │ backend  (Python 3.11)        │  sin puerto publicado
                    │  · FastAPI + SQLAlchemy 2     │
                    │  · pdfplumber / pypdf         │
                    │  · Tesseract (OCR nativo)     │
                    └───────┬──────────────┬───────┘
                            │              │
                ┌───────────▼───┐   ┌──────▼────────┐
                │ db  Postgres 15│   │ volumen /data │
                │  volumen       │   │  uploads/     │
                │  db-data       │   │  documents/   │
                └────────────────┘   └───────────────┘
```

Ningún servicio salvo `frontend` publica puertos: a Postgres sólo se llega
desde dentro de la red de compose. Para inspeccionarlo desde fuera, túnel SSH
contra el VPS.

## Los tres contenedores

| Servicio | Imagen | Qué hace |
|---|---|---|
| `frontend` | nginx 1.27 alpine | Sirve la SPA compilada y hace de proxy de `/api` |
| `backend` | python 3.11 slim | API, procesado de PDF y OCR |
| `db` | postgres 15 alpine | Datos |

El backend corre como usuario sin privilegios (uid 10001): si alguien lograra
ejecutar algo a través de un PDF manipulado, no sería como root.

## Modelo de datos

- **clients** — clientes receptores. La clave real es `cif_canonical`, el CIF
  normalizado con las confusiones típicas de OCR (B↔8, G↔6, O↔0, I/L↔1, S↔5).
  Es lo que permite subir varios Excel sin duplicar: `B12345678` y
  `B-12.345.678` son el mismo cliente.
- **client_imports** — histórico de Excel subidos, con qué aportó cada uno.
- **batches** — un lote de proceso, con su estado y su progreso.
- **source_files** — cada PDF original del lote.
- **documents** — cada factura o albarán detectado, con sus páginas agrupadas,
  el cliente asignado, si hubo ambigüedad y por qué se unieron las páginas.

Las migraciones son de Alembic y se aplican solas al arrancar el backend
(`entrypoint.sh`), así que desplegar es `docker compose up -d --build`.

## El proceso de un lote

1. Se suben uno o varios PDF. La API responde **202** al momento y devuelve el
   id del lote: cerrar el navegador no interrumpe nada.
2. En segundo plano, por cada PDF:
   - se extrae el texto de cada página con pdfplumber; si una página no tiene
     capa de texto, se rasteriza y se le pasa Tesseract;
   - se decide si cada página es **factura** o **albarán**;
   - se agrupan las hojas de continuación;
   - se busca el cliente cruzando el texto con la tabla `clients`;
   - se trocea el PDF y se guarda cada documento en su carpeta.
3. `GET /api/batches/{id}` da el estado y el detalle; `/download` devuelve el
   ZIP con la estructura `Facturas/<cliente>/` y `Albaranes/<cliente>/`.

El trabajo en segundo plano usa `BackgroundTasks` de FastAPI: se ejecuta dentro
del propio proceso del backend. Es suficiente para el volumen de un despacho y
evita dos contenedores más (Redis y un worker). Si algún día hay que procesar
lotes en paralelo o sobrevivir a un reinicio a mitad de lote, el cambio es
sustituir `background.add_task(...)` por una cola; el estado del lote ya vive en
la base de datos, que es la parte difícil.

## Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/health` | Estado del servicio y de la base de datos |
| GET | `/api/clients` | Lista de clientes, con `?search=` |
| POST | `/api/clients/import` | Sube uno o varios Excel y los fusiona |
| GET | `/api/batches` | Lotes recientes |
| POST | `/api/batches` | Sube uno o varios PDF y arranca el proceso |
| GET | `/api/batches/{id}` | Estado, documentos detectados y resumen |
| GET | `/api/batches/{id}/download` | ZIP del lote |

Documentación interactiva en `/api/docs` (la genera FastAPI).

## Cómo distinguir una factura de un albarán

El criterio principal es la **cabecera**, no el recuento de palabras en toda la
página. Una factura menciona muy a menudo el albarán del que procede ("según
nuestro albarán A-3312"), así que contar apariciones falla justo en el caso más
común.

El orden de decisión es:

1. Si la cabecera menciona un albarán **y** la página liquida impuestos (dos o
   más señales de base imponible, IVA, cuota, IRPF, total factura) → **factura**.
   Un albarán lista mercancía; no calcula IVA.
2. Si la cabecera menciona un albarán → **albarán**. Si aparecen los dos
   títulos, manda el que va antes.
3. Si la cabecera menciona una factura → **factura**.
4. Sin título reconocible, decide el recuento de señales fiscales frente a las
   de entrega (bultos, transportista, recibí conforme).
5. Si no hay nada → **desconocido**.

Un cambio de tipo entre dos hojas contiguas rompe la cadena de continuación,
aunque la segunda hoja no tenga identidad propia.

## Despliegue en el VPS

```bash
git clone <repo> && cd pdf-clasificar
cp .env.example .env
# rellena POSTGRES_PASSWORD
docker compose up -d --build
```

Recomendaciones para producción:

- Publica el puerto sólo en local (`"127.0.0.1:8080:80"` en
  `docker-compose.yml`) y pon delante Caddy o Traefik para el TLS. **La API no
  tiene autenticación**: expuesta a internet, cualquiera podría subir ficheros
  y descargar los lotes.
- Haz copia del volumen `db-data` (los datos) y del volumen `storage` (los PDF).
  `docker compose exec db pg_dump -U pdfclasificar pdfclasificar` para la base.
- Los PDF procesados se acumulan en `storage`. Todavía no hay borrado
  automático de lotes antiguos.

## Lo que queda del diseño anterior

El frontend sigue siendo el de siempre: hace todo el trabajo **en el navegador**
con pdf.js, Tesseract.js y pdf-lib, y todavía no habla con esta API. Es decir,
ahora mismo la lógica de clasificación existe dos veces, en TypeScript y en
Python, con los mismos casos de prueba en los dos lados.

Eso es deliberado: primero la infraestructura, y migrar la interfaz a la API es
el paso siguiente. Hasta que se haga, la aplicación web funciona exactamente
como antes y el backend se usa por su API.
