// Sprint 7-map follow-up — retry geocode for the 31 'failed' clients with
// cleaned addresses. Same pattern as the inline backfill script.
//
// What's wrong with the 31 failures:
//   - Unit/apt/suite/floor suffixes that confuse Nominatim
//     ("35 Harrington Ave Unit:4408" → drop "Unit:4408")
//     ("87 Franklin Street Apt# 403" → drop "Apt# 403")
//     ("372 Chandler St. 2nd floor"  → drop "2nd floor")
//   - All-caps city ("WORCESTER" → "Worcester")
//   - Directional prefix Nominatim doesn't always know
//     ("North Weymouth" → fallback to "Weymouth")
//
// Strategy:
//   1. Try cleaned address + title-cased city
//   2. If still failed, retry with directional prefix stripped from city
//   3. If still failed, leave marked 'failed' (truly unresolvable)
//
// Paste in localhost:8000 console (or production console with v7-map loaded).
// Logs each row; ~1.1s per attempt + extra 1.1s when attempt 2 fires.

(async () => {
  const start = Date.now();
  const all = window.PentaClients.list();
  const queue = all.filter(c => c && c.geocode_status === 'failed' && c.addr && String(c.addr).trim());
  console.log(`[retry] starting on ${queue.length} failed clients`);

  function cleanAddress(addr) {
    if (!addr) return '';
    let s = String(addr).trim();
    // Strip Unit / Apartment / Apt / Suite / Ste with various punctuation
    s = s.replace(/[,\s]+(Unit|Apartment|Apt|Suite|Ste)[:#.\s]*[\w#-]+/gi, '');
    // Strip standalone "# 403" / "#403"
    s = s.replace(/[,\s]+#\s*\w+/g, '');
    // Strip "1st/2nd/3rd/4th/ground floor"
    s = s.replace(/[,\s]+(1st|2nd|3rd|4th|ground)\s+floor/gi, '');
    // Collapse whitespace + drop trailing comma
    s = s.replace(/\s+/g, ' ').trim().replace(/,\s*$/, '').trim();
    return s;
  }

  function cleanCity(city) {
    if (!city) return '';
    return String(city).trim().toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
  }

  function stripDirectionalPrefix(city) {
    if (!city) return '';
    // North / South / East / West / N. / S. / E. / W. (with optional period)
    return String(city).trim().replace(/^(North|South|East|West|N\.?|S\.?|E\.?|W\.?)\s+/i, '').trim();
  }

  let done = 0, recovered = 0, still_failed = 0, rate_limited = 0;

  for (const c of queue) {
    const origAddr = c.addr || '';
    const origCity = c.city || '';
    const cleanedAddr = cleanAddress(origAddr);
    const cleanedCity = cleanCity(origCity);

    // Attempt 1: cleaned + title-cased
    let result = await window.PentaGeocode.geocodeAddress(cleanedAddr, cleanedCity, c.zip);
    let attempt = '1-cleaned';

    // Attempt 2: also strip directional prefix
    if (result.status !== 'ok' && result.status !== 'rate_limited') {
      const stripped = stripDirectionalPrefix(cleanedCity);
      if (stripped && stripped !== cleanedCity) {
        await new Promise(r => setTimeout(r, 1100));
        result = await window.PentaGeocode.geocodeAddress(cleanedAddr, stripped, c.zip);
        attempt = '2-no-prefix';
      }
    }

    const nowIso = new Date().toISOString();
    let patch = null;

    if (result.status === 'ok') {
      patch = { lat: result.lat, lng: result.lng, geocode_status: 'ok', geocoded_at: nowIso };
      recovered++;
    } else if (result.status === 'rate_limited') {
      rate_limited++;
    } else {
      patch = { geocode_status: 'failed', geocoded_at: nowIso };
      still_failed++;
    }

    if (patch) {
      try { await window.PentaClients.updateClient(c.id, patch); }
      catch (e) { console.warn('[retry] save failed for', c.id, e); }
    }

    done++;
    const name = ((c.fn || '') + ' ' + (c.ln || '')).trim();
    const status = result.status === 'ok' ? `✓ recovered (${attempt})` : '✗ still failed';
    console.log(`[${done}/${queue.length}] ${status} | ${name} | "${origAddr}, ${origCity}" → "${cleanedAddr}, ${cleanedCity}"`);

    await new Promise(r => setTimeout(r, 1100));
  }

  const total = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`✅ DONE done:${done} recovered:${recovered} still_failed:${still_failed} rl:${rate_limited} total:${total}s`);
})();
