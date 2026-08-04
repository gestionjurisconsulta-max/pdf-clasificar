import { InvoicePageData } from "../types";

// La llamada real a Gemini ocurre en el servidor (ver vite.config.ts, plugin
// gemini-proxy) para que la API key nunca llegue al navegador.
export const analyzeInvoicePage = async (base64Image: string): Promise<InvoicePageData> => {
  const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');
  const res = await fetch('/api/analyze-invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64Image: cleanBase64 })
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Error del servidor (${res.status}) al analizar la página con IA.`);
  }

  const { text } = await res.json();

  try {
    const data = JSON.parse(text?.trim() || '{}');
    return {
      invoiceNumber: String(data.invoiceNumber || ''),
      cif: data.cif ? String(data.cif).replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : '',
      isContinuation: Boolean(data.isContinuation)
    };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error("Error parsing Gemini response:", errorMessage);
    return { invoiceNumber: '', cif: '', isContinuation: false };
  }
};
