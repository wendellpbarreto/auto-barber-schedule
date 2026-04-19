import { DateTime } from "luxon";

/* ==============================
 * CONSTANTS
 * ============================== */

const API_ROOT = "https://api.cashbarber.com.br/api";
const WEB_BASE = `${API_ROOT}/mrhudson/web`;

const ENDPOINTS = {
  login: `${API_ROOT}/auth/login`,
  book: `${WEB_BASE}/agendamentos`,
  list: `${WEB_BASE}/agendamentos/list`,
};

const TZ = "America/Sao_Paulo";
const MAX_BOOKING_DAYS = 15;
const DEFAULT_DELAY_MS = 3000;

/* ==============================
 * RECURRENCE CONFIG
 * ============================== */

/**
 * Ancorado numa quinta: o ciclo 5-4-5 cai em quinta → terça → sábado.
 * Sábado usa o outro barbeiro (9:00). Reinicie a data abaixo numa quinta
 * quando precisar realinhar (ex.: feriado na terça).
 */
const RECURRENCE_REFERENCE = DateTime.fromObject(
  { year: 2026, month: 4, day: 23, hour: 12 },
  { zone: TZ },
);

const CYCLE = [
  { delta: 5, hour: 12, minute: 0, barbeiroId: 21185 },
  { delta: 4, hour: 12, minute: 0, barbeiroId: 21185 },
  { delta: 5, hour: 9, minute: 0, barbeiroId: 21218 },
];

/* ==============================
 * CONFIG
 * ============================== */

function resolveConfig() {
  const {
    CASHBARBER_EMAIL,
    CASHBARBER_PASSWORD,
    CASHBARBER_AGE_ID_FILIAL,
    CASHBARBER_SERVICOS,
  } = process.env;

  const missing = ["CASHBARBER_EMAIL", "CASHBARBER_PASSWORD"].filter(
    (k) => !process.env[k],
  );

  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }

  const filialRaw = (CASHBARBER_AGE_ID_FILIAL ?? "").trim();
  const servicosRaw = (CASHBARBER_SERVICOS ?? "").trim();

  const filialId = filialRaw ? Number(filialRaw) : 3483;

  if (!Number.isFinite(filialId) || filialId <= 0) {
    throw new Error(
      `Invalid CASHBARBER_AGE_ID_FILIAL config: "${CASHBARBER_AGE_ID_FILIAL}"`,
    );
  }

  const servicos =
    servicosRaw.length > 0
      ? servicosRaw
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
      : [50954, 50952];

  if (!servicos.length) {
    throw new Error(
      `Invalid CASHBARBER_SERVICOS config: "${CASHBARBER_SERVICOS}"`,
    );
  }

  return {
    email: CASHBARBER_EMAIL,
    password: CASHBARBER_PASSWORD,
    filialId,
    servicos,
  };
}

/* ==============================
 * HTTP CLIENT
 * ============================== */

function cookieHeaderFromResponse(res) {
  const parts = res.headers.getSetCookie?.() ?? [];
  return parts
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function request(url, { method = "GET", cookie, body } = {}) {
  const payload =
    method !== "GET" && method !== "HEAD" && body === undefined ? {} : body;

  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-tenant": "mrhudson",
      "x-context": "cliente",
      Origin: "https://cashbarber.com.br",
      ...(cookie && { Cookie: cookie }),
    },
    ...(payload !== undefined && { body: JSON.stringify(payload) }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const error = new Error(data?.message || `HTTP ${res.status}`);
    error.status = res.status;
    error.response = data;
    throw error;
  }

  return data;
}

/* ==============================
 * AUTH
 * ============================== */

export async function auth() {
  const { email, password } = resolveConfig();

  const res = await fetch(ENDPOINTS.login, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-tenant": "mrhudson",
      "x-context": "cliente",
    },
    body: JSON.stringify({
      email,
      password,
      captchaToken: null,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.response = data;
    throw err;
  }

  const cookie = cookieHeaderFromResponse(res);
  if (!cookie.includes("access_token_cliente=")) {
    throw new Error("Auth failed: session cookie not returned");
  }

  return { cookie };
}

/* ==============================
 * LIST APPOINTMENTS
 * ============================== */

export async function listAppointmentDates(cookie) {
  const dates = new Set();
  let url = ENDPOINTS.list;

  while (url) {
    const data = await request(url, { method: "POST", cookie, body: {} });

    const futuros = data?.futuros?.data ?? [];

    for (const apt of futuros) {
      const inicio = apt?.age_inicio;
      if (typeof inicio === "string") {
        dates.add(inicio.slice(0, 10));
      }
    }

    url = data?.futuros?.next_page_url ?? null;
  }

  return dates;
}

/* ==============================
 * RECURRENCE
 * ============================== */

function generateSlots(maxDays = MAX_BOOKING_DAYS) {
  const now = DateTime.now().setZone(TZ);
  const cutoff = now.plus({ days: maxDays });

  const slots = [];

  let current = RECURRENCE_REFERENCE;
  let index = 0;

  while (current <= cutoff) {
    const cycleItem = CYCLE[index % CYCLE.length];

    const slotStart = current.set({
      hour: cycleItem.hour,
      minute: cycleItem.minute,
      second: 0,
      millisecond: 0,
    });

    if (slotStart > now) {
      slots.push({
        age_inicio: slotStart.toFormat("yyyy-MM-dd HH:mm:ss"),
        age_fim: slotStart.plus({ hours: 1 }).toFormat("yyyy-MM-dd HH:mm:ss"),
        age_id_user: cycleItem.barbeiroId,
      });
    }

    current = current.plus({ days: cycleItem.delta });
    index++;
  }

  return slots;
}

/* ==============================
 * BOOKING
 * ============================== */

function isAlreadyScheduledError(error) {
  if (error.status !== 422) return false;

  const msg = String(error.response?.message || "").toLowerCase();
  return ["intervalo", "horario", "agenda"].some((k) => msg.includes(k));
}

export async function bookSlot(cookie, slot) {
  const { filialId, servicos } = resolveConfig();

  const payload = {
    age_id_filial: filialId,
    age_id_user: slot.age_id_user,
    servicos,
    age_inicio: slot.age_inicio,
    age_fim: slot.age_fim,
    age_sem_preferencia: 0,
  };

  try {
    const data = await request(ENDPOINTS.book, {
      method: "POST",
      cookie,
      body: payload,
    });

    return { booked: data };
  } catch (error) {
    if (isAlreadyScheduledError(error)) {
      return { alreadyScheduled: true };
    }
    error.requestPayload = payload;
    throw error;
  }
}

export async function bookAllSlotsInWindow(cookie) {
  const delay =
    Number(process.env.CASHBARBER_BOOK_DELAY_MS) || DEFAULT_DELAY_MS;

  let existingDates = new Set();
  try {
    existingDates = await listAppointmentDates(cookie);
  } catch (err) {
    console.warn(
      "Could not list existing appointments, trying all slots:",
      err.message,
    );
  }

  const slots = generateSlots();

  const results = {
    booked: [],
    alreadyScheduled: [],
    errors: [],
  };

  for (const slot of slots) {
    const slotDate = slot.age_inicio.slice(0, 10);

    if (existingDates.has(slotDate)) {
      results.alreadyScheduled.push({ slot });
      continue;
    }

    await new Promise((r) => setTimeout(r, delay));

    try {
      const result = await bookSlot(cookie, slot);

      if (result.booked) {
        results.booked.push({ slot, data: result.booked });
      } else {
        results.alreadyScheduled.push({ slot });
      }
    } catch (error) {
      results.errors.push({
        slot,
        error: error.message,
        response: error.response,
        payload: error.requestPayload,
      });
    }
  }

  return results;
}

/* ==============================
 * ENTRYPOINT
 * ============================== */

export async function runBooking() {
  const { cookie } = await auth();
  const results = await bookAllSlotsInWindow(cookie);
  return results;
}
