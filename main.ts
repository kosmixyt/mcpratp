import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { parse as parseHTML } from "node-html-parser";
import initCycleTLS from "cycletls";
import { CloudflareResponse, Ligne, Arret, HoraireResult } from "./type.js";
import exitHook from "exit-hook";
import { config } from "dotenv";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import swaggerUi from "swagger-ui-express";
import { createClient } from "@supabase/supabase-js";

config({});

// Global cookies and user-agent for Cloudflare
let cycletls: initCycleTLS.CycleTLSClient;
let globalCloudflareCookies: Record<string, string> = {};
let globalCloudflareUserAgent: string = "";

// Global variable to disable authentication
const DISABLE_AUTH = process.env.DISABLE_AUTH === "true";

// Initialise le client Supabase
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

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
    const resp = await this.getCloudflare(url);
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
    try {
      var json = JSON.parse(resp);
    } catch (e) {
      console.error(resp);
    }
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
          ja3: "772,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,17613-5-11-65037-0-65281-23-35-13-16-43-45-27-10-18-51,4588-29-23-24,0",
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

// Create Express app
const app = express();
const port = process.env.PORT || 3000;
const busService = new BusService();

// Middleware for JSON parsing
app.use(express.json());

// Serve OpenAPI YAML at /docs with Swagger UI
const openapiPath = path.join(__dirname, "openapi.yaml");
const openapiSpec = yaml.load(fs.readFileSync(openapiPath, "utf8"));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec as any));

// Endpoint to expose OpenAPI YAML as JSON
app.get("/openapi.json", (req: Request, res: Response) => {
  res.json(openapiSpec);
});

// Auth middleware
const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (DISABLE_AUTH) {
    return next();
  }
  const token = req.headers["auth-token"];
  if (!token || typeof token !== "string") {
    return res.status(401).json({ error: "Unauthorized: Missing Auth-Token" });
  }

  // Vérifie le JWT avec Supabase
  console.log("Token:", token);

  const { data, error } = await supabase
    .from("api_keys")
    .select("token_hash") // removed auth.users(*)
    .eq("token_hash", token)
    .eq("is_active", true)
    .single();
  if (error) {
    console.log("Error fetching token:", error);
    return res.status(401).json({ error: "Unauthorized: Invalid Auth-Token" });
  }
  next();
};

// Apply auth middleware to all API routes
app.use("/api", authenticate);

app.get("/api/bus/line/:lineNumber", async (req: Request, res: Response) => {
  try {
    const lineNumber = parseInt(req.params.lineNumber);
    if (isNaN(lineNumber) || lineNumber <= 0) {
      return res.status(400).json({ error: "Invalid line number" });
    }

    const ligne = await busService.getLigne(lineNumber);
    const arrets = await busService.getArrets(ligne);

    res.json({
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
    });
  } catch (error) {
    res
      .status(String(error).includes("Line not found") ? 404 : 500)
      .json({ error: String(error) });
  }
});

app.get(
  "/api/bus/line/:lineNumber/stop/:stopId/schedule",
  async (req: Request, res: Response) => {
    try {
      const lineNumber = parseInt(req.params.lineNumber);
      const stopId = req.params.stopId;
      const date = req.query.date as string | undefined;
      const time = req.query.time as string | undefined;

      if (isNaN(lineNumber) || lineNumber <= 0) {
        return res.status(400).json({ error: "Invalid line number" });
      }

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
        return res.status(404).json({
          error: `Stop ID ${stopId} not found for line ${lineNumber}`,
        });
      }
      const horaires = await busService.getHoraire(
        arret,
        formattedDate,
        formattedTime
      );
      res.json(horaires);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  }
);

app.get(
  "/api/bus/line/:lineNumber/status",
  async (req: Request, res: Response) => {
    try {
      const lineNumber = parseInt(req.params.lineNumber);
      if (isNaN(lineNumber) || lineNumber <= 0) {
        return res.status(400).json({ error: "Invalid line number" });
      }

      const perturbation = await busService.getPerturbation(lineNumber);
      res.json({
        status: perturbation ? "disrupted" : "normal",
        perturbation: perturbation || "No perturbations reported",
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  }
);

app.get(
  "/api/bus/line/:lineNumber/stops/search",
  async (req: Request, res: Response) => {
    try {
      const lineNumber = parseInt(req.params.lineNumber);
      const stopName = req.query.name as string;

      if (isNaN(lineNumber) || lineNumber <= 0) {
        return res.status(400).json({ error: "Invalid line number" });
      }

      if (!stopName) {
        return res.status(400).json({ error: "Stop name is required" });
      }

      const ligne = await busService.getLigne(lineNumber);
      await busService.getArrets(ligne);
      const matchingStops = ligne.arrets.filter((arret) =>
        arret.name.toLowerCase().includes(stopName.toLowerCase())
      );

      if (matchingStops.length === 0) {
        return res.status(404).json({
          error: `No stops found matching "${stopName}" for line ${lineNumber}`,
        });
      }

      res.json(
        matchingStops.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
        }))
      );
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  }
);

async function main() {
  console.log("Starting RATP Bus Info API server...");
  cycletls = await initCycleTLS.default();
  console.log("CycleTLS initialized");
  await InitializeCloudflareBaseCache();
  console.log("Cloudflare base cache initialized");

  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`API documentation available at http://localhost:${port}/docs`);
  });
}

exitHook(() => {
  console.log("Exiting...");
  cycletls.exit().then(() => {
    console.log("CycleTLS exited");
  });
});

main();
