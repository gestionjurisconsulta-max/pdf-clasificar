# PdfClasificar

Trocea un PDF con muchas facturas y reparte cada una en la carpeta de su cliente.

Todo el procesamiento ocurre en el navegador: el PDF nunca sale del equipo salvo
que se active expresamente el motor de IA, que envía la imagen de cada página
analizada a la API de Google Gemini (la app pide confirmación antes).

## Cómo funciona

1. **Clientes** — subes un Excel con la lista de clientes. La primera hoja debe
   tener una columna con el CIF/NIF y otra con el nombre. Se detectan por el
   nombre de la cabecera (`CIF`, `NIF`, `Cliente`, `Razón social`…) y, si no hay
   cabecera reconocible, inspeccionando el contenido de las primeras filas.
2. **Documento** — subes el PDF. Se genera una miniatura por página.
3. **Organizador** — puedes rotar, borrar y agrupar páginas. Dos páginas de la
   misma factura se unen seleccionándolas y pulsando *Unir*, o escribiendo el
   mismo ID manual en ambas.
4. **División** — cada bloque se analiza para averiguar a qué cliente pertenece
   y se exporta como PDF independiente, en una carpeta por cliente. Lo que no
   se ha podido identificar va a *Pendiente de asignar*.

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

### Limitaciones conocidas

- **El modo IA sólo funciona en desarrollo.** El endpoint `/api/analyze-invoice`
  vive dentro del servidor de Vite (ver `geminiProxyPlugin` en
  [vite.config.ts](vite.config.ts)), así que `npm run build` genera un sitio
  estático sin ese endpoint. Para desplegarlo hace falta una función serverless.
- **El modo IA busca el CIF del emisor**, pero la base de datos es de clientes
  receptores, así que en la mayoría de facturas no encontrará coincidencia.
- **No hay agrupación automática de páginas de continuación.** Cada página es
  una factura salvo que la agrupes a mano.
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
