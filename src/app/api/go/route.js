import { NextResponse } from "next/server";
import { DateTime } from "luxon";

const APP_BASE_URL = "https://api.appbarber.com.br/horarios";
const HUDSON_ID = "5784967";
const USERS = [
  {
    name: "Wendell P. Barreto",
    id: "0dc056653128189eb8ce58aa1d798bd3",
    cliente: "7008371",
    usuario: HUDSON_ID,
    profissional: HUDSON_ID,
  },
];

export async function POST(req) {
  const nextThursday = DateTime.now()
    .setZone("America/Sao_Paulo")
    .endOf("week")
    .plus({ weeks: 1 })
    .minus({ days: 3 });
  const nextThursdayPlus1Week = nextThursday.plus({ weeks: 1 });
  const dates = [nextThursday, nextThursdayPlus1Week];
  let results = [];

  // Custom for reveillon
  await fetch(APP_BASE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: "TcskrU3Ejze.6",
      servico: "379482",
      dia: "2023-12-30",
      hora: "11:00",
      origem: 4,
      obs: "",
      ...USERS[0],
    }),
  });

  for (const user of USERS) {
    let dateResults = [];
    for (const date of dates) {
      const res = await fetch(APP_BASE_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          api_key: "TcskrU3Ejze.6",
          servico: "379482",
          dia: date.toFormat("yyyy-M-d"),
          hora: "13:00",
          origem: 4,
          obs: "",
          ...user,
        }),
      });

      const result = await res.json();

      dateResults.push(result);
    }

    results.push({
      ...user,
      results: dateResults,
    });
  }

  return NextResponse.json({
    results,
  });
}
