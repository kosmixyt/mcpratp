import { getCloudflare } from "./main.js";
import { LineTram } from "./type.js";
import { parse as parseHTML } from "node-html-parser";

enum Ligne {
  T1 = "t1",
  T2 = "t2",
  T3A = "t3a",
  T3B = "t3b",
  T5 = "t5",
  T6 = "t6",
  T7 = "t7",
  T8 = "t8",
  T9 = "t9",
  T10 = "t10",
  T11 = "t11",
}

// Interface for passage data
interface PassageInfo {
  direction: string;
  stop: string;
  realtime: Array<{
    destination: string;
    time: string;
  }>;
  scheduled: Array<{
    destination: string;
    time: string;
  }>;
  firstLast?: {
    first: string;
    last: string;
  };
}

export class TramService {
  constructor() {}
  async getLigne(lineName: Ligne): Promise<LineTram> {
    const response = await getCloudflare(
      `https://www.ratp.fr/horaires/${lineName}`
    );
    const data = JSON.parse(response);
    return data;
  }
  getLignes(): Ligne[] {
    return [
      Ligne.T1,
      Ligne.T2,
      Ligne.T3A,
      Ligne.T3B,
      Ligne.T5,
      Ligne.T6,
      Ligne.T7,
      Ligne.T8,
      Ligne.T9,
      Ligne.T10,
      Ligne.T11,
    ];
  }
  async getPerturbation(ligne: Ligne) {
    const url = `https://www.ratp.fr/horaires/api/getTrafficEventsLive/tram/${ligne}`;
    const resp = await getCloudflare(url);
    // json
    var json: any[] = [];
    try {
      json = JSON.parse(resp) as any[];
    } catch (e) {
      console.error("Error parsing JSON:", e);
      console.error(resp);
    }
    return json;
  }
  async getArrets(ligne: Ligne) {
    const url = `https://www.ratp.fr/horaires/api/getStopPoints/tram/${ligne}`;
    const resp = await getCloudflare(url);
    // json
    var json: any[] = [];
    try {
      json = JSON.parse(resp) as any[];
    } catch (e) {
      console.error("Error parsing JSON:", e);
      console.error(resp);
    }
    return json;
  }
  async getPassages(
    ligne_id: Ligne,
    arret_id: string,
    date: string,
    time: string
  ): Promise<PassageInfo[]> {
    if (date == "" || time == "") {
      const now = new Date();
      date = now.toLocaleDateString("fr-FR").replace(/\//g, "");
      date = date.slice(0, 2) + "/" + date.slice(2, 4) + "/" + date.slice(4);
      time = now.toTimeString().slice(0, 5);
    }
    console.log("Requesting passages for", ligne_id, arret_id, date, time);
    const url = `https://www.ratp.fr/horaires/blocs-horaires-next-passages/tram/${ligne_id}/${arret_id}?type=now&departure_date=${date}&departure_time=${time}`;
    const resp = await getCloudflare(url);
    console.log("Response received");

    // Parse HTML using node-html-parser
    const root = parseHTML(resp);
    const passages: PassageInfo[] = [];

    // Find all the timetable sections - one for each direction
    const timetableSections = root.querySelectorAll(
      ".ixxi-horaire-result-timetable"
    );

    timetableSections.forEach((section) => {
      // Each section contains a timetable_group
      const timetableGroup = section.querySelector(".timetable_group");

      if (!timetableGroup) return;

      const passageInfo: PassageInfo = {
        direction: "",
        stop: "",
        realtime: [],
        scheduled: [],
      };

      // Extract direction (e.g., "Vers Porte de Versailles")
      const directionElem = timetableGroup.querySelector(".destination_label");
      if (directionElem) {
        passageInfo.direction = directionElem.text.trim();
      }

      // Extract stop name (e.g., "Arrêt Belvédère")
      const stopElem = timetableGroup.querySelector(
        ".destination_label_small_title"
      );
      if (stopElem) {
        passageInfo.stop = stopElem.text.trim();
      }

      // Process each timetable table to find passage times
      const tables = timetableGroup.querySelectorAll("table.timetable");

      // First table is for passages
      if (tables.length > 0) {
        let currentTableType = ""; // To track if we're in realtime or scheduled section

        // Process all rows in the first table that contains the passage times
        const rows = tables[0].querySelectorAll("tr");

        for (const row of rows) {
          // Check if this row is a section header (realtime vs scheduled)
          if (row.classList.contains("type-horaire-tr")) {
            const typeText = row.text.trim();
            currentTableType = typeText.includes("temps réel")
              ? "realtime"
              : "scheduled";
            continue;
          }

          // If it's a data row with passage info
          if (row.classList.contains("body-tram")) {
            const destElem = row.querySelector(".terminus-wrap");
            const timeElem = row.querySelector(".heure-wrap");

            if (destElem && timeElem) {
              const destination = destElem.text.trim();
              // Clean up the time text (remove non-breaking spaces and any "vague-en-approche" elements)
              let timeText = timeElem.text.trim();

              // Handle special case like "A l'approche"
              if (timeText.includes("l'approche")) {
                timeText = "A l'approche";
              }

              const passageItem = {
                destination,
                time: timeText,
              };

              if (currentTableType === "realtime") {
                passageInfo.realtime.push(passageItem);
              } else {
                passageInfo.scheduled.push(passageItem);
              }
            }
          }
        }
      }

      // Extract first and last passage times from the second table
      if (tables.length > 1) {
        const firstElem = tables[1].querySelector(".first-wrap");
        const lastElem = tables[1].querySelector(".last-wrap");

        if (firstElem && lastElem) {
          passageInfo.firstLast = {
            first: firstElem.text.trim(),
            last: lastElem.text.trim(),
          };
        }
      }

      passages.push(passageInfo);
    });

    return passages;
  }
}
