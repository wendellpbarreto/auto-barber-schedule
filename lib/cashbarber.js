import { DateTime } from "luxon";

/* ==============================
 * CONSTANTS
 * ============================== */

const AUTH_URL = "https://api.cashbarber.com.br/api/mrhudson/web/auth";
const AGENDAMENTOS_URL =
  "https://api.cashbarber.com.br/api/mrhudson/web/agendamentos";
const AGENDAMENTOS_LIST_URL =
  "https://api.cashbarber.com.br/api/mrhudson/web/agendamentos/list";

const TZ = "America/Sao_Paulo";
const MAX_BOOKING_DAYS = 15;
const DEFAULT_BOOK_DELAY_MS = 3000;

/**
 * Recorrência:
 * Qui 12h → Ter 12h → Sáb 9h
 * Intervalos: 5d, 4d, 5d
 */
const RECURRENCE_REFERENCE = DateTime.fromObject(
  { year: 2026, month: 2, day: 5, hour: 12 },
  { zone: TZ },
);

const CYCLE_DELTAS_DAYS = [5, 4, 5];
const CYCLE_SLOTS = [
  { hour: 12, minute: 0 },
  { hour: 12, minute: 0 },
  { hour: 9, minute: 0 },
];

// 0=Qui, 1=Ter → Lucas | 2=Sáb → Hudson
const CYCLE_BARBEIRO_ID = [21185, 21185, 21218];

/* ==============================
 * CONFIG
 * ============================== */

let cachedConfig = null;

function getConfig() {
  if (cachedConfig) return cachedConfig;

  const {
    CASHBARBER_EMAIL,
    CASHBARBER_PASSWORD,
    CASHBARBER_AGE_ID_FILIAL = "3483",
    CASHBARBER_AGE_ID_USER = "21218",
    CASHBARBER_SERVICOS = "50954,50952",
  } = process.env;

  if (!CASHBARBER_EMAIL || !CASHBARBER_PASSWORD) {
    throw new Error(
      "Missing CASHBARBER_EMAIL or CASHBARBER_PASSWORD environment variables",
    );
  }

  cachedConfig = {
    email: CASHBARBER_EMAIL,
    password: CASHBARBER_PASSWORD,
    ageIdFilial: Number(CASHBARBER_AGE_ID_FILIAL),
    ageIdUser: Number(CASHBARBER_AGE_ID_USER),
    servicos: CASHBARBER_SERVICOS.split(",").map((s) => Number(s.trim())),
  };

  return cachedConfig;
}

/* ==============================
 * HELPERS
 * ============================== */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/**
 * 422 costuma indicar horário já ocupado
 */
function isAlreadyScheduledError(res, data) {
  if (res.status !== 422) return false;

  const msg = String(data?.message || "").toLowerCase();
  const errors = Array.isArray(data?.errors) ? data.errors : [];

  return (
    msg.includes("intervalo") ||
    msg.includes("horario") ||
    msg.includes("agenda") ||
    errors.some(
      (e) =>
        typeof e === "string" &&
        (e.includes("intervalo") ||
          e.includes("horario") ||
          e.includes("agenda")),
    )
  );
}

/* ==============================
 * AUTH
 * ============================== */

/**
 * Authenticate with CashBarber API.
 * @returns {Promise<{ token: string, user: object }>}
 */
export async function auth() {
  const { email, password } = getConfig();

  const { res, data } = await fetchJson(AUTH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      password_confirmation: password,
    }),
  });

  if (!res.ok || !data?.token) {
    throw new Error(data?.message || `Auth failed (${res.status})`);
  }

  return { token: data.token, user: data.user };
}

/* ==============================
 * LIST APPOINTMENTS
 * ============================== */

/**
 * Fetch all future appointments. Returns a Set of dates (YYYY-MM-DD) that
 * already have appointments (1 per day).
 * @param {string} token
 * @returns {Promise<Set<string>>}
 */
export async function listAppointmentDates(token) {
  const dates = new Set();
  let url = AGENDAMENTOS_LIST_URL;

  while (url) {
    const { res, data } = await fetchJson(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      throw new Error(data?.message || `List appointments failed (${res.status})`);
    }

    const futuros = data?.futuros?.data;
    if (Array.isArray(futuros)) {
      for (const apt of futuros) {
        const inicio = apt?.age_inicio;
        if (inicio && typeof inicio === "string") {
          const date = inicio.slice(0, 10); // "yyyy-mm-dd"
          dates.add(date);
        }
      }
    }

    url = data?.futuros?.next_page_url ?? null;
  }

  return dates;
}

/* ==============================
 * RECURRENCE
 * ============================== */

function getRecurrenceSlotsInWindow(maxDays = MAX_BOOKING_DAYS) {
  const now = DateTime.now().setZone(TZ);
  const cutoff = now.plus({ days: maxDays });

  const slots = [];
  let totalDays = 0;

  for (let i = 0; ; i++) {
    const slotTime = CYCLE_SLOTS[i % 3];
    const start = RECURRENCE_REFERENCE.plus({ days: totalDays }).set({
      hour: slotTime.hour,
      minute: slotTime.minute,
      second: 0,
      millisecond: 0,
    });

    if (start > cutoff) break;

    if (start > now) {
      slots.push({
        age_inicio: start.toFormat("yyyy-MM-dd HH:mm:ss"),
        age_fim: start.plus({ hours: 1 }).toFormat("yyyy-MM-dd HH:mm:ss"),
        age_id_user: CYCLE_BARBEIRO_ID[i % 3],
      });
    }

    totalDays += CYCLE_DELTAS_DAYS[i % 3];
  }

  return slots;
}

/* ==============================
 * BOOKING
 * ============================== */

/**
 * @param {string} token
 * @param {{ age_inicio: string, age_fim: string, age_id_user: number }} slot
 */
export async function bookOneSlot(token, slot) {
  const { ageIdFilial, servicos } = getConfig();

  const payload = {
    age_id_filial: ageIdFilial,
    age_id_user: slot.age_id_user,
    servicos,
    age_inicio: slot.age_inicio,
    age_fim: slot.age_fim,
    age_sem_preferencia: 0,
  };

  const { res, data } = await fetchJson(AGENDAMENTOS_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    if (isAlreadyScheduledError(res, data)) {
      return { alreadyScheduled: true };
    }

    const error = new Error(data?.message || `Booking failed (${res.status})`);
    error.status = res.status;
    error.response = data;
    throw error;
  }

  return { booked: data };
}

export async function bookAllSlotsInWindow(token, delayMs) {
  const delay =
    delayMs ??
    Number(process.env.CASHBARBER_BOOK_DELAY_MS || DEFAULT_BOOK_DELAY_MS);

  const existingDates = await listAppointmentDates(token);
  const slots = getRecurrenceSlotsInWindow();
  const results = { booked: [], alreadyScheduled: [], errors: [] };

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const slotDate = slot.age_inicio.slice(0, 10);

    if (existingDates.has(slotDate)) {
      results.alreadyScheduled.push({ slot });
      continue;
    }

    if (i > 0) await sleep(delay);

    try {
      const result = await bookOneSlot(token, slot);
      if (result.booked)
        results.booked.push({ slot, data: result.booked });
      if (result.alreadyScheduled)
        results.alreadyScheduled.push({ slot });
    } catch (err) {
      results.errors.push({
        slot,
        error: err.message,
        response: err.response,
      });
    }
  }

  return results;
}

/* ==============================
 * FLOW
 * ============================== */

export async function runBooking() {
  const authResult = await auth();
  const results = await bookAllSlotsInWindow(authResult.token);
  return { auth: authResult, results };
}
