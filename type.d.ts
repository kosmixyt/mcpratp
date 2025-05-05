// Bus API Types
export interface CloudflareResponse {
  status: number;
  headers: Record<string, string>;
  cookies: Array<{ name: string; value: string }>;
  title: string;
  userAgent: string;
  content: string;
  screenshot: string;
}

export interface Arret {
  status: number;
  name: string;
  ligne: Ligne;
  id: string;
}

export interface Ligne {
  nom: string;
  id: string;
  nombre: number;
  picto: string;
  plan: string;
  pdfplan: string;
  arrets: Arret[];
}

export interface HoraireResult {
  [destination: string]: {
    passages: string[];
    premier: string | null;
    dernier: string | null;
  };
}
