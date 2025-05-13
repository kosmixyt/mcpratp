import {
  cycletls,
  getCloudflare,
  globalCloudflareCookies,
  globalCloudflareUserAgent,
  InitializeCloudflareBaseCache,
} from "./main.js";
import { Arret, HoraireResult, Ligne } from "./type.js";
import { parse as parseHTML } from "node-html-parser";

// Bus Service Class
export class BusService {
  async getLigne(ligne: number): Promise<Ligne> {
    const url = `https://www.ratp.fr/horaires/api/getLinesAutoComplete/busnoctilien/${ligne}?to=fo&cache=true`;
    const resp = await getCloudflare(url);
    try {
      var json = JSON.parse(resp) as any[];
    } catch (e) {
      console.error("Error parsing JSON:", e);
      console.error(resp);
    }
    if (!json || json.length !== 1) {
      throw new Error(`Line not found: ${ligne}`);
    }
    const item = json[0];
    return {
      nom: item.name,
      id: item.id,
      nombre: parseInt(item.code),
      picto: "https://www.ratp.fr" + item.pictoV2,
      plan: "https://www.ratp.fr" + item.pngPlan,
      pdfplan: "https://www.ratp.fr" + item.pngPlan.replace("png", "pdf"),
      arrets: [],
    };
  }

  async getArrets(ligne: Ligne): Promise<Arret[]> {
    const url = `https://www.ratp.fr/horaires/api/getStopPoints/busratp/${ligne.nombre}/${ligne.id}`;
    const resp = await getCloudflare(url);
    var json: any[] = [];
    try {
      json = JSON.parse(resp) as any[];
    } catch (e) {
      console.error("Error parsing JSON:", e);
      console.error(resp);
    }
    const arrets: Arret[] = [];
    for (const arret of json) {
      arrets.push({
        status: arret.status,
        name: arret.name,
        ligne: ligne,
        id: arret.stop_place_id,
      });
    }
    ligne.arrets = arrets;
    return arrets;
  }

  async getArretById(ligne: Ligne, id: string): Promise<Arret | null> {
    if (ligne.arrets.length === 0) {
      await this.getArrets(ligne);
    }
    return ligne.arrets.find((arret) => arret.id === id) || null;
  }

  async getArretByName(ligne: Ligne, name: string): Promise<Arret | null> {
    if (ligne.arrets.length === 0) {
      await this.getArrets(ligne);
    }
    return ligne.arrets.find((arret) => arret.name === name) || null;
  }

  async getHoraire(
    arret: Arret,
    date: string,
    time: string
  ): Promise<HoraireResult> {
    const url = `https://www.ratp.fr/horaires/blocs-horaires-next-passages/busratp/${
      arret.ligne.id
    }/${arret.id}?stopPlaceName=${encodeURIComponent(
      arret.name
    )}&type=later&departure_date=${date}&departure_time=${time}`;
    const resp = await getCloudflare(url);
    // const rawText = resp;
    // decode utf-8
    const processedText = decodeURIComponent(escape(resp));
    const root = parseHTML(processedText);
    const results: HoraireResult = {};
    const containers = root.querySelectorAll(".ixxi-horaire-result-timetable");
    for (const container of containers) {
      const destTag = container.querySelector(".destination_label");
      if (!destTag) continue;
      const destination = destTag.textContent.trim();
      const tables = container.querySelectorAll(
        ".timetable.no_train_network.is_busratp"
      );
      if (tables.length < 2) continue;
      const passageTimes: string[] = [];
      const timeCells = tables[0].querySelectorAll(
        "tr.body-busratp td.time_label"
      );
      for (const cell of timeCells) {
        passageTimes.push(cell.textContent.trim());
      }
      let premier: string | null = null,
        dernier: string | null = null;
      const row = tables[1].querySelector("tr.body-rer");
      if (row) {
        const firstWrap = row.querySelector(".first-wrap");
        const lastWrap = row.querySelector(".last-wrap");
        if (firstWrap) premier = firstWrap.textContent.trim();
        if (lastWrap) dernier = lastWrap.textContent.trim();
      }
      results[destination] = {
        passages: passageTimes,
        premier,
        dernier,
      };
    }
    return results;
  }

  async getPerturbation(busLine: number): Promise<string | null> {
    const url = `https://www.ratp.fr/horaires/api/getTrafficEventsLive/busratp/${busLine}`;
    const resp = await getCloudflare(url);
    if (resp.includes("Just a moment...")) {
      throw new Error("Cloudflare protection detected in response");
    }
    try {
      var json = JSON.parse(resp);
    } catch (e) {
      console.error(resp);
    }
    return json.perturbation || null;
  }
}
