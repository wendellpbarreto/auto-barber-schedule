import { DateTime } from "luxon";

const AUTH_URL = "https://api.cashbarber.com.br/api/mrhudson/web/auth";
const AGENDAMENTOS_URL =
  "https://api.cashbarber.com.br/api/mrhudson/web/agendamentos";

const TZ = "America/Sao_Paulo";

function getConfig() {
  const email = process.env.CASHBARBER_EMAIL;
  const password = process.env.CASHBARBER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Missing CASHBARBER_EMAIL or CASHBARBER_PASSWORD environment variables"
    );
  }
  const ageIdFilial = parseInt(
    process.env.CASHBARBER_AGE_ID_FILIAL || "3483",
    10
  );
  const ageIdUser = parseInt(process.env.CASHBARBER_AGE_ID_USER || "21218", 10);
  const servicosStr = process.env.CASHBARBER_SERVICOS || "50954,50952";
  const servicos = servicosStr.split(",").map((s) => parseInt(s.trim(), 10));
  return { email, password, ageIdFilial, ageIdUser, servicos };
}

/**
 * Authenticate with CashBarber API. Returns { token, user }.
 * @returns {Promise<{ token: string, user: object }>}
 */
export async function auth() {
  const { email, password } = getConfig();
  const res = await fetch(AUTH_URL, {
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
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || `Auth failed: ${res.status}`);
  }
  if (!data.token) {
    throw new Error("Auth response missing token");
  }
  return { token: data.token, user: data.user };
}

/**
 * Recurrence: Thu 12h → Tue 12h → Sat 9h, starting Thursday 05/02.
 * Cycle deltas (days between): Thu→Tue 5, Tue→Sat 4, Sat→Thu 5.
 * Gives ~4–5 days between appointments instead of 7 (better alignment, limited slots).
 */
const RECURRENCE_REFERENCE = DateTime.fromObject(
  { year: 2026, month: 2, day: 5, hour: 12, minute: 0, second: 0 },
  { zone: TZ }
);
const CYCLE_DELTAS_DAYS = [5, 4, 5];
const CYCLE_SLOTS = [
  { hour: 12, minute: 0 },
  { hour: 12, minute: 0 },
  { hour: 9, minute: 0 },
];
// Barbeiro por dia do ciclo: 0=Qui, 1=Ter → LUCAS (21185); 2=Sáb → HUDSON (21218)
const CYCLE_BARBEIRO_ID = [21185, 21185, 21218];

const MAX_BOOKING_DAYS = 15;
const DEFAULT_BOOK_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** All recurrence slots in (now, now + maxDays] for the Thu→Tue→Sat cycle. */
function getRecurrenceSlotsInWindow(maxDays = MAX_BOOKING_DAYS) {
  const now = DateTime.now().setZone(TZ);
  const cutoff = now.plus({ days: maxDays });
  const slots = [];
  let totalDays = 0;
  for (let i = 0; ; i++) {
    const slotConfig = CYCLE_SLOTS[i % 3];
    const start = RECURRENCE_REFERENCE.plus({ days: totalDays }).set({
      hour: slotConfig.hour,
      minute: slotConfig.minute,
      second: 0,
      millisecond: 0,
    });
    if (start > cutoff) break;
    if (start > now) {
      const end = start.plus({ hours: 1 });
      slots.push({
        age_inicio: start.toFormat("yyyy-MM-dd HH:mm:ss"),
        age_fim: end.toFormat("yyyy-MM-dd HH:mm:ss"),
        age_id_user: CYCLE_BARBEIRO_ID[i % 3],
      });
    }
    totalDays += CYCLE_DELTAS_DAYS[i % 3];
  }
  return slots;
}

/** 422 = slot occupied / no availability; treat as success (already scheduled). */
function isAlreadyScheduledError(res, data) {
  if (res.status !== 422) return false;
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const msg = (data?.message || "").toLowerCase();
  return (
    errors.some(
      (e) =>
        typeof e === "string" &&
        (e.includes("intervalo") ||
          e.includes("horario") ||
          e.includes("agenda"))
    ) ||
    msg.includes("intervalo") ||
    msg.includes("horario") ||
    msg.includes("agenda")
  );
}

/**
 * Try to book one slot. On 422 "slot occupied", returns { alreadyScheduled: true }.
 * @param {string} token - Bearer token from auth()
 * @param {{ age_inicio: string, age_fim: string }} slot
 * @returns {Promise<{ booked?: object, alreadyScheduled?: true }>}
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
  const res = await fetch(AGENDAMENTOS_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (isAlreadyScheduledError(res, data)) {
      return { alreadyScheduled: true };
    }
    const err = new Error(
      data.message || data.error || `Booking failed: ${res.status}`
    );
    err.status = res.status;
    err.response = data;
    throw err;
  }
  return { booked: data };
}

/**
 * Try to book all recurrence slots within the next 15 days. Waits delayMs between attempts.
 * @param {string} token - Bearer token from auth()
 * @param {number} [delayMs] - Delay between attempts (default from env CASHBARBER_BOOK_DELAY_MS or 3000)
 * @returns {Promise<{ booked: array, alreadyScheduled: array, errors: array }>}
 */
export async function bookAllSlotsInWindow(token, delayMs) {
  const delay =
    delayMs ??
    parseInt(
      process.env.CASHBARBER_BOOK_DELAY_MS || String(DEFAULT_BOOK_DELAY_MS),
      10
    );
  const slots = getRecurrenceSlotsInWindow(MAX_BOOKING_DAYS);
  const results = { booked: [], alreadyScheduled: [], errors: [] };
  for (let i = 0; i < slots.length; i++) {
    if (i > 0) await sleep(delay);
    try {
      const out = await bookOneSlot(token, slots[i]);
      if (out.booked) results.booked.push({ slot: slots[i], data: out.booked });
      if (out.alreadyScheduled)
        results.alreadyScheduled.push({ slot: slots[i] });
    } catch (err) {
      results.errors.push({
        slot: slots[i],
        error: err.message,
        response: err.response,
      });
    }
  }
  return results;
}

/**
 * Run full flow: auth then book all slots in the 15-day window (with delay between attempts).
 * Returns { auth, results: { booked, alreadyScheduled, errors } }.
 */
export async function runBooking() {
  const authResult = await auth();
  const results = await bookAllSlotsInWindow(authResult.token);
  return { auth: authResult, results };
}
