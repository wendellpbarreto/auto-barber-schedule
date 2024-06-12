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
    minusDays: 3,
  },
  {
    name: "Milton Alves",
    id: "0ee54281f50a0accd61d7eb77294f983",
    cliente: "7006215",
    usuario: HUDSON_ID,
    profissional: HUDSON_ID,
    minusDays: 1,
  },
];

export async function POST(req) {
  let results = [];

  // Custom for reveillon
  // const resCustom = await fetch(APP_BASE_URL, {
  //   method: "POST",
  //   headers: {
  //     Accept: "application/json",
  //     "Content-Type": "application/json",
  //   },
  //   body: JSON.stringify({
  //     api_key: "TcskrU3Ejze.6",
  //     servico: "379482",
  //     dia: "2023-12-30",
  //     hora: "09:30",
  //     origem: 4,
  //     obs: "",
  //     ...USERS[0],
  //   }),
  // });
  // const resCustomResult = await resCustom.json();
  // results.push({
  //   ...USERS[0],
  //   result: resCustomResult,
  // })

  for (const user of USERS) {
    const nextDay = DateTime.now()
      .setZone("America/Sao_Paulo")
      .endOf("week")
      .plus({ weeks: 1 })
      .minus({ days: user.minusDays });
    const nextDayPlus1Week = nextDay.plus({ weeks: 1 });
    const dates = [nextDay, nextDayPlus1Week];
    let dateResults = [];

    for (const date of dates) {
      const data = {
        api_key: "TcskrU3Ejze.6",
        servico: "379482",
        dia: date.toFormat("yyyy-M-d"),
        hora: "09:00",
        origem: 4,
        obs: "",
        ...user,
      };
      const res = await fetch(APP_BASE_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });

      const result = await res.json();

      dateResults.push({ result, ...data });
    }

    results.push({
      ...user,
      results: dateResults,
    });
  }

  return NextResponse.json(results);
}
