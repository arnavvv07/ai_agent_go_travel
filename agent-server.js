// Web server for the AI agent page.
// - starts go_travels in the background if it is not running
// - books rides right now, or schedules them for later
// Run:  node agent-server.js   then open http://localhost:4000

const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { parseRequest, runAgent, setLogger } = require("./agent");

const PORT = process.env.PORT || 4000;
const SITE_URL = process.env.SITE_URL || "http://localhost:3000";   // go_travels address (set SITE_URL when deployed)
const SITE_IS_LOCAL = SITE_URL.indexOf("localhost") !== -1;
const WEBSITE_FOLDER = path.join(__dirname, "..");   // the folder that has server.js (parent of ai-agent)
const LEAD_MINUTES = 2;                              // the agent books this many minutes before the pickup time
const JOBS_FILE = path.join(__dirname, "scheduled-rides.json");
const HISTORY_FILE = path.join(__dirname, "ride-history.json");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let websiteProcess = null;
let busy = false;
let jobs = [];        // all scheduled rides
let history = [];     // finished bookings (shown on the dashboard)
const timers = {};    // one timer per scheduled ride

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// True only when the real go_travels page is answering (not a "server is waking up" page)
async function websiteIsRunning() {
  const ok = await fetch(SITE_URL, { signal: AbortSignal.timeout(8000) })
    .then(function (res) { return res.text(); })
    .then(function (html) { return html.indexOf("existingPhone") !== -1; })
    .catch(function () { return false; });
  return ok;
}

async function startWebsite(send) {
  if (await websiteIsRunning()) {
    send("go_travels is already running");
    return true;
  }
  if (!SITE_IS_LOCAL) {
    // deployed go_travels: it may be asleep on the free plan, so just wait for it to wake up
    send("Waking up go_travels (this can take up to a minute)...");
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      if (await websiteIsRunning()) {
        send("go_travels is ready");
        return true;
      }
    }
    return false;
  }
  send("Starting go_travels in the background...");
  websiteProcess = spawn("node", ["server.js"], { cwd: WEBSITE_FOLDER, stdio: "ignore" });
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await websiteIsRunning()) {
      send("go_travels is ready");
      return true;
    }
  }
  return false;
}

// Starts go_travels, runs the agent and returns { result } or { error }
async function bookRide(request, showBrowser, send, onFrame) {
  setLogger(send);
  const ready = await startWebsite(send);
  if (!ready) return { error: "Could not start go_travels. Check that server.js is in the parent folder." };

  const started = Date.now();
  const outcome = await runAgent(request, { showBrowser: showBrowser, onFrame: onFrame }).then(function (result) {
    return { result: result, seconds: Math.round((Date.now() - started) / 1000) };
  }).catch(function (err) {
    return { error: "Booking stopped: " + err.message.split("\n")[0] };
  });
  return outcome;
}

// ---------------- Ride history ----------------
function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function addHistory(type, request, result, seconds, jobId) {
  history.push({ id: String(Date.now()), type: type, jobId: jobId, name: request.name, at: new Date().toISOString(), seconds: seconds, result: result });
  history = history.slice(-50);   // keep the last 50 rides
  saveHistory();
}

function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
}

// ---------------- Scheduled rides ----------------
function saveJobs() {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function armJob(job) {
  const wait = Math.max(0, new Date(job.dispatchAt).getTime() - Date.now());
  timers[job.id] = setTimeout(function () { runJob(job); }, wait);
}

async function runJob(job) {
  if (job.status !== "scheduled") return;
  if (busy) {                                   // the agent is busy with another ride, so try again soon
    timers[job.id] = setTimeout(function () { runJob(job); }, 15000);
    return;
  }
  busy = true;
  job.status = "booking";
  saveJobs();

  const outcome = await bookRide(job.request, job.showBrowser, function () {});
  busy = false;

  if (outcome.error) {
    job.status = "failed";
    job.error = outcome.error;
  } else {
    job.status = "done";
    job.result = outcome.result;
    addHistory("scheduled", job.request, outcome.result, outcome.seconds, job.id);
  }
  saveJobs();
}

function loadJobs() {
  if (!fs.existsSync(JOBS_FILE)) return;
  jobs = JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
  jobs.forEach(function (job) {
    if (job.status === "booking") {             // the server stopped in the middle of this one
      job.status = "failed";
      job.error = "The server restarted while booking.";
    }
    if (job.status === "scheduled") armJob(job);
  });
  saveJobs();
}

// ---------------- Routes ----------------
// The page sends the command here. Progress is streamed back line by line.
app.post("/api/book", async function (req, res) {
  res.setHeader("Content-Type", "application/x-ndjson");
  function send(text) { res.write(JSON.stringify({ type: "log", text: text.trim() }) + "\n"); }
  function finish(obj) { res.write(JSON.stringify(obj) + "\n"); res.end(); }

  const name = (req.body.name || "").trim();
  if (name.length < 2) return finish({ type: "error", text: "Please tell me your name first." });

  const request = parseRequest(req.body.command || "");
  request.name = name;
  if (!request.pickup || !request.drop) {
    return finish({ type: "error", text: 'Please say it like: "book a cab from VIT Chennai to Chennai Airport for 2 people".' });
  }

  // A time was given and it is far enough away, so schedule the ride for later
  if (request.when) {
    const dispatchAt = new Date(new Date(request.when).getTime() - LEAD_MINUTES * 60000);
    if (dispatchAt.getTime() - Date.now() > 20000) {
      const job = {
        id: String(Date.now()) + Math.floor(Math.random() * 1000),
        status: "scheduled",
        request: request,
        pickupTime: request.when,
        dispatchAt: dispatchAt.toISOString(),
        showBrowser: req.body.showBrowser === true,
        createdAt: new Date().toISOString()
      };
      jobs.push(job);
      saveJobs();
      armJob(job);
      return finish({ type: "scheduled", job: job, leadMinutes: LEAD_MINUTES });
    }
  }

  if (busy) return finish({ type: "error", text: "The agent is already booking a ride. Please wait a moment." });
  busy = true;
  function sendFrame(image) { res.write(JSON.stringify({ type: "frame", image: image }) + "\n"); }
  const outcome = await bookRide(request, req.body.showBrowser === true, send, sendFrame);
  busy = false;

  if (outcome.error) return finish({ type: "error", text: outcome.error });
  addHistory("instant", request, outcome.result, outcome.seconds, null);
  finish({ type: "done", result: outcome.result });
});

// Used by an uptime monitor to keep the free server awake
app.get("/health", function (req, res) {
  res.send("ok");
});

app.get("/api/config", function (req, res) {
  res.json({ siteUrl: SITE_URL });
});

app.get("/api/history", function (req, res) {
  res.json(history);
});

app.get("/api/scheduled", function (req, res) {
  res.json(jobs);
});

app.delete("/api/scheduled/:id", function (req, res) {
  const job = jobs.find(function (j) { return j.id === req.params.id; });
  if (!job || job.status !== "scheduled") return res.status(404).json({ error: "Not found" });
  clearTimeout(timers[job.id]);
  job.status = "cancelled";
  saveJobs();
  res.json(job);
});

loadHistory();
loadJobs();
app.listen(PORT, function () {
  console.log("AI agent page running at http://localhost:" + PORT);
});

process.on("exit", function () {
  if (websiteProcess) websiteProcess.kill();
});
process.on("SIGINT", function () { process.exit(); });
