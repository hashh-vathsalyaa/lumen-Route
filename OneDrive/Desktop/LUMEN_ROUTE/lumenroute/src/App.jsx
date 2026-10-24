import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from './supabase'

const ORS_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjFmZjg3NzVkZjkxNDRlMDg5ODYwZjc5YjVjZjIyYTc0IiwiaCI6Im11cm11cjY0In0='

const OVERPASS = 'https://overpass-api.de/api/interpreter'

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

function scoreRoute(coords, elements, reports) {
  const ways = elements.filter((e) => e.type === 'way' && e.center)
  const places = elements.filter((e) => e.type === 'node')
  const samples = coords.filter((_, i) => i % 5 === 0)

  let total = 0
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

    const nearReports = reports.filter(
      (r) => distMeters(lat, lon, r.lat, r.lng) < 50
    ).length

    const point =
      0.7 * litRatio +
      0.3 * Math.min(nearPlaces / 3, 1) -
      0.3 * Math.min(nearReports, 1)

    total += Math.max(0, point)
  }
  return Math.round((total / samples.length) * 100)
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

  const [points, setPoints] = useState([])
  const [routes, setRoutes] = useState(null)
  const [status, setStatus] = useState('Click the map to set your start point.')
  const [loading, setLoading] = useState(false)
  const [reports, setReports] = useState([])
  const [reportMode, setReportMode] = useState(false)
  const reportModeRef = useRef(false)
  const reportLayers = useRef([])
  // Create the map once
  useEffect(() => {
    const map = L.map(mapEl.current).setView([12.9716, 77.5946], 14)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)

        map.on('click', async (e) => {
      if (reportModeRef.current) {
        const { error } = await supabase
          .from('reports')
          .insert({ lat: e.latlng.lat, lng: e.latlng.lng, kind: 'dark' })
        if (error) {
          setStatus('Could not save report: ' + error.message)
          return
        }
        setReports((prev) => [...prev, { lat: e.latlng.lat, lng: e.latlng.lng, kind: 'dark' }])
        setStatus('Report saved. Thank you!')
        return
      }
      setPoints((prev) => (prev.length >= 2 ? [e.latlng] : [...prev, e.latlng]))
    })

    mapRef.current = map
    return () => map.remove()
  }, [])

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

    if (points.length === 1) setStatus('Now click your destination.')
    if (points.length === 2) setStatus('Press "Find safest route".')
    if (points.length === 0) setStatus('Click the map to set your start point.')
  }, [points])
  // Keep the map click handler in sync with report mode
  useEffect(() => {
    reportModeRef.current = reportMode
  }, [reportMode])

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

  // Draw report markers on the map
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    reportLayers.current.forEach((l) => l.remove())
    reportLayers.current = reports.map((r) =>
      L.circleMarker([r.lat, r.lng], { radius: 8, color: '#f59e0b', fillOpacity: 0.8 })
        .bindTooltip('Reported dark spot')
        .addTo(map)
    )
  }, [reports])
  async function findRoute() {
    if (points.length < 2) return
    setLoading(true)
    setStatus('Finding routes...')

    try {
      const [start, end] = points
      const direct = await getWalkRoute([start, end])
      const viaDetour = await getWalkRoute([start, detourPoint(start, end, 300), end])
      const raw = [direct, viaDetour]

      setStatus('Checking streets and places in OpenStreetMap...')
      const osm = await fetchOsmData([...direct.coords, ...viaDetour.coords])
            const found = raw.map((r) => ({ ...r, score: scoreRoute(r.coords, osm, reports) }))

      const shortest = found.reduce((a, b) => (b.distance < a.distance ? b : a))
      const safest = found.reduce((a, b) => (b.score > a.score ? b : a))

      const map = mapRef.current
      routeLayers.current.forEach((l) => l.remove())
      routeLayers.current = []

      const toLatLng = (coords) => coords.map(([lon, lat]) => [lat, lon])
      const shortLine = L.polyline(toLatLng(shortest.coords), { color: '#e11d48', weight: 5 }).addTo(map)
      routeLayers.current.push(shortLine)

      if (safest !== shortest) {
        const safeLine = L.polyline(toLatLng(safest.coords), { color: '#16a34a', weight: 5 }).addTo(map)
        routeLayers.current.push(safeLine)
      }

      map.fitBounds(L.latLngBounds(toLatLng(shortest.coords)).extend(toLatLng(safest.coords)), { padding: [40, 40] })

      setRoutes({ shortest, safest })
      setStatus(
        safest === shortest
          ? 'Both options scored the same. Only the shortest route is shown.'
          : 'Done. Green is the safest route. Red is the shortest.'
      )
    } catch (err) {
      setStatus('Error: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  function reset() {
    setPoints([])
  }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <div style={{ width: 300, padding: 20, borderRight: '1px solid #ddd', overflowY: 'auto' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 26 }}>LumenRoute</h1>
        <p style={{ margin: '0 0 16px', color: '#555' }}>Find the safest way home, not just the shortest.</p>

        <p style={{ background: '#f4f4f5', padding: 10, borderRadius: 6 }}>{status}</p>

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
            setStatus(reportMode ? 'Report mode off.' : 'Report mode on. Click the map to mark a dark spot.')
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
        <button onClick={reset} style={{ width: '100%', padding: 10, cursor: 'pointer' }}>
          Reset
        </button>

        {routes && (
          <div style={{ marginTop: 20 }}>
            <div style={{ borderLeft: '4px solid #e11d48', padding: '6px 10px', marginBottom: 10 }}>
              <strong>Shortest</strong>
              <div>Distance: {(routes.shortest.distance / 1000).toFixed(2)} km</div>
              <div>Safety score: {routes.shortest.score}/100</div>
            </div>
            <div style={{ borderLeft: '4px solid #16a34a', padding: '6px 10px' }}>
              <strong>Safest</strong>
              <div>Distance: {(routes.safest.distance / 1000).toFixed(2)} km</div>
              <div>Safety score: {routes.safest.score}/100</div>
            </div>
            <p style={{ fontSize: 12, color: '#777', marginTop: 16 }}>
              Note: scores use OpenStreetMap data. Lighting tags are incomplete in many areas.
            </p>
          </div>
        )}
      </div>

      <div ref={mapEl} style={{ flex: 1 }} />
    </div>
  )
}