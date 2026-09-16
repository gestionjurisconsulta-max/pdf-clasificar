import enum


class DocumentType(str, enum.Enum):
    FACTURA = "factura"
    ALBARAN = "albaran"
    DESCONOCIDO = "desconocido"


class BatchStatus(str, enum.Enum):
    PENDIENTE = "pendiente"
    PROCESANDO = "procesando"
    COMPLETADO = "completado"
    FALLIDO = "fallido"
