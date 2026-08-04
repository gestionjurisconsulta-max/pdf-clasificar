import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'path';
import { defineConfig, loadEnv, type Plugin, type Connect } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { GoogleGenAI, Type } from '@google/genai';

export const PDFJS_ASSET_ROUTE = '/pdfjs-assets/';
const PDFJS_ASSET_DIRS = ['wasm', 'cmaps', 'standard_fonts', 'iccs'];

// El worker se sirve con extensión .js (y NO como asset con hash de Vite)
// porque muchos servidores estáticos no conocen `.mjs` y lo devuelven como
// `text/plain`; Chrome bloquea entonces el módulo, pdf.js cae al "fake worker"
// y `getDocument()` se queda colgado sin lanzar ningún error.
export const PDFJS_WORKER_FILE = 'pdf.worker.min.js';
const PDFJS_WORKER_SOURCE = path.join('legacy', 'build', 'pdf.worker.min.mjs');

const MIME_BY_EXT: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/octet-stream'
};

// pdf.js 5.x descarga por HTTP su decodificador WASM (JBIG2/CCITT — necesario
// para los PDF de escáner), los cmaps y las fuentes estándar. Se sirven desde
// node_modules para que siempre coincidan con la versión instalada y para que
// la app funcione sin conexión a un CDN.
function pdfjsAssetsPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  let outDir = 'dist';

  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url || '';
    if (!url.startsWith(PDFJS_ASSET_ROUTE)) return next();

    const raw = decodeURIComponent(url.slice(PDFJS_ASSET_ROUTE.length).split('?')[0]);
    const rel = raw === PDFJS_WORKER_FILE ? PDFJS_WORKER_SOURCE : raw;
    const filePath = path.resolve(pdfjsRoot, rel);
    if (!filePath.startsWith(pdfjsRoot + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    res.setHeader('Content-Type', MIME_BY_EXT[path.extname(filePath)] || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  };

  return {
    name: 'pdfjs-assets',
    configResolved(config) { outDir = config.build.outDir; },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
    closeBundle() {
      const assetsOut = path.join(outDir, PDFJS_ASSET_ROUTE.slice(1));
      for (const dir of PDFJS_ASSET_DIRS) {
        fs.cpSync(path.join(pdfjsRoot, dir), path.join(assetsOut, dir), { recursive: true });
      }
      fs.mkdirSync(assetsOut, { recursive: true });
      fs.copyFileSync(path.join(pdfjsRoot, PDFJS_WORKER_SOURCE), path.join(assetsOut, PDFJS_WORKER_FILE));
    }
  };
}

function readJsonBody(req: Connect.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// Keeps the Gemini API key server-side only: the browser never receives it,
// it only ever talks to this same-origin endpoint.
function geminiProxyPlugin(apiKey: string): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url !== '/api/analyze-invoice' || req.method !== 'POST') return next();

    (async () => {
      if (!apiKey) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'GEMINI_API_KEY no está configurada en .env.local' }));
        return;
      }

      const body = await readJsonBody(req);
      const base64Image: string = body?.base64Image || '';

      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
            {
              text: "Analiza esta página de factura y extrae el número de factura, el CIF del emisor de la factura y determina si esta página es la continuación de la página anterior (por ejemplo, si no tiene cabecera o si indica 'Página 2')."
            }
          ]
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              invoiceNumber: { type: Type.STRING, description: 'El número identificador de la factura. Déjalo vacío si no se encuentra.' },
              cif: { type: Type.STRING, description: 'El CIF o NIF de la empresa que emite la factura (ej: B12345678).' },
              isContinuation: { type: Type.BOOLEAN, description: 'Verdadero si es una página de continuación de la misma factura, falso si es el inicio de una nueva factura.' }
            },
            required: ['invoiceNumber', 'cif', 'isContinuation']
          }
        }
      });

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ text: response.text ?? '' }));
    })().catch((err) => {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  };

  return {
    name: 'gemini-proxy',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    }
  };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react(), tailwindcss(), pdfjsAssetsPlugin(), geminiProxyPlugin(env.GEMINI_API_KEY)],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
