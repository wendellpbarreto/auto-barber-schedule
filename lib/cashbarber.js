import { DateTime } from "luxon";

/* ==============================
 * CONSTANTS
 * ============================== */

const API_BASE = "https://api.cashbarber.com.br/api/mrhudson/web";

const ENDPOINTS = {
  auth: `${API_BASE}/auth`,
  book: `${API_BASE}/agendamentos`,
  list: `${API_BASE}/agendamentos/list`,
};

const TZ = "America/Sao_Paulo";
const MAX_BOOKING_DAYS = 15;
const DEFAULT_DELAY_MS = 3000;

/* ==============================
 * RECURRENCE CONFIG
 * ============================== */

const RECURRENCE_REFERENCE = DateTime.fromObject(
  { year: 2026, month: 2, day: 5, hour: 12 },
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

async function request(url, { method = "GET", token, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
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

  const data = await request(ENDPOINTS.auth, {
    method: "POST",
    body: {
      email,
      password,
      password_confirmation: password,
    },
  });

  if (!data?.token) {
    throw new Error("Auth failed: token not returned");
  }

  return { token: data.token, user: data.user };
}

/* ==============================
 * LIST APPOINTMENTS
 * ============================== */

export async function listAppointmentDates(token) {
  const dates = new Set();
  let url = ENDPOINTS.list;

  while (url) {
    const data = await request(url, { method: "POST", token });

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

export async function bookSlot(token, slot) {
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
      token,
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

export async function bookAllSlotsInWindow(token) {
  const delay =
    Number(process.env.CASHBARBER_BOOK_DELAY_MS) || DEFAULT_DELAY_MS;

  let existingDates = new Set();
  try {
    existingDates = await listAppointmentDates(token);
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
      const result = await bookSlot(token, slot);

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
  const { token } = await auth();
  const results = await bookAllSlotsInWindow(token);
  return results;
}
