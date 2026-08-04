
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

export interface ProcessedInvoice {
  invoiceNumber: string;
  companyName: string;
  cif: string;
  pages: { index: number; rotation: number }[];
}

export enum ProcessingStep {
  IDLE = 'IDLE',
  PREVIEW = 'PREVIEW',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}
