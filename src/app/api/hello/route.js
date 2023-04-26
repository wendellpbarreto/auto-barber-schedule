import { NextResponse } from "next/server";

const APP_BASE_URL = "https://api.appbarber.com.br/horarios";

export async function POST(req) {
  const res = await fetch(APP_BASE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: "92466cd0ee77cee7b949ac0fa8f7a9bb",
      cliente: "7008371",
      usuario: "5784967",
      profissional: "5784967",
      servico: "367048",
      dia: "2023-5-2",
      hora: "13:00",
      origem: 4,
      obs: "",
      api_key: "TcskrU3Ejze.6",
    }),
  });
  const result = await res.json();

  return NextResponse.json({ result });
}
