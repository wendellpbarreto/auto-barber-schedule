import { runBooking } from "../lib/cashbarber.js";

try {
  const result = await runBooking();
  console.log("Done:", JSON.stringify(result, null, 2));
} catch (err) {
  console.error("Error:", err.message);
  if (err.response) {
    console.error("Response:", JSON.stringify(err.response, null, 2));
  }
  process.exit(1);
}
