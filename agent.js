// go_travels AI Booking Agent
// It opens your go_travels website in a real browser, logs in, compares all car prices,
// checks traffic + driver reliability + route deviation, and books the cab automatically.
//
// Run:  node agent.js "book a cab from VIT Chennai to Chennai Airport for 2 people with 2 bags, cheapest, pay by upi"

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// ---------------- Settings (change these if needed) ----------------
const SITE_URL = process.env.SITE_URL || "http://localhost:3000";   // your go_travels website (set SITE_URL when deployed)
const IN_CLOUD = !!process.env.RENDER;      // Render sets this, and there is no screen there
const PHONE = "9876543210";                 // demo login number
const MIN_RELIABILITY = 85;                 // below this % the agent books another driver
const MAX_REBOOKS = 1;                      // how many times it may re-book for a safer driver
const WATCH_SECONDS = 26;                   // how long it watches the trip for route deviation
const SHOW_BROWSER = true;                  // true = you can see the agent working (good for demo)
const SLOW_MO = 40;                         // small delay (ms) between actions, lower = faster

// Lets the agent know how many bags each car can hold (same values as your website)
const CAR_LUGGAGE = { mini: 2, sedan: 3, suv: 5, primesuv: 5 };

const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

let log = console.log;   // the web UI replaces this so it can show progress

function toNumber(word) {
  if (!word) return 0;
  const w = word.toLowerCase();
  if (WORD_NUMBERS[w]) return WORD_NUMBERS[w];
  return parseInt(w, 10) || 0;
}

// ---------------- Understand a time like "tomorrow at 6 pm", "at 7:30 am" or "in 10 minutes" ----------------
function parseWhen(text, now) {
  const lower = text.toLowerCase();
  now = now || new Date();

  // "in 10 minutes", "in 2 hours", "in an hour"
  const relative = lower.match(/in\s+(\d+|an?|one|two|three|four|five|six|ten|fifteen|twenty|thirty)\s*(minutes|minute|mins|min|hours|hour|hrs|hr)\b/);
  if (relative) {
    let amount = (relative[1] === "a" || relative[1] === "an") ? 1 : toNumber(relative[1]);
    if (relative[2].charAt(0) === "h") amount = amount * 60;
    return new Date(now.getTime() + amount * 60000);
  }

  // "6 pm", "6:30 pm", or 24-hour "at 18:30"
  let hour = -1;
  let minute = 0;
  const twelveHour = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  const twentyFourHour = lower.match(/\bat\s+(\d{1,2}):(\d{2})\b/);
  if (twelveHour) {
    hour = parseInt(twelveHour[1], 10);
    minute = twelveHour[2] ? parseInt(twelveHour[2], 10) : 0;
    if (twelveHour[3] === "pm" && hour < 12) hour = hour + 12;
    if (twelveHour[3] === "am" && hour === 12) hour = 0;
  } else if (twentyFourHour) {
    hour = parseInt(twentyFourHour[1], 10);
    minute = parseInt(twentyFourHour[2], 10);
  }
  if (hour < 0 || hour > 23 || minute > 59) return null;

  const date = new Date(now.getTime());
  date.setHours(hour, minute, 0, 0);
  if (lower.indexOf("tomorrow") !== -1) {
    date.setDate(date.getDate() + 1);
  } else if (date.getTime() <= now.getTime()) {
    date.setDate(date.getDate() + 1);   // that time already passed today, so use tomorrow
  }
  return date;
}

// ---------------- Step 1: understand the customer's request ----------------
function parseRequest(text) {
  const request = { name: "", pickup: "", drop: "", people: 1, bags: 0, payment: "upi", mode: "cheapest", when: null };
  const lower = text.toLowerCase();

  // "from X to Y" (stops before words like for / with / pay / numbers)
  const route = text.match(/from\s+(.+?)\s+to\s+(.+?)(?=\s+(?:in\s+(?:\d+|an?|one|two|three|four|five|six|ten|fifteen|twenty|thirty)|for|with|by|using|pay|paying|cheapest|fastest|recommended|tomorrow|today|at|\d|one|two|three|four|five|six)\b|[,.]|$)/i);
  if (route) {
    request.pickup = route[1].trim();
    request.drop = route[2].trim();
  }

  const people = lower.match(/(\d+|one|two|three|four|five|six)\s*(?:people|persons|person|passengers|passenger|members|of us)/);
  if (people) request.people = toNumber(people[1]);

  const bags = lower.match(/(\d+|one|two|three|four|five|six)\s*(?:bags|bag|luggage|suitcases|suitcase)/);
  if (bags) request.bags = toNumber(bags[1]);

  if (lower.indexOf("debit") !== -1) request.payment = "debit";
  else if (lower.indexOf("credit") !== -1) request.payment = "credit";
  else if (lower.indexOf("card") !== -1) request.payment = "card";
  else if (lower.indexOf("cash") !== -1) request.payment = "cash";
  else if (lower.indexOf("points") !== -1) request.payment = "points";

  if (lower.indexOf("fastest") !== -1 || lower.indexOf("quick") !== -1) request.mode = "fastest";
  else if (lower.indexOf("recommended") !== -1 || lower.indexOf("best") !== -1) request.mode = "recommended";

  const when = parseWhen(text);
  if (when) request.when = when.toISOString();   // a scheduled ride

  return request;
}

// ---------------- Step 2: decide which car to book ----------------
function pickCar(cars, request) {
  // keep only the cars that can carry the people and bags
  let fitting = cars.filter(function (car) {
    const seatsMatch = car.sub.match(/(\d+)\s*seats/i);
    const seats = seatsMatch ? parseInt(seatsMatch[1], 10) : 4;
    const luggage = CAR_LUGGAGE[car.id] || 2;
    return seats >= request.people && luggage >= request.bags;
  });
  if (fitting.length === 0) fitting = cars;   // nothing fits, so look at all of them

  if (request.mode === "fastest") {
    fitting.sort(function (a, b) { return a.eta - b.eta || a.price - b.price; });
    return { car: fitting[0], reason: "shortest pickup time (" + fitting[0].eta + " min) among cars that fit" };
  }
  if (request.mode === "recommended") {
    const ai = fitting.find(function (car) { return car.aiMatch; });
    if (ai) return { car: ai, reason: "the website's AI Match recommendation" };
  }
  fitting.sort(function (a, b) { return a.price - b.price; });
  return { car: fitting[0], reason: "lowest price among cars that fit " + request.people + " people and " + request.bags + " bags" };
}

// ---------------- Browser helpers ----------------
async function login(page, name) {
  await page.goto(SITE_URL);
  await page.waitForSelector("#existingPhone");
  if (name) {
    // new customer: the website asks for a name and a phone number
    await page.click("#tabNew");
    await page.fill("#newName", name);
    await page.fill("#newPhone", PHONE);
  } else {
    await page.fill("#existingPhone", PHONE);
  }
  await page.click("#sendOtpBtn");
  await page.waitForSelector("#screen-otp.active");

  // The demo site shows the code on screen, so the agent reads it
  const otp = (await page.textContent("#demoOtpValue")).trim();
  for (let i = 0; i < 4; i++) {
    await page.fill("#otp" + i, otp[i]);
  }
  await page.click("#verifyOtpBtn");
  await page.waitForSelector("#screen-1.active");
  log("  Logged in" + (name ? " as " + name : "") + " with demo OTP " + otp);
}

// Types the place and clicks the first suggestion (this also saves the website a slow map search later)
async function chooseLocation(page, inputId, listId, text) {
  await page.fill(inputId, text);
  const first = await page
    .waitForSelector(listId + " .suggest-item", { timeout: 6000 })
    .catch(function () { return null; });
  if (first) {
    await first.click();
  } else {
    await page.keyboard.press("Escape");   // no suggestion came, so keep the typed text
  }
}

async function bookOnce(page, request) {
  // Fill the route and passengers
  await chooseLocation(page, "#pickup", "#pickupSuggest", request.pickup);
  await chooseLocation(page, "#drop", "#dropSuggest", request.drop);

  for (let i = 1; i < request.people; i++) {
    await page.click('.counter-btn[data-counter="members"][data-dir="1"]');
  }
  for (let i = 0; i < request.bags; i++) {
    await page.click('.counter-btn[data-counter="luggage"][data-dir="1"]');
  }

  await page.waitForSelector("#toStep2:not([disabled])");
  await page.click("#toStep2");
  await page.waitForSelector(".car-option", { timeout: 90000 });
  await sleep(1000);

  // Read the live prices from the page
  const cars = await page.$$eval(".car-option", function (rows) {
    return rows.map(function (row) {
      return {
        id: row.getAttribute("data-car"),
        name: row.querySelector(".name").textContent.trim(),
        sub: row.querySelector(".sub").textContent.trim(),
        price: parseInt(row.querySelector(".amt").textContent.replace(/[^0-9]/g, ""), 10),
        eta: parseInt(row.querySelector(".eta").textContent, 10),
        aiMatch: row.querySelector(".ai-badge") !== null
      };
    });
  });

  const distance = (await page.textContent("#tripDist")).trim();
  const traffic = (await page.textContent("#demandText")).trim();
  log("  Route distance: " + distance);
  log("  Traffic/demand check: " + traffic);
  log("  Prices found:");
  cars.forEach(function (c) { log("    " + c.name + ": Rs " + c.price + " (" + c.eta + " min away)"); });

  const choice = pickCar(cars, request);
  log("  Agent chose " + choice.car.name + " because of " + choice.reason);

  // Select the car and the payment method, then confirm
  await page.click('.car-option[data-car="' + choice.car.id + '"]');
  await page.click('.payment-option[data-payment="' + request.payment + '"]');
  await page.waitForSelector("#toStep3:not([disabled])");
  await page.click("#toStep3");

  // Read the driver reliability that the website's dispatch AI produced
  const driverText = (await page.textContent("#driverAiText")).trim();
  const relMatch = driverText.match(/predicted\s+(\d+)%/i);
  const reliability = relMatch ? parseInt(relMatch[1], 10) : 0;

  await page.waitForSelector("#screen-3.active", { timeout: 20000 });

  return {
    car: choice.car.name,
    reason: choice.reason,
    price: (await page.textContent("#fareTotal")).trim(),
    driver: (await page.textContent("#driverName")).trim(),
    plate: (await page.textContent("#plateNo")).trim(),
    ridePin: (await page.textContent("#otpVal")).trim(),
    reliability: reliability,
    distance: distance,
    traffic: traffic
  };
}

// Watches the trip for route deviation. If found, it taps the emergency contact button.
async function watchTrip(page) {
  log("  Watching the trip for route deviation (" + WATCH_SECONDS + " seconds)...");
  const deviation = await page
    .waitForSelector("#safetyDot.alert", { timeout: WATCH_SECONDS * 1000 })
    .catch(function () { return null; });

  if (deviation) {
    log("  ALERT: route deviation detected! Notifying emergency contact...");
    await page.click("#alertContactBtn");
    return "Route deviation detected - emergency contact alerted";
  }
  log("  Trip stayed on route.");
  return "No route deviation detected";
}

// ---------------- Main agent (used by the command line AND the web UI) ----------------
async function runAgent(request, options) {
  const showBrowser = options && options.showBrowser !== undefined ? options.showBrowser : SHOW_BROWSER;
  const publicFolder = path.join(__dirname, "public");
  fs.mkdirSync(publicFolder, { recursive: true });

  log("AI Agent started");
  log("Request: " + request.pickup + " -> " + request.drop + ", " + request.people +
    " people, " + request.bags + " bags, mode: " + request.mode + ", payment: " + request.payment);

  const browser = await chromium.launch({
    headless: IN_CLOUD ? true : !showBrowser,
    slowMo: IN_CLOUD ? 0 : SLOW_MO,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });
  let result = null;
  let attemptCount = 0;
  let frameTimer = null;

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(60000);
    page.on("dialog", function (dialog) { dialog.accept(); });   // accepts the emergency pop-up

    // Live view: send a small picture of the browser to the web page about once a second
    if (options && options.onFrame) {
      let taking = false;
      frameTimer = setInterval(async function () {
        if (taking) return;
        taking = true;
        const picture = await page.screenshot({ type: "jpeg", quality: 45 }).catch(function () { return null; });
        if (picture) options.onFrame(picture.toString("base64"));
        taking = false;
      }, 1000);
    }

    log("[1] Logging in");
    await login(page, request.name);

    let rebooks = 0;
    while (true) {
      attemptCount++;
      log("[2] Comparing prices and booking (attempt " + attemptCount + ")");
      result = await bookOnce(page, request);
      log("  Booked " + result.car + " for " + result.price + " with " + result.driver +
        " (driver reliability " + result.reliability + "%)");

      if (result.reliability >= MIN_RELIABILITY || rebooks >= MAX_REBOOKS) break;

      log("  Reliability is below " + MIN_RELIABILITY + "%, so the agent will try for a safer driver.");
      rebooks++;
      await page.click("#bookAnother");
      await page.waitForSelector("#screen-1.active");
    }

    log("[3] Safety monitoring");
    result.safety = await watchTrip(page);

    result.screenshot = "booking-" + Date.now() + ".png";
    await page.screenshot({ path: path.join(publicFolder, result.screenshot), fullPage: true });
    result.attempts = attemptCount;
    result.request = request;
  } finally {
    if (frameTimer) clearInterval(frameTimer);
    await browser.close();
  }
  return result;
}

async function main() {
  const request = parseRequest(process.argv.slice(2).join(" "));
  if (!request.pickup || !request.drop) {
    console.log("Please give a request like:");
    console.log('node agent.js "book a cab from VIT Chennai to Chennai Airport for 2 people with 2 bags, cheapest, pay by upi"');
    return;
  }

  const result = await runAgent(request, { showBrowser: true });

  console.log("\n========== BOOKING SUMMARY ==========");
  console.log("Car:               " + result.car + " (" + result.reason + ")");
  console.log("Total fare:        " + result.price);
  console.log("Distance:          " + result.distance);
  console.log("Driver:            " + result.driver + " (" + result.reliability + "% reliable)");
  console.log("Vehicle number:    " + result.plate);
  console.log("Ride PIN:          " + result.ridePin);
  console.log("Traffic check:     " + result.traffic);
  console.log("Route monitoring:  " + result.safety);
  console.log("Screenshot saved:  public/" + result.screenshot);
  console.log("=====================================\n");
}

function setLogger(fn) {
  log = fn;
}

if (require.main === module) {
  main();
}

module.exports = { parseRequest, parseWhen, pickCar, runAgent, setLogger };
