import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import initCycleTLS from "cycletls";
import { CloudflareResponse, Ligne, Arret, HoraireResult } from "./type.js";
import exitHook from "exit-hook";
import { config } from "dotenv";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import swaggerUi from "swagger-ui-express";
import { createClient } from "@supabase/supabase-js";
import { BusService } from "./bus.js";
import { TramService } from "./tram.js";

config({});

export async function getCloudflare(url: string): Promise<string> {
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

// Global cookies and user-agent for Cloudflare
export let cycletls: initCycleTLS.CycleTLSClient;
export let globalCloudflareCookies: Record<string, string> = {};
export let globalCloudflareUserAgent: string = "";

// Global variable to disable authentication
const DISABLE_AUTH = process.env.DISABLE_AUTH === "true";

// Initialise le client Supabase
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

export async function InitializeCloudflareBaseCache() {
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

// Create Express app
const app = express();
const port = process.env.PORT || 3000;
const busService = new BusService();
const tram = new TramService();

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

app.get("/api/tram/list", async (req: Request, res: Response) => {
  try {
    const lignes = await tram.getLignes();
    res.json(lignes);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get("/api/tram/line/:lineNumber", async (req: Request, res: Response) => {
  try {
    const lineNumber = req.params.lineNumber;
    const arrets = await tram.getArrets(lineNumber as any);
    res.json(arrets);
  } catch (error) {
    res
      .status(String(error).includes("Line not found") ? 404 : 500)
      .json({ error: String(error) });
  }
});
app.get(
  "/api/tram/line/:lineNumber/status",
  async (req: Request, res: Response) => {
    try {
      const lineNumber = req.params.lineNumber;
      const perturbation = await tram.getPerturbation(lineNumber as any);
      res.json(perturbation);
    } catch (error) {
      res
        .status(String(error).includes("Line not found") ? 404 : 500)
        .json({ error: String(error) });
    }
  }
);
app.get(
  "/api/tram/line/:lineId/:stopId/schedule",
  async (req: Request, res: Response) => {
    try {
      const lineId = req.params.lineId;
      const stopId = req.params.stopId;
      const date = req.query.date ?? "";
      const time = req.query.time ?? "";
      const data = await tram.getPassages(
        lineId as any,
        stopId,
        date as string,
        time as string
      );
      const horaires: HoraireResult = {};
      for (const [destination, value] of Object.entries(data)) {
        horaires[destination] = {
          passages: value.passages,
          premier: value.premier,
          dernier: value.dernier,
        };
      }
      res.json(horaires);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  }
);

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
