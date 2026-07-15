import type { NextFunction, Request, Response } from "express";

// Guardrail La Colmena (P9 roadmap 2026-H2): repara cuerpos JSON que llegan en
// Windows-1252 en vez de UTF-8.
//
// Sintoma real: los agentes headless en Windows (sobre todo los codex, via
// PowerShell 5.1 con consola cp1252) postean comentarios con acentos como bytes
// cp1252. express.json() decodifica UTF-8 con reemplazo (no lanza), asi que
// "Diseño" llega como "Dise�o" y se PERSISTE corrupto — irrecuperable una
// vez guardado (el byte original se perdio en el replacement).
//
// Estrategia: el app ya captura el buffer crudo (req.rawBody, verify callback).
// Si el body parseado contiene U+FFFD Y el buffer crudo NO es UTF-8 valido
// (TextDecoder fatal lanza), el cuerpo era cp1252: se re-decodifica byte a byte
// y se re-parsea. Si el crudo SI era UTF-8 valido, el U+FFFD venia literal en el
// contenido y se respeta. Cualquier error interno deja el request como estaba:
// el reparador jamas rompe un request.
const REPLACEMENT = "�";

// Los 27 puntos de 0x80-0x9F donde cp1252 difiere de latin1; el resto mapea 1:1
// al mismo code point.
const CP1252_HIGH: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…",
  0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
  0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’",
  0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ",
  0x9e: "ž", 0x9f: "Ÿ",
};

function decodeCp1252(buf: Buffer): string {
  let out = "";
  for (const b of buf) {
    out += b < 0x80 ? String.fromCharCode(b) : (CP1252_HIGH[b] ?? String.fromCharCode(b));
  }
  return out;
}

export function utf8RepairMiddleware(req: Request, _res: Response, next: NextFunction): void {
  try {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!raw || !req.body || typeof req.body !== "object") return next();
    if (!JSON.stringify(req.body).includes(REPLACEMENT)) return next();
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(raw);
      return next(); // el crudo era UTF-8 valido: el U+FFFD es contenido literal, no corrupcion
    } catch {
      // no era UTF-8: era cp1252 -> reparar
    }
    // Los bytes altos de cp1252 mapean a code points no-ASCII, asi que la
    // re-decodificacion no puede introducir comillas ni barras nuevas: el JSON
    // re-parseado es estructuralmente identico al que el emisor quiso mandar.
    req.body = JSON.parse(decodeCp1252(raw));
  } catch {
    // jamas romper el request por el reparador; el parse original queda en pie
  }
  next();
}
