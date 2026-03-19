// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://hpmnsnpacbwwumcoeflx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwbW5zbnBhY2J3d3VtY29lZmx4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzE0OTIwNywiZXhwIjoyMDg4NzI1MjA3fQ.RADlqya5XegMIs-GuvfnJBmP9tFsp59HSlvag9PHdyI';
const REFRESH_INTERVAL = 30000; // 30 seconds

// HQ location: 27 Bloomfield Ave, Bloomfield, NJ 07003
const HQ = [40.8094, -74.1854];

// ── Map setup ─────────────────────────────────────────────────────────────────
const map = L.map('map').setView(HQ, 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors', maxZoom: 19
}).addTo(map);

const hqIcon = L.divIcon({
  className: '',
  html: '<div class="hq-marker">HQ</div>',
  iconSize: [40, 24],
  iconAnchor: [20, 12]
});
L.marker(HQ, { icon: hqIcon, zIndexOffset: 1000 }).addTo(map)
  .bindPopup('<b>27 Bloomfield Ave, Bloomfield, NJ 07003</b><br>Our Office');

L.circle(HQ, {
  radius: 16093, color: '#2563eb', fillColor: '#2563eb',
  fillOpacity: 0.05, weight: 1.5, dashArray: '5,5'
}).addTo(map);

// ── State ─────────────────────────────────────────────────────────────────────
let leads        = [];
let markers      = [];
let routeMarkers = [];   // numbered stop badges
let activeFilter = 'all';
let activeType   = 'all';
let routeActive  = false;
let routeLayer   = null;

// ── Data fetching ─────────────────────────────────────────────────────────────
async function fetchAllRows(table) {
  const rows = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=*&offset=${offset}&limit=${limit}`;
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    if (!res.ok) throw new Error(`Failed to fetch ${table}: ${res.status}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return rows;
}

async function fetchLeads() {
  try {
    const [websiteLeads, noWebsiteLeads] = await Promise.all([
      fetchAllRows('leads_nj'),
      fetchAllRows('leads_no_website_nj')
    ]);
    return [
      ...websiteLeads.map(l => ({ ...l, has_website: true })),
      ...noWebsiteLeads.map(l => ({ ...l, has_website: false, website: '' }))
    ];
  } catch (err) {
    console.error('Error fetching leads:', err);
    return null;
  }
}

// ── Stats panel ───────────────────────────────────────────────────────────────
function updateStats(data) {
  const total     = data.length;
  const withEmail = data.filter(l => l.email).length;
  const withSite  = data.filter(l => l.has_website).length;
  document.getElementById('total').textContent     = total;
  document.getElementById('withEmail').textContent = withEmail;
  document.getElementById('noEmail').textContent   = total - withEmail;
  document.getElementById('withSite').textContent  = withSite;
  document.getElementById('noSite').textContent    = total - withSite;
  document.getElementById('lastUpdated').textContent =
    'Updated ' + new Date().toLocaleTimeString();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getColor(lead) {
  if (!lead.has_website) return '#f59e0b';
  if (lead.email)        return '#22c55e';
  return '#ef4444';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function makePopup(l, stopNumber) {
  const emailHtml = l.email
    ? `<span class="popup-email">${escapeHtml(l.email)}</span>`
    : `<span class="popup-no-email">No email found</span>`;
  const tag = l.has_website
    ? '<span class="popup-tag tag-website">Has Website</span>'
    : '<span class="popup-tag tag-no-website">No Website</span>';
  const emailTag  = l.email ? ' <span class="popup-tag tag-email">Has Email</span>' : '';
  const websiteRow = l.website
    ? `<div class="popup-row"><span class="popup-label">Web:</span> <a href="${escapeHtml(l.website)}" target="_blank" rel="noopener">${escapeHtml((l.website || '').substring(0, 40))}...</a></div>`
    : '';
  const stopLabel = stopNumber != null
    ? `<div style="font-size:11px;color:#2563eb;font-weight:700;margin-bottom:4px">Stop #${stopNumber}</div>`
    : '';
  return `
    ${stopLabel}
    <div class="popup-name">${escapeHtml(l.name)}</div>
    <div class="popup-row"><span class="popup-label">Type:</span> ${escapeHtml(l.category || l.keyword || '')}</div>
    <div class="popup-row"><span class="popup-label">Address:</span> ${escapeHtml((l.address || '').replace('Address: ', ''))}</div>
    <div class="popup-row"><span class="popup-label">Phone:</span> ${escapeHtml((l.phone || '').replace('Phone: ', ''))}</div>
    <div class="popup-row"><span class="popup-label">Email:</span> ${emailHtml}</div>
    ${websiteRow}
    <div style="margin-top:4px">${tag}${emailTag}</div>
  `;
}

function matchesType(lead, typeFilter) {
  if (typeFilter === 'all') return true;
  const text = ((lead.category || '') + ' ' + (lead.keyword || '') + ' ' + (lead.name || '')).toLowerCase();
  if (typeFilter === 'salon')  return text.includes('salon');
  if (typeFilter === 'barber') return text.includes('barber');
  if (typeFilter === 'hair')   return text.includes('hair');
  return true;
}

// ── Markers ───────────────────────────────────────────────────────────────────
function renderMarkers(filter) {
  markers.forEach(m => map.removeLayer(m));
  markers = [];

  const filtered = leads.filter(l => {
    const lat = parseFloat(l.latitude);
    const lng = parseFloat(l.longitude);
    if (isNaN(lat) || isNaN(lng)) return false;
    if (filter === 'no-email'          && l.email)                    return false;
    if (filter === 'no-site'           && l.has_website)              return false;
    if (filter === 'no-email-no-site'  && (l.email || l.has_website)) return false;
    if (!matchesType(l, activeType))                                  return false;
    return true;
  });

  filtered.forEach(l => {
    const lat   = parseFloat(l.latitude);
    const lng   = parseFloat(l.longitude);
    const color = getColor(l);
    const marker = L.circleMarker([lat, lng], {
      radius: 6, fillColor: color, color: '#fff', weight: 1.5, fillOpacity: 0.85
    }).bindPopup(makePopup(l, null));
    marker._leadData = l;
    marker.addTo(map);
    markers.push(marker);
  });

  document.getElementById('total').textContent = filtered.length;
  renderRoute();
}

// ── Routing ───────────────────────────────────────────────────────────────────
function nearestNeighborRoute(start, points) {
  const remaining = points.map((pt, i) => ({ pt, i }));
  const order     = [];   // indices into points[]
  let current = start;

  while (remaining.length > 0) {
    let bestIdx  = 0;
    let bestDist = Infinity;
    for (let j = 0; j < remaining.length; j++) {
      const dx   = remaining[j].pt[0] - current[0];
      const dy   = remaining[j].pt[1] - current[1];
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) { bestDist = dist; bestIdx = j; }
    }
    current = remaining[bestIdx].pt;
    order.push(remaining[bestIdx].i);
    remaining.splice(bestIdx, 1);
  }

  return order;  // ordered indices into the original points array
}

function haversineKm(a, b) {
  const R    = 6371;
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLon = (b[1] - a[1]) * Math.PI / 180;
  const s    = Math.sin(dLat / 2) ** 2
             + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180)
             * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function clearRouteOverlay() {
  if (routeLayer)  { map.removeLayer(routeLayer); routeLayer = null; }
  routeMarkers.forEach(m => map.removeLayer(m));
  routeMarkers = [];
}

function renderRoute() {
  clearRouteOverlay();
  if (!routeActive || markers.length === 0) {
    document.getElementById('routeStat').textContent = '';
    // Restore plain popups (no stop numbers)
    markers.forEach(m => m.bindPopup(makePopup(m._leadData, null)));
    return;
  }

  const points  = markers.map(m => [m.getLatLng().lat, m.getLatLng().lng]);
  const order   = nearestNeighborRoute(HQ, points);
  const latLngs = [HQ, ...order.map(i => points[i])];

  // Polyline
  routeLayer = L.polyline(latLngs, {
    color: '#2563eb', weight: 2.5, opacity: 0.7, dashArray: '6,4'
  }).addTo(map);

  // Numbered badges + update popups with stop number
  order.forEach((markerIdx, stopIdx) => {
    const stopNum = stopIdx + 1;
    const latlng  = markers[markerIdx].getLatLng();

    // Update popup to show stop number
    markers[markerIdx].bindPopup(makePopup(markers[markerIdx]._leadData, stopNum));

    // Place numbered badge slightly offset so it doesn't cover the circle marker
    const badge = L.marker(latlng, {
      icon: L.divIcon({
        className: '',
        html: `<div class="stop-badge">${stopNum}</div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 22]   // sits just above the circle marker
      }),
      interactive: false,
      zIndexOffset: 500
    }).addTo(map);

    routeMarkers.push(badge);
  });

  // Distance summary
  let totalKm = 0;
  for (let i = 1; i < latLngs.length; i++) totalKm += haversineKm(latLngs[i - 1], latLngs[i]);
  const totalMi = (totalKm * 0.621371).toFixed(1);
  document.getElementById('routeStat').textContent =
    `${markers.length} stops · ~${totalMi} mi total`;
}

// ── Main load / refresh ───────────────────────────────────────────────────────
async function loadAndRender() {
  const data = await fetchLeads();
  if (data !== null) {
    leads = data;
    updateStats(leads);
    renderMarkers(activeFilter);
  }
}

loadAndRender();
setInterval(loadAndRender, REFRESH_INTERVAL);

// ── Event listeners ───────────────────────────────────────────────────────────
document.querySelectorAll('#statusFilters button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#statusFilters button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    renderMarkers(activeFilter);
  });
});

document.querySelectorAll('#typeFilters button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#typeFilters button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeType = btn.dataset.type;
    renderMarkers(activeFilter);
  });
});

document.getElementById('routeToggle').addEventListener('click', () => {
  routeActive = !routeActive;
  const btn = document.getElementById('routeToggle');
  btn.classList.toggle('active', routeActive);
  btn.innerHTML = routeActive ? '&#9654; Hide Route' : '&#9654; Show Optimized Route';
  renderRoute();
});

const toggleBtn = document.getElementById('togglePanel');
const panel     = document.getElementById('statsPanel');
toggleBtn.addEventListener('click', () => {
  panel.classList.toggle('collapsed');
  toggleBtn.textContent = panel.classList.contains('collapsed') ? '\u2630' : '\u2715';
});
