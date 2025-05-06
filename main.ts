import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parse as parseHTML } from "node-html-parser";
import initCycleTLS from "cycletls";
import { CloudflareResponse, Ligne, Arret, HoraireResult } from "./type.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import exitHook from "exit-hook";
import { config } from "dotenv";

config({})
// Global cookies and user-agent for Cloudflare
let cycletls: initCycleTLS.CycleTLSClient;
let globalCloudflareCookies: Record<string, string> = {};
let globalCloudflareUserAgent: string = "";

async function InitializeCloudflareBaseCache() {
  const baseApi = process.env.BASE_API;
  if (!baseApi) throw new Error("BASE_API env variable is required");
  const response = await fetch(`${baseApi}/browser/get`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SCRAPPER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session_id: "",
      url: "https://www.ratp.fr/horaires",
      actions: [],
      cookies: [],
    }),
  });
  if (!response.ok) {
    console.log(await response.text());
    throw new Error(`Failed create browser: ${response.statusText}`);
  }
  const json = (await response.json()) as CloudflareResponse;
  globalCloudflareCookies = json.cookies.reduce((acc, cookie) => {
    acc[cookie.name] = cookie.value;
    return acc;
  }, {} as Record<string, string>);
  globalCloudflareUserAgent = json.userAgent || "Mozilla/5.0";
  console.log(`${process.env.BASE_API}${json.screenshot}`);
}

// Bus Service Class
class BusService {
  async getLigne(ligne: number): Promise<Ligne> {
    const url = `https://www.ratp.fr/horaires/api/getLinesAutoComplete/busnoctilien/${ligne}?to=fo&cache=true`;
    const resp = await this.getCloudflare(url);

    const json = JSON.parse(resp) as any[];
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
    const resp = await this.getCloudflare(url);
    const json = JSON.parse(resp) as any[];
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
    const resp = await this.getCloudflare(url);
    const rawText = resp;
    const processedText = rawText.replace(/\\"/g, '"').replace(/\\\//g, "/");
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
    const resp = await this.getCloudflare(url);
    if (resp.includes("Just a moment...")) {
      throw new Error("Cloudflare protection detected in response");
    }
    const json = JSON.parse(resp);
    return json.perturbation || null;
  }

  async getCloudflare(url: string): Promise<string> {
    let retried = false;
    while (true) {
      try {
        const response = await cycletls(url, {
          body: "",
          cookies: globalCloudflareCookies,
          userAgent: globalCloudflareUserAgent,
          ja3: "771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-24-25-256-257,0",
        });
        var out = response.body;
        if (typeof out != "string") {
          try {
            out = JSON.stringify(out);
          } catch (e) {
            console.log("Error decoding response:", e);
            throw new Error("Failed to decode response from Cloudflare");
          }
        }
        if (out.includes("Just a moment...")) {
          throw new Error("Cloudflare protection detected in response");
        }
        return out;
      } catch (err: any) {
        if (
          !retried &&
          err instanceof Error &&
          err.message === "Cloudflare protection detected in response"
        ) {
          retried = true;
          await InitializeCloudflareBaseCache();
          // On retry once with new cookies
          continue;
        }
        // On renvoie l'erreur après une tentative de refresh
        throw err;
      }
    }
  }
}

// MCP server and tools
const server = new McpServer({
  name: "RATP Bus Info",
  version: "1.0.0",
});

const busService = new BusService();

server.tool(
  "getBusLine",
  {
    lineNumber: z.number().int().positive(),
  },
  async ({ lineNumber }) => {
    try {
      const ligne = await busService.getLigne(lineNumber);
      const arrets = await busService.getArrets(ligne);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                nom: ligne.nom,
                id: ligne.id,
                nombre: ligne.nombre,
                picto: ligne.picto,
                plan: ligne.plan,
                pdfplan: ligne.pdfplan,
                arrets: arrets.map((a) => ({
                  status: a.status,
                  name: a.name,
                  id: a.id,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${String(error)}` }] };
    }
  }
);

server.tool(
  "getBusStopSchedule",
  {
    lineNumber: z.number().int().positive(),
    stopId: z.string(),
    date: z.string().optional(),
    time: z.string().optional(),
  },
  async ({ lineNumber, stopId, date, time }) => {
    try {
      const currentDate = new Date();
      const formattedDate =
        date ||
        `${currentDate.getFullYear()}-${String(
          currentDate.getMonth() + 1
        ).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;
      const formattedTime =
        time ||
        `${String(currentDate.getHours()).padStart(2, "0")}:${String(
          currentDate.getMinutes()
        ).padStart(2, "0")}`;
      const ligne = await busService.getLigne(lineNumber);
      const arret = await busService.getArretById(ligne, stopId);
      if (!arret) {
        return {
          content: [
            {
              type: "text",
              text: `Stop ID ${stopId} not found for line ${lineNumber}`,
            },
          ],
        };
      }
      const horaires = await busService.getHoraire(
        arret,
        formattedDate,
        formattedTime
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(horaires, null, 2),
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${String(error)}` }] };
    }
  }
);

server.tool(
  "getBusLineStatus",
  {
    lineNumber: z.number().int().positive(),
  },
  async ({ lineNumber }) => {
    try {
      const perturbation = await busService.getPerturbation(lineNumber);
      return {
        content: [
          {
            type: "text",
            text: perturbation
              ? JSON.stringify(perturbation, null, 2)
              : "No perturbations reported",
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${String(error)}` }] };
    }
  }
);

server.tool(
  "searchBusStopByName",
  {
    lineNumber: z.number().int().positive(),
    stopName: z.string(),
  },
  async ({ lineNumber, stopName }) => {
    try {
      const ligne = await busService.getLigne(lineNumber);
      await busService.getArrets(ligne);
      const matchingStops = ligne.arrets.filter((arret) =>
        arret.name.toLowerCase().includes(stopName.toLowerCase())
      );
      if (matchingStops.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No stops found matching "${stopName}" for line ${lineNumber}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              matchingStops.map((a) => ({
                id: a.id,
                name: a.name,
                status: a.status,
              })),
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${String(error)}` }] };
    }
  }
);

async function main() {
  cycletls = await initCycleTLS.default();
  await InitializeCloudflareBaseCache();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

exitHook(() => {
  console.log("Exiting...");
  cycletls.exit().then(() => {
    console.log("CycleTLS exited");
  });
});
main();
