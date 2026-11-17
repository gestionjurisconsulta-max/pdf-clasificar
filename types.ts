
export interface Company {
  cif: string;
  name: string;
}

export interface InvoicePageData {
  invoiceNumber: string;
  cif: string;
  isContinuation: boolean;
  rotation?: number;
  isSelected?: boolean;
  groupId?: string;
  manualReference?: string; // Nuevo campo para agrupación manual por nombre
}

export interface LearningData {
  cifMappings: Record<string, string>;
  patterns: {
    invoiceRegex: string;
    cifRegex: string;
  };
}

/** Mismos valores que el enum `DocumentType` del backend. */
export type DocumentType = 'factura' | 'albaran' | 'desconocido';

export interface ProcessedInvoice {
  invoiceNumber: string;
  companyName: string;
  cif: string;
  /** Tipo de documento, para separar facturas de albaranes en carpetas. */
  docType: DocumentType;
  pages: { index: number; rotation: number }[];
}

export enum ProcessingStep {
  IDLE = 'IDLE',
  PREVIEW = 'PREVIEW',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}
