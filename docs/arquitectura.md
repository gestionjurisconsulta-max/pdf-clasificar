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

## Los datos son efímeros y están aislados por sesión

La aplicación **no guarda nada**. Un trabajo empieza al subir el Excel de
clientes y termina al descargar el ZIP: en ese momento el servidor borra los PDF
subidos, los documentos generados, las miniaturas y la propia lista de clientes.

No hay inicio de sesión, pero tampoco una base común. Cada navegador recibe un
identificador anónimo de 32 caracteres en una cookie `HttpOnly`, y todo lo que
sube queda atado a él. Hace falta incluso dentro de un mismo despacho: dos
personas manejan listas de clientes distintas, y sin aislamiento la segunda
vería los clientes de la primera y podría descargarse su ZIP cambiando el
número en la URL.

El identificador **no identifica a nadie**: sólo separa un trabajo de otro.
Sólo se aceptan los que ha emitido el servidor (32 hex), de modo que no sirve
ponerlo a mano.

Todas las consultas filtran por sesión, incluidas las miniaturas y los endpoints
de corrección. Un id de otra persona devuelve 404, no 403: no se confirma
siquiera que exista.

Los trabajos abandonados —quien sube un PDF y nunca descarga— caducan a las
`PURGE_AFTER_HOURS` horas (24 por defecto). El barrido se ejecuta al arrancar y
cada vez que se crea un lote, para no montar un planificador sólo para eso.

## Modelo de datos

- **clients** — clientes receptores. La clave real es `(session_id,
  cif_canonical)`: el CIF normalizado con las confusiones típicas de OCR (B↔8,
  G↔6, O↔0, I/L↔1, S↔5), único **dentro de cada sesión**. Es lo que permite
  subir varios Excel sin duplicar (`B12345678` y `B-12.345.678` son el mismo
  cliente) sin impedir que dos personas tengan el mismo cliente en sus listas.
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
   ZIP con la estructura `Facturas/<cliente>/` y `Albaranes/<cliente>/` **y
   borra todo**.

El ZIP se arma entero en memoria antes de borrar nada: servirlo leyendo del
disco mientras se borra daría una descarga incompleta. Y el borrado va en un
`BackgroundTask`, que se ejecuta después de enviar la respuesta: si el navegador
corta la descarga a mitad, no se llega a borrar y el trabajo sigue ahí para
reintentarlo.

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
| GET | `/api/sources/{id}/pages/{n}/image` | Imagen de una página; `?zoom=true` la da a más resolución |
| PATCH | `/api/documents/{id}` | Corrige cliente, tipo o número |
| POST | `/api/documents/{id}/split` | Parte el documento por una página |
| POST | `/api/documents/{id}/merge-next` | Lo une con el siguiente del mismo PDF |

Documentación interactiva en `/api/docs` (la genera FastAPI).

## Revisar y corregir un lote

La detección automática acierta la mayoría de las veces, pero no siempre, y una
factura en la carpeta equivocada cuesta más que el rato que ahorra. Por eso todo
lo que decide el pipeline se puede corregir después:

- **Cambiar el cliente** de un documento, o dejarlo pendiente.
- **Cambiar el tipo** entre factura y albarán.
- **Partir** un documento por una página, cuando la detección unió dos que no
  iban juntos.
- **Unir** un documento con el siguiente del mismo PDF, cuando una hoja de
  continuación quedó suelta.

Cada corrección **regenera el PDF** en la carpeta que le toca y borra el
anterior: sin eso, cambiar el cliente de una factura dejaba una copia huérfana
en la carpeta de antes y el ZIP salía con el documento duplicado. Si la carpeta
anterior se queda vacía, se elimina.

Las páginas se ven como miniaturas servidas por
`/api/sources/{id}/pages/{n}/image`, que se rasterizan bajo demanda y se
cachean en disco. Una página de un PDF ya subido no cambia nunca, así que se
sirven con `Cache-Control: immutable`.

Corregir el cliente a mano quita la marca de ambiguo: la duda ya está resuelta.

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

El proyecto vive en `/opt/pdf-clasificar` y se publica en
`https://gestion.pdf.iages.es` a través del nginx del host. El procedimiento
completo está en [despliegue.md](despliegue.md); aquí sólo el porqué de las
decisiones que afectan a la arquitectura:

- **Nada escucha fuera de la máquina.** `frontend` publica en
  `${HTTP_BIND:-127.0.0.1}`, y `backend` y `db` no publican puerto alguno. Quien
  habla con internet es el nginx del host, que además pone el TLS.
- **La API no tiene autenticación.** El aislamiento por sesión evita que dos
  personas se vean entre sí, pero no impide que un tercero use el servicio. Si
  el subdominio no debe estar abierto, el vhost admite `auth_basic`.
- **Techo de CPU, memoria y logs.** El VPS aloja otros proyectos, y el OCR es lo
  único de esta pila capaz de comerse la máquina entera. Los límites están en
  `docker-compose.yml` y se ajustan desde `.env`.
- **No hace falta copia de seguridad**: no hay nada que conservar. Los datos
  viven lo que dura un trabajo. Lo único que conviene vigilar es que el volumen
  `storage` no crezca, y de eso se encarga el barrido de trabajos abandonados.

## El frontend

`App.tsx` es una carcasa fina que elige entre dos espacios de trabajo:

- `ServerWorkspace.tsx` habla con esta API a través de `services/apiClient.ts`.
  Sube varios ficheros, sondea el estado del lote cada 2 s mientras siga
  trabajando y enseña los documentos detectados con su cliente, su tipo y el
  motivo de cada unión de páginas.
- `LocalWorkspace.tsx` es el organizador de siempre, que procesa en el
  navegador. Se mantiene porque resuelve otro problema: revisar un documento
  página a página.

Las rutas de la API son **relativas** (`/api/...`). En producción las sirve
nginx; en desarrollo, el `server.proxy` de `vite.config.ts`. Así no hay ninguna
URL de servidor escrita en el código ni en el build.

El proxy de desarrollo enruta las rutas una a una (`/api/health`,
`/api/clients`, `/api/batches`) en lugar de todo `/api`, porque el plugin
`gemini-proxy` atiende `/api/analyze-invoice` dentro del propio servidor de
Vite y un proxy genérico se lo llevaría al backend de Python, que no lo tiene.

### La lógica está en dos sitios

La clasificación existe en TypeScript (para el modo local) y en Python (para el
servidor), con los mismos casos de prueba en los dos lados. Es el precio de
mantener los dos modos. Si el modo local deja de hacer falta, el borrado de la
versión TypeScript es directo; mientras tanto, **un cambio de criterio hay que
hacerlo en los dos.**

La detección de albaranes es la excepción: sólo existe en Python. El modo local
trata todo como facturas.
