# LumenRoute

**Find the safest way, not just the shortest.**

LumenRoute helps people walking, especially at night, compare the shortest walking route with safer alternatives. It shows both on a map, gives each a safety score, and explains why the chosen route was picked. Community members can also report dark spots with a reason, and those reports affect the scores of nearby routes.

---

## Features

- **Place search:** type a start and end place, or click the map to set points.
- **Multiple routes:** requests the straight route plus detours on both sides, then removes duplicates.
- **Safety score (0 to 100):** based on nearby lit streets, nearby shops and cafés, and community reports.
- **Shortest vs safest:** the shortest route is shown in red and the safest in green. Other routes appear in grey.
- **Explanation panel:** shows why the chosen route was picked, including warnings when it still passes a reported spot.
- **Community reports:** click the map in report mode, choose a reason, add an optional note, and save. Reports appear as orange dots with their reason.

---

## How the score works

For each sampled point along a route:

| Factor | Weight | What it measures |
|---|---|---|
| Lit streets | 0.7 | Share of nearby roads and paths (within 40 m) tagged `lit=yes` in OpenStreetMap |
| Shops and cafés | 0.3 | Nearby shops, cafés, restaurants, and pharmacies (within 100 m), capped at 3 |
| Community reports | −0.3 | Reports within 50 m, capped at 1 |

The route score is the average across its sampled points, scaled to 0 to 100.

**Ranking:** the app considers routes no more than 30% longer than the shortest. Among those, it picks the highest score, with a penalty of 30 points for each community report on the route. If no alternative scores better, the shortest route is shown as the "Best available" option, with a warning if it passes a reported spot.

---

## Tech stack

- **Frontend:** React + Vite
- **Map:** Leaflet with OpenStreetMap tiles
- **Routing:** OpenRouteService (foot-walking profile)
- **Street and place data:** Overpass API (OpenStreetMap)
- **Place search:** Nominatim (OpenStreetMap)
- **Community reports:** Supabase (Postgres)

---

## Setup

### Prerequisites
- Node.js 18 or newer
- A free OpenRouteService API key from https://openrouteservice.org (sign up through HeiGIT)
- A free Supabase project from https://supabase.com

### 1. Create the project
```bash
npm create vite@latest lumenroute -- --template react
cd lumenroute
npm install
npm install leaflet @supabase/supabase-js
```

### 2. Set up the database
In the Supabase **SQL Editor**, run:

```sql
create table reports (
  id bigint generated always as identity primary key,
  lat double precision not null,
  lng double precision not null,
  kind text not null,
  created_at timestamptz default now()
);

alter table reports enable row level security;

create policy "anyone can read" on reports for select using (true);
create policy "anyone can insert" on reports for insert with check (true);
```

Then, in a separate query, add the note column:

```sql
alter table reports add column if not exists note text default '';
```

### 3. Configure Supabase
Create `src/supabase.js`:

```js
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  'YOUR_PROJECT_URL',
  'YOUR_ANON_PUBLIC_KEY'
)
```

Use the **Project URL** and the **anon public** key from **Project Settings → API**. Never put the `service_role` key in the frontend.

### 4. Add the OpenRouteService key
In `src/App.jsx`, set:

```js
const ORS_KEY = 'YOUR_OPENROUTESERVICE_KEY'
```

### 5. Run
```bash
npm run dev
```

Open http://localhost:5173.

---

## Usage

1. Type a start and end place and click **Use typed places**, or click two points on the map.
2. Click **Find safest route**.
3. Read the red (shortest) and green (safest) routes, their scores, and the explanation panel.
4. To report a dark spot, click **Report a dark spot**, click the map, choose a reason, add an optional note, and save.

**Tips:**
- Include the area or city in place names, such as "Tumakuru University, Tumakuru".
- Walks of about 1 to 2 km give the best chance of alternative routes.
- If a place isn't found, try a nearby landmark or click the map instead.

---

## Limitations

Please read these before relying on the results:

- **Missing lighting data.** Most streets in OpenStreetMap have no `lit` tag. A street with no tag counts as unlit, so low scores often mean missing data, not danger.
- **Shop activity is a rough proxy.** The app checks whether shops exist nearby, not whether they're open.
- **Unverified reports.** Anyone can add a report, and reports are not moderated. There is no login yet.
- **Limited alternatives.** The routing service returns only a few routes, and on short walks it often returns the same path. The app can only rank routes it receives.
- **Not crime data.** The score measures lighting and activity, not crime or real personal safety.
- **Ranking, not routing.** The app reranks routes from the routing service. It does not build a safety-weighted network, so it cannot always find a safer path.
- **Rate limits.** The Overpass, Nominatim, and OpenRouteService services limit requests. Wait a minute if you see an error.

---

## Privacy

The app doesn't track users or store routes. The only data stored is the community reports you submit: location, reason, and optional note.

---

## Roadmap

- User login and report moderation
- Verified reports and report expiry
- Safety-weighted routing across the street network
- Time-of-day scoring, such as checking whether shops are open now
- Partnerships with city bodies for official lighting data

---

## Project structure

```
lumenroute/
├── src/
│   ├── App.jsx        # Map, routing, scoring, and report UI
│   ├── supabase.js    # Supabase client
│   └── index.css
├── package.json
└── README.md
```

---

## Security note

The OpenRouteService key is stored in the frontend code, so anyone can view it. Before publishing the project, regenerate the key and keep it out of public repositories. Supabase's `anon` key is designed for browser use, but the row-level security policies above are what protect the data.

---
