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
export interface LineTram {
  id: string;
  code: string;
  color: string;
  name: string;
  label: string;
  pdfHoraire: string;
  pdfHoraireFileSize: string;
  pdfHoraireFutur: string;
  pdfHoraireFuturFileSize: string;
  dateAppliHoraireFutur: string;
  pdfHoraireRetour: string;
  pdfHoraireRetourFileSize: string;
  pdfHoraireRetourFutur: string;
  pdfHoraireRetourFuturFileSize: string;
  dateAppliHoraireRetourFutur: string;
  pdfPlan: string;
  pdfPlanFileSize: string;
  pdfPlanFutur: string;
  pdfPlanFuturFileSize: string;
  pngPlan: string;
  pngPlanFutur: string;
  dateAppliPlanFutur: string;
  picto: string;
  nameAller: any;
  nameRetour: any;
}
export interface HoraireResult {
  [destination: string]: {
    passages: string[];
    premier: string | null;
    dernier: string | null;
  };
}

// ja3: "772,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,17613-5-11-65037-0-65281-23-35-13-16-43-45-27-10-18-51,4588-29-23-24,0", /net
// ja3: "771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-24-25-256-257,0" / cycletls
// ja3: "772,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,65037-65281-17613-11-35-45-51-18-27-13-10-0-23-5-43-16,4588-29-23-24,0" / net
