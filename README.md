# go_travels AI Booking Agent

Put this `ai-agent` folder INSIDE your main go_travels project folder (the one that has server.js).

## Setup (one time, inside the ai-agent folder)
npm install
npx playwright install chromium

## Option A: Voice / web page (recommended for the demo)
node agent-server.js
Open http://localhost:4000 in Chrome, tap the mic and speak, or type.
go_travels starts by itself in the background if it is not already running.
Tick "Show the go_travels window" if you want to watch the agent work.
(Needs Node 18 or newer. Check with: node --version)

## Option B: Command line
Start go_travels first (npm start in the main folder), then:
node agent.js "book a cab from VIT Chennai to Chennai Airport for 2 people with 2 bags, cheapest, pay by upi"

Words the agent understands: cheapest / fastest / recommended, and payment upi / cash / card / debit / credit / points.
Settings (phone number, minimum driver reliability, speed) are at the top of agent.js.
