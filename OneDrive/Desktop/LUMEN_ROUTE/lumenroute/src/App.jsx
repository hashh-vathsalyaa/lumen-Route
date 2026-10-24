import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from './supabase'

const ORS_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjFmZjg3NzVkZjkxNDRlMDg5ODYwZjc5YjVjZjIyYTc0IiwiaCI6Im11cm11cjY0In0='

const OVERPASS = 'https://overpass-api.de/api/interpreter'
const NOMINATIM = 'https://nominatim.openstreetmap.org/search'

const REPORT_KINDS = [
  'Dark street',
  'Broken or no streetlight',
  'Feels unsafe at night',
  'Isolated stretch',
  'Open drain or obstruction',
  'Other',
]

// Each community report on a route counts this much against it when ranking
const REPORT_PENALTY = 30

// Escape text before showing it in a map popup, so user notes can't inject HTML
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  )
}

// Turn a typed place name into map coordinates (free, no key needed)
async function geocode(text) {
  const res = await fetch(
    NOMINATIM + '?format=json&limit=1&q=' + encodeURIComponent(text)
  )
  if (!res.ok) throw new Error('Place search failed (' + res.status + ')')
  const data = await res.json()
  if (!data.length) throw new Error('Could not find "' + text + '". Try adding the area or city name.')
  return L.latLng(parseFloat(data[0].lat), parseFloat(data[0].lon))
}

// Get roads and nearby places from OpenStreetMap for the area around the route
async function fetchOsmData(coords) {
  const lats = coords.map((c) => c[1])
  const lons = coords.map((c) => c[0])
  const pad = 0.002
  const bbox = [
    Math.min(...lats) - pad, Math.min(...lons) - pad,
    Math.max(...lats) + pad, Math.max(...lons) + pad,
  ].join(',')

  const query = `[out:json][timeout:25];
(
  way["highway"~"footway|path|pedestrian|residential|living_street|tertiary|secondary|primary|unclassified"](${bbox});
  node["shop"](${bbox});
  node["amenity"~"cafe|restaurant|pharmacy|fuel|bar"](${bbox});
);
out center tags;`

  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  })
  if (!res.ok) throw new Error('OpenStreetMap query failed (' + res.status + ')')
  const data = await res.json()
  return data.elements
}

// Distance between two coordinates, in meters
function distMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// Score a route from 0 to 100, and also return the details behind the score
function scoreRoute(coords, elements, reports) {
  const ways = elements.filter((e) => e.type === 'way' && e.center)
  const places = elements.filter((e) => e.type === 'node')
  const samples = coords.filter((_, i) => i % 5 === 0)

  let total = 0
  let litSum = 0
  let placeSum = 0
  const reportHits = new Set()

  for (const [lon, lat] of samples) {
    const nearWays = ways.filter(
      (w) => distMeters(lat, lon, w.center.lat, w.center.lon) < 40
    )
    const litRatio = nearWays.length
      ? nearWays.filter((w) => w.tags?.lit === 'yes').length / nearWays.length
      : 0

    const nearPlaces = places.filter(
      (p) => distMeters(lat, lon, p.lat, p.lon) < 100
    ).length

    reports.forEach((r, i) => {
      if (distMeters(lat, lon, r.lat, r.lng) < 50) reportHits.add(i)
    })
    const nearReports = reports.filter(
      (r) => distMeters(lat, lon, r.lat, r.lng) < 50
    ).length

    const point =
      0.7 * litRatio +
      0.3 * Math.min(nearPlaces / 3, 1) -
      0.3 * Math.min(nearReports, 1)

    total += Math.max(0, point)
    litSum += litRatio
    placeSum += nearPlaces
  }

  const n = samples.length || 1
  return {
    score: Math.round((total / n) * 100),
    lit: Math.round((litSum / n) * 100),
    places: Math.round((placeSum / n) * 10) / 10,
    reports: reportHits.size,
  }
}

// Ranking value: higher is better. Reports on the route count heavily against it.
function rankValue(route) {
  return route.score - REPORT_PENALTY * route.reports
}

// Build plain-language reasons for why the chosen route was picked
function buildReasons(shortest, safest) {
  if (safest === shortest) {
    const reasons = [
      'No safer alternative was found, so the shortest route is shown as the best available option.',
    ]
    if (shortest.reports > 0) {
      reasons.push(
        `Warning: this route passes ${shortest.reports} community-reported dark spot(s), and no alternative was better.`
      )
    }
    reasons.push('Scores depend on incomplete OpenStreetMap data, so compare them as relative, not absolute.')
    return reasons
  }

  const reasons = []
  const extra = Math.round((safest.distance / shortest.distance - 1) * 100)
  reasons.push(`It is ${extra}% longer than the shortest route, which is within the 30% limit.`)

  if (safest.reports < shortest.reports) {
    reasons.push(
      `It passes ${shortest.reports - safest.reports} fewer community-reported dark spot(s) than the shortest route.`
    )
  }

  if (safest.lit > shortest.lit) {
    reasons.push(`More of its nearby streets are tagged as lit: ${safest.lit}% vs ${shortest.lit}%.`)
  } else if (safest.lit === shortest.lit) {
    reasons.push(`Lighting is similar on both routes (${safest.lit}% of nearby streets tagged lit).`)
  } else {
    reasons.push(`Its lighting tags are lower (${safest.lit}% vs ${shortest.lit}%), so it was chosen for its other factors.`)
  }

  reasons.push(
    `Shops and cafés nearby: about ${safest.places} per point vs ${shortest.places} on the shortest route.`
  )

  if (safest.reports > 0) {
    reasons.push(
      `Warning: this route still passes ${safest.reports} community-reported dark spot(s), but fewer than the alternatives.`
    )
  }

  reasons.push('Scores depend on incomplete OpenStreetMap data, so compare them as relative, not absolute.')
  return reasons
}

// Get one walking route through a list of points
async function getWalkRoute(waypoints) {
  const res = await fetch(
    'https://api.openrouteservice.org/v2/directions/foot-walking/geojson',
    {
      method: 'POST',
      headers: { Authorization: ORS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coordinates: waypoints.map((p) => [p.lng, p.lat]),
      }),
    }
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error?.message || 'Routing failed')
  const f = data.features[0]
  return { coords: f.geometry.coordinates, distance: f.properties.summary.distance }
}

// A point about `meters` to the side of the midpoint, to force a different path
// Positive values go to one side, negative values to the other
function detourPoint(a, b, meters) {
  const midLat = (a.lat + b.lat) / 2
  const midLng = (a.lng + b.lng) / 2
  const cos = Math.cos((midLat * Math.PI) / 180)
  const dLat = b.lat - a.lat
  const dLng = (b.lng - a.lng) * cos
  const len = Math.sqrt(dLat * dLat + dLng * dLng) || 1
  const pLat = -dLng / len
  const pLng = dLat / len
  const degPerM = 1 / 111000
  return {
    lat: midLat + pLat * meters * degPerM,
    lng: midLng + (pLng * meters * degPerM) / cos,
  }
}

export default function App() {
  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const markerLayers = useRef([])
  const routeLayers = useRef([])
  const reportLayers = useRef([])
  const pendingLayer = useRef(null)
  const reportModeRef = useRef(false)

  const [points, setPoints] = useState([])
  const [routes, setRoutes] = useState(null)
  const [status, setStatus] = useState('Type a start and end place, or click the map.')
  const [loading, setLoading] = useState(false)
  const [reports, setReports] = useState([])
  const [reportMode, setReportMode] = useState(false)
  const [pending, setPending] = useState(null)
  const [reportKind, setReportKind] = useState(REPORT_KINDS[0])
  const [reportNote, setReportNote] = useState('')
  const [startText, setStartText] = useState('')
  const [endText, setEndText] = useState('')

  // Create the map once
  useEffect(() => {
    const map = L.map(mapEl.current).setView([12.9716, 77.5946], 14)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)

    map.on('click', (e) => {
      // In report mode, a click picks a spot for the report form instead of a route point
      if (reportModeRef.current) {
        setPending({ lat: e.latlng.lat, lng: e.latlng.lng })
        setStatus('Spot picked. Choose a reason, add a note, then save.')
        return
      }
      setPoints((prev) => (prev.length >= 2 ? [e.latlng] : [...prev, e.latlng]))
    })

    mapRef.current = map
    return () => map.remove()
  }, [])

  // Keep the map click handler in sync with report mode
  useEffect(() => {
    reportModeRef.current = reportMode
  }, [reportMode])

  // Draw start and end markers, and clear old routes when points change
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    markerLayers.current.forEach((l) => l.remove())
    routeLayers.current.forEach((l) => l.remove())
    markerLayers.current = []
    routeLayers.current = []
    setRoutes(null)

    points.forEach((p, i) => {
      const m = L.marker(p).addTo(map)
      m.bindTooltip(i === 0 ? 'Start' : 'End', { permanent: true })
      markerLayers.current.push(m)
    })

    if (points.length === 1) setStatus('Now set your destination.')
    if (points.length === 2) setStatus('Press "Find safest route".')
    if (points.length === 0) setStatus('Type a start and end place, or click the map.')
  }, [points])

  // Load saved reports when the app starts
  useEffect(() => {
    supabase
      .from('reports')
      .select('*')
      .then(({ data, error }) => {
        if (error) setStatus('Could not load reports: ' + error.message)
        else if (data) setReports(data)
      })
  }, [])

  // Draw saved reports, each with a popup that shows the reason
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    reportLayers.current.forEach((l) => l.remove())
    reportLayers.current = reports.map((r) =>
      L.circleMarker([r.lat, r.lng], { radius: 8, color: '#f59e0b', fillOpacity: 0.8 })
        .bindPopup(
          `<strong>${esc(r.kind)}</strong>` +
            (r.note ? `<br/>${esc(r.note)}` : '<br/><em>No note added</em>')
        )
        .bindTooltip(esc(r.kind))
        .addTo(map)
    )
  }, [reports])

  // Show the spot being picked for a new report
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (pendingLayer.current) pendingLayer.current.remove()
    pendingLayer.current = pending
      ? L.circleMarker([pending.lat, pending.lng], {
          radius: 10,
          color: '#2563eb',
          dashArray: '4 4',
          fillOpacity: 0.2,
        }).addTo(map)
      : null
  }, [pending])

  // Save the picked spot, its reason and note to Supabase
  async function saveReport() {
    if (!pending) return
    const row = {
      lat: pending.lat,
      lng: pending.lng,
      kind: reportKind,
      note: reportNote.trim(),
    }
    setLoading(true)
    const { data, error } = await supabase.from('reports').insert(row).select().single()
    setLoading(false)
    if (error) {
      setStatus('Could not save report: ' + error.message)
      return
    }
    setReports((prev) => [...prev, data ?? row])
    setPending(null)
    setReportNote('')
    setReportKind(REPORT_KINDS[0])
    setReportMode(false)
    setStatus('Report saved. It will now affect nearby route scores.')
  }

  // Convert the typed start and end places into map points
  async function setPointsFromText() {
    if (!startText.trim() || !endText.trim()) {
      setStatus('Type both a start and an end place.')
      return
    }
    setLoading(true)
    setStatus('Finding the two places...')
    try {
      const a = await geocode(startText)
      const b = await geocode(endText)
      setPoints([a, b])
      mapRef.current.fitBounds(L.latLngBounds([a, b]), { padding: [60, 60] })
    } catch (err) {
      setStatus('Error: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  async function findRoute() {
    if (points.length < 2) return
    setLoading(true)
    setStatus('Finding routes...')

    try {
      const [start, end] = points
      const directMeters = distMeters(start.lat, start.lng, end.lat, end.lng)
      const offset = Math.max(150, directMeters * 0.4)

      // Straight line, plus detours on both sides at two distances
      const attempts = [
        [start, end],
        [start, detourPoint(start, end, offset), end],
        [start, detourPoint(start, end, -offset), end],
        [start, detourPoint(start, end, offset * 2), end],
        [start, detourPoint(start, end, -offset * 2), end],
      ]

      const results = await Promise.allSettled(attempts.map((w) => getWalkRoute(w)))

      if (results[0].status === 'rejected') throw results[0].reason
      const raw = results
        .filter((r) => r.status === 'fulfilled')
        .map((r) => r.value)

      // Remove routes that are the same as one already kept
      const unique = []
      for (const r of raw) {
        const isSame = unique.some(
          (u) => Math.abs(u.distance - r.distance) < 20 && u.coords.length === r.coords.length
        )
        if (!isSame) unique.push(r)
      }

      setStatus('Checking streets and places in OpenStreetMap...')
      const osm = await fetchOsmData(unique.flatMap((r) => r.coords))

      // Each route gets its score plus the details used to compute it
      const found = unique.map((r) => {
        const d = scoreRoute(r.coords, osm, reports)
        return { ...r, score: d.score, lit: d.lit, places: d.places, reports: d.reports }
      })

      const shortest = found.reduce((a, b) => (b.distance < a.distance ? b : a))

      // Only consider routes at most 30% longer than the shortest
      const limit = shortest.distance * 1.3
      const candidates = found.filter((r) => r.distance <= limit)
      const safest = candidates.reduce((a, b) => (rankValue(b) > rankValue(a) ? b : a))

      const map = mapRef.current
      routeLayers.current.forEach((l) => l.remove())
      routeLayers.current = []

      const toLatLng = (coords) => coords.map(([lon, lat]) => [lat, lon])

      // Draw every other route first, in grey, so the coloured ones stay on top
      found
        .filter((r) => r !== shortest && r !== safest)
        .forEach((r) => {
          const line = L.polyline(toLatLng(r.coords), {
            color: '#6b7280',
            weight: 3,
            opacity: 0.6,
            dashArray: '6 6',
          }).addTo(map)
          routeLayers.current.push(line)
        })

      const shortLine = L.polyline(toLatLng(shortest.coords), { color: '#e11d48', weight: 5 }).addTo(map)
      routeLayers.current.push(shortLine)

      if (safest !== shortest) {
        const safeLine = L.polyline(toLatLng(safest.coords), { color: '#16a34a', weight: 5 }).addTo(map)
        routeLayers.current.push(safeLine)
      }

      map.fitBounds(
        L.latLngBounds(found.flatMap((r) => toLatLng(r.coords))),
        { padding: [40, 40] }
      )

      setRoutes({ shortest, safest, reasons: buildReasons(shortest, safest) })

      // Warn if the route being recommended still passes a reported dark spot
      const warn =
        safest.reports > 0
          ? ` Warning: the chosen route passes ${safest.reports} community-reported dark spot(s).`
          : ''

      const others = found.length - (safest === shortest ? 1 : 2)
      if (found.length === 1) {
        setStatus('Only one walking path was found between these places, so there is no alternative to compare.' + warn)
      } else if (safest === shortest) {
        setStatus(
          `Found ${found.length} routes. None scored higher than the shortest. Red is the shortest, grey are the other options.` + warn
        )
      } else {
        setStatus(
          `Found ${found.length} routes. Green is the safest, red is the shortest, and ${others} grey route${others === 1 ? '' : 's'} ${others === 1 ? 'is' : 'are'} shown too.` + warn
        )
      }
    } catch (err) {
      setStatus('Error: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  function reset() {
    setPoints([])
    setStartText('')
    setEndText('')
  }

  const inputStyle = { width: '100%', padding: 8, boxSizing: 'border-box', marginBottom: 8 }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <div style={{ width: 300, padding: 20, borderRight: '1px solid #ddd', overflowY: 'auto' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 26 }}>LumenRoute</h1>
        <p style={{ margin: '0 0 16px', color: '#555' }}>Find the safest way home, not just the shortest.</p>

        <p style={{ background: '#f4f4f5', padding: 10, borderRadius: 6 }}>{status}</p>

        <label style={{ fontSize: 13, color: '#555' }}>Start place</label>
        <input
          style={inputStyle}
          value={startText}
          onChange={(e) => setStartText(e.target.value)}
          placeholder="e.g. Akkamahadevi Ladies Hostel, Tumakuru"
        />

        <label style={{ fontSize: 13, color: '#555' }}>End place</label>
        <input
          style={inputStyle}
          value={endText}
          onChange={(e) => setEndText(e.target.value)}
          placeholder="e.g. Tumakuru University, Tumakuru"
        />

        <button
          onClick={setPointsFromText}
          disabled={loading}
          style={{ width: '100%', padding: 10, marginBottom: 8, cursor: 'pointer' }}
        >
          Use typed places
        </button>

        <button
          onClick={findRoute}
          disabled={points.length < 2 || loading}
          style={{ width: '100%', padding: 10, marginBottom: 8, cursor: 'pointer' }}
        >
          Find safest route
        </button>

        <button
          onClick={() => {
            setReportMode((m) => !m)
            setPending(null)
            setStatus(reportMode ? 'Report mode off.' : 'Report mode on. Click the map to pick a spot.')
          }}
          style={{
            width: '100%',
            padding: 10,
            marginBottom: 8,
            cursor: 'pointer',
            background: reportMode ? '#f59e0b' : undefined,
          }}
        >
          {reportMode ? 'Stop reporting' : 'Report a dark spot'}
        </button>

        {reportMode && (
          <div style={{ border: '1px solid #f59e0b', borderRadius: 6, padding: 10, marginBottom: 8 }}>
            {pending ? (
              <>
                <div style={{ fontSize: 13, color: '#555', marginBottom: 6 }}>
                  Spot: {pending.lat.toFixed(5)}, {pending.lng.toFixed(5)}
                </div>
                <label style={{ fontSize: 13, color: '#555' }}>Reason</label>
                <select
                  style={inputStyle}
                  value={reportKind}
                  onChange={(e) => setReportKind(e.target.value)}
                >
                  {REPORT_KINDS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
                <label style={{ fontSize: 13, color: '#555' }}>What is the issue? (optional)</label>
                <textarea
                  style={{ ...inputStyle, minHeight: 60 }}
                  value={reportNote}
                  onChange={(e) => setReportNote(e.target.value)}
                  placeholder="e.g. Three streetlights broken since last month"
                  maxLength={300}
                />
                <button
                  onClick={saveReport}
                  disabled={loading}
                  style={{ width: '100%', padding: 8, marginBottom: 6, cursor: 'pointer' }}
                >
                  Save report
                </button>
                <button
                  onClick={() => setPending(null)}
                  style={{ width: '100%', padding: 8, cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <div style={{ fontSize: 13, color: '#555' }}>Click the map where the issue is.</div>
            )}
          </div>
        )}

        <button onClick={reset} style={{ width: '100%', padding: 10, cursor: 'pointer' }}>
          Reset
        </button>

        {routes && (
          <div style={{ marginTop: 20 }}>
            <div style={{ borderLeft: '4px solid #e11d48', padding: '6px 10px', marginBottom: 10 }}>
              <strong>Shortest</strong>
              <div>Distance: {(routes.shortest.distance / 1000).toFixed(2)} km</div>
              <div>Safety score: {routes.shortest.score}/100</div>
              <div>Lit streets nearby: {routes.shortest.lit}%</div>
              <div>Shops and cafés nearby: {routes.shortest.places} per point</div>
              <div>Community reports on route: {routes.shortest.reports}</div>
            </div>
            <div style={{ borderLeft: '4px solid #16a34a', padding: '6px 10px' }}>
              <strong>{routes.safest === routes.shortest ? 'Best available' : 'Safest'}</strong>
              <div>Distance: {(routes.safest.distance / 1000).toFixed(2)} km</div>
              <div>Safety score: {routes.safest.score}/100</div>
              <div>Lit streets nearby: {routes.safest.lit}%</div>
              <div>Shops and cafés nearby: {routes.safest.places} per point</div>
              <div>Community reports on route: {routes.safest.reports}</div>
            </div>

            <div style={{ marginTop: 12, background: '#f8fafc', padding: 10, borderRadius: 6, fontSize: 13 }}>
              <strong>Why this route was chosen</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {routes.reasons.map((r, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{r}</li>
                ))}
              </ul>
            </div>

            <p style={{ fontSize: 12, color: '#777', marginTop: 16 }}>
              Note: scores use OpenStreetMap data. Lighting tags are incomplete in many areas.
            </p>
          </div>
        )}

        <p style={{ fontSize: 12, color: '#777', marginTop: 16 }}>
          Orange dots are community reports. Click one to see its reason.
        </p>
      </div>

      <div ref={mapEl} style={{ flex: 1 }} />
    </div>
  )
}