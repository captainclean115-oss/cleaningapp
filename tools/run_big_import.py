#!/usr/bin/env python3
"""
Big Import — TMConnect → Penta migration

Reads four files:
  - /Users/myhelper/Downloads/Export_Client (2).xls
  - /Users/myhelper/Downloads/Export_Job_List.csv
  - /Users/myhelper/Downloads/Export_Client_Keylist_Report.csv
  - /tmp/big_import/db_snapshot.json   (current DB state, pre-fetched via MCP)

Computes everything and writes:
  Generated SQL artifacts (the assistant applies these via Supabase MCP):
    /tmp/big_import/phase2_profiles.sql
    /tmp/big_import/phase3_anchors.sql
    /tmp/big_import/phase4_orphans.sql
    /tmp/big_import/phase5_keys_clear.sql
    /tmp/big_import/phase5_keys_insert.sql
    /tmp/big_import/phase5_keys_inline.sql
    /tmp/big_import/phase6_cancellations_clear.sql
    /tmp/big_import/phase6_cancellations.sql
  Review CSVs:
    ~/Desktop/anchor_anomalies_messy.csv
    ~/Desktop/key_unmatched.csv
    ~/Desktop/new_clients_review.csv

NOTE: Python cannot call Supabase MCP directly (MCP tools are exposed only to
the Claude Code conversation). This script generates SQL artifacts and the
assistant applies them via mcp__supabase__execute_sql. The result is the same
"all writes go through MCP" guarantee — Python never touches the DB.

Flags:
  --dry-run       Compute everything and print the summary, but skip writing
                  SQL artifacts and CSVs. Useful for sanity check.
"""

import argparse, csv, json, os, re, sys, statistics
from collections import Counter, defaultdict
from datetime import datetime, date

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BUSINESS_ID = "48532f06-0625-415b-9091-2638bed6506d"

XLS_PATH      = "/Users/myhelper/Downloads/Export_Client (2).xls"
JOBS_CSV_PATH = "/Users/myhelper/Downloads/Export_Job_List.csv"
KEYS_CSV_PATH = "/Users/myhelper/Downloads/Export_Client_Keylist_Report.csv"
SNAPSHOT_PATH = "/tmp/big_import/db_snapshot.json"

OUT_DIR     = "/tmp/big_import"
DESKTOP     = os.path.expanduser("~/Desktop")

# DB enum values (NO spaces in the DB form, but xls uses "RMS - EOW" with spaces)
FREQ_NORMALIZE = {
    "RMS - WEK": "RMS-WEK", "RMS-WEK": "RMS-WEK", "WEK": "RMS-WEK",
    "RMS - EOW": "RMS-EOW", "RMS-EOW": "RMS-EOW", "EOW": "RMS-EOW",
    "RMS - ETW": "RMS-ETW", "RMS-ETW": "RMS-ETW", "ETW": "RMS-ETW",
    "RMS - EFW": "RMS-EFW", "RMS-EFW": "RMS-EFW", "EFW": "RMS-EFW",
    "RMS - MON": "RMS-MON", "RMS-MON": "RMS-MON", "MON": "RMS-MON",
    "OMS": "OMS",
}
INTERVAL_DAYS = {"RMS-WEK": 7, "RMS-EOW": 14, "RMS-ETW": 21, "RMS-EFW": 28, "RMS-MON": 28}
ANCHOR_TOLERANCE_DAYS = 3
HISTORICAL_STATUSES = {"Closed", "Completed", "Scheduled"}
CANCELLED_STATUSES  = {"Cancelled", "Late Notice Cancel"}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def parse_mdy(s):
    """MM/DD/YYYY -> ISO 'YYYY-MM-DD' (or None)."""
    if not s: return None
    s = str(s).strip()
    if not s: return None
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            d = datetime.strptime(s, fmt).date()
            return d.isoformat()
        except ValueError:
            continue
    return None

def sql_str(v):
    """Escape a Python string for a SQL literal (returns 'value' or NULL)."""
    if v is None or v == "":
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"

def sql_date(v):
    """ISO date string -> 'YYYY-MM-DD'::date or NULL."""
    if not v: return "NULL"
    return "'" + v + "'::date"

def normalize_freq(raw):
    if not raw: return None
    key = re.sub(r"\s+", " ", str(raw).strip().upper())
    return FREQ_NORMALIZE.get(key) or FREQ_NORMALIZE.get(key.replace(" ", ""))

def normalize_external_id(v):
    if v is None: return None
    if isinstance(v, float): return str(int(v))
    s = str(v).strip()
    return s or None

def normalize_address_for_match(s):
    """Strip suffixes, lowercase, normalize street type for fuzzy matching."""
    if not s: return ""
    s = s.lower().strip()
    s = re.sub(r"[,\.]", " ", s)
    s = re.sub(r"\b(apt|unit|suite|ste|#)\s*\S+", "", s)
    s = re.sub(r"\b(street|st)\b", "st", s)
    s = re.sub(r"\b(road|rd)\b", "rd", s)
    s = re.sub(r"\b(avenue|ave)\b", "ave", s)
    s = re.sub(r"\b(drive|dr)\b", "dr", s)
    s = re.sub(r"\b(lane|ln)\b", "ln", s)
    s = re.sub(r"\b(court|ct)\b", "ct", s)
    s = re.sub(r"\b(circle|cir)\b", "cir", s)
    s = re.sub(r"\b(boulevard|blvd)\b", "blvd", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

def normalize_name(s):
    if not s: return ""
    return re.sub(r"[^\w\s]", "", s.lower()).strip()

# ---------------------------------------------------------------------------
# Phase 0 — Load all source data
# ---------------------------------------------------------------------------
def load_xls():
    import xlrd
    book = xlrd.open_workbook(XLS_PATH)
    sheet = book.sheet_by_index(0)
    rows = []
    headers = [sheet.cell_value(0, c) for c in range(sheet.ncols)]
    H = {h: i for i, h in enumerate(headers)}
    for r in range(1, sheet.nrows):
        get = lambda col: sheet.cell_value(r, H[col]) if col in H else ""
        # Deal with duplicate "City"/"State"/"Zip" headers — Location columns
        # are the ones AFTER 'Location Address' (index 11+ for this layout).
        loc_addr  = sheet.cell_value(r, 11) if sheet.ncols > 14 else ""
        loc_city  = sheet.cell_value(r, 12) if sheet.ncols > 14 else ""
        loc_state = sheet.cell_value(r, 13) if sheet.ncols > 14 else ""
        loc_zip   = sheet.cell_value(r, 14) if sheet.ncols > 14 else ""
        ext = normalize_external_id(get("Customer ID"))
        if not ext:
            continue
        # Use service location if present, else billing.
        addr  = (str(loc_addr) or get("Address")).strip() if loc_addr or get("Address") else ""
        city  = (str(loc_city) or "").strip() or str(get("City") or "").strip()
        state = (str(loc_state) or "").strip() or str(get("Prov/State") or "").strip()
        zipc  = str(loc_zip or get("Zip/Postal") or "").strip()
        rows.append({
            "external_id": ext,
            "first_name":  str(get("First Name") or "").strip(),
            "last_name":   str(get("Last Name") or "").strip(),
            "address":     addr,
            "city":        city,
            "state":       state,
            "zip_code":    zipc,
            "frequency":   normalize_freq(get("Job Frequency")),
            "last_service_date": parse_mdy(get("Last Service Date")),
            "next_service_date": parse_mdy(get("Next Service Date")),
            "package":     str(get("Package") or "").strip(),
        })
    # Dedup: keep last occurrence per external_id (assume later rows = newer)
    by_id = {}
    for row in rows:
        by_id[row["external_id"]] = row
    return list(by_id.values()), len(rows)

def load_jobs():
    """Returns (all_data_rows, by_customer_history, by_customer_cancellations)."""
    with open(JOBS_CSV_PATH, "rb") as f:
        raw = f.read().decode("utf-8", "replace")
    lines = raw.splitlines()  # handles the bare-\r row delimiters in this file
    reader = csv.reader(lines[3:])  # skip 'Export Job List', date range, header
    rows = list(reader)
    history = defaultdict(list)
    cancels = defaultdict(list)
    for r in rows:
        if len(r) < 12:
            continue
        cust = normalize_external_id(r[0])
        if not cust:
            continue
        status = r[7].strip()
        date_s = r[11].strip()  # MM/DD/YYYY
        iso = parse_mdy(date_s)
        if not iso:
            continue
        if status in HISTORICAL_STATUSES:
            history[cust].append(iso)
        elif status in CANCELLED_STATUSES:
            cancels[cust].append({"date": iso, "status": status, "summary": r[6].strip()})
    return rows, history, cancels

def load_keys():
    with open(KEYS_CSV_PATH, "r", newline="", encoding="utf-8") as f:
        rdr = csv.reader(f)
        rows = list(rdr)
    out = []
    for r in rows[1:]:
        if len(r) < 6: continue
        if r[5].strip().lower() == "inactive":
            continue
        # Header says First/Last but data has them SWAPPED:
        # col 1 'Customer Name' (full), col 2 = LAST name, col 3 = FIRST name
        out.append({
            "key_number":   r[0].strip(),
            "full_name":    r[1].strip(),
            "last_name":    r[2].strip(),
            "first_name":   r[3].strip(),
            "address":      r[4].strip(),
            "team":         r[7].strip() if len(r) > 7 else "",
        })
    return out

def load_snapshot():
    with open(SNAPSHOT_PATH) as f:
        return json.load(f)

# ---------------------------------------------------------------------------
# Phase 3 — Anchor derivation
# ---------------------------------------------------------------------------
def derive_anchor(history_dates, frequency, fallback_next):
    """
    Returns (anchor_iso, classification) where classification is:
      'oms'      — OMS frequency (no anchor concept)
      'sparse'   — fewer than 3 historical dates
      'clean'    — all gaps within tolerance
      'one_off'  — exactly one off-pattern gap
      'messy'    — multiple off-pattern gaps
    """
    if frequency == "OMS":
        return (None, "oms")
    if not frequency or frequency not in INTERVAL_DAYS:
        return (fallback_next, "sparse")
    if len(history_dates) < 3:
        return (fallback_next, "sparse")

    interval = INTERVAL_DAYS[frequency]
    sorted_dates = sorted(set(history_dates))
    parsed = [datetime.strptime(d, "%Y-%m-%d").date() for d in sorted_dates]

    # Find anchor that maximizes the number of historical dates that fit
    # the rhythm (date - anchor) % interval ≈ 0 within ±tolerance.
    best_anchor = None
    best_fit = -1
    for cand in parsed:
        fit = 0
        for d in parsed:
            delta = (d - cand).days
            if delta < 0: continue
            mod = delta % interval
            # Within ±tolerance of either 0 or interval
            if mod <= ANCHOR_TOLERANCE_DAYS or mod >= interval - ANCHOR_TOLERANCE_DAYS:
                fit += 1
        if fit > best_fit:
            best_fit = fit
            best_anchor = cand

    misses = len(parsed) - best_fit
    anchor_iso = best_anchor.isoformat()
    if misses == 0:
        return (anchor_iso, "clean")
    if misses == 1:
        return (anchor_iso, "one_off")
    return (fallback_next, "messy")

# ---------------------------------------------------------------------------
# Phase 5 — Key matching
# ---------------------------------------------------------------------------
def match_keys_to_clients(keys, snapshot, xls_clients):
    """Match each active key row to a Supabase client UUID by name+address.
    Returns (matched, unmatched) where matched is [(client_uuid, key_record)]."""
    # Build lookup: (last_lower, addr_first_token) -> client
    # snapshot has external_id, client_uuid, first_name, last_name (no address)
    # so we cross-reference xls_clients (which has address) to get a fuller index.
    xls_by_extid = {c["external_id"]: c for c in xls_clients}

    # Build candidate index keyed by (last_name_lower) -> list of (uuid, normalized_addr)
    by_last = defaultdict(list)
    for snap in snapshot:
        last = normalize_name(snap.get("last_name") or "")
        if not last: continue
        x = xls_by_extid.get(snap["external_id"])
        addr_norm = normalize_address_for_match(x["address"]) if x else ""
        by_last[last].append({
            "uuid": snap["client_uuid"],
            "external_id": snap["external_id"],
            "first_name": snap.get("first_name") or "",
            "last_name":  snap.get("last_name") or "",
            "addr_norm": addr_norm,
        })

    matched = []
    unmatched = []
    for k in keys:
        klast = normalize_name(k["last_name"])
        kaddr = normalize_address_for_match(k["address"])
        # Get street number + first word(s) of street
        kaddr_first = " ".join(kaddr.split()[:3]) if kaddr else ""
        cands = by_last.get(klast, [])
        hit = None
        for c in cands:
            cand_first = " ".join(c["addr_norm"].split()[:3]) if c["addr_norm"] else ""
            if kaddr_first and cand_first and (kaddr_first == cand_first or
                                                kaddr_first.startswith(cand_first[:max(5, len(cand_first)-3)]) or
                                                cand_first.startswith(kaddr_first[:max(5, len(kaddr_first)-3)])):
                hit = c
                break
        # Fallback: last name + first name match (same person, address may have moved)
        if not hit:
            kfirst = normalize_name(k["first_name"])
            for c in cands:
                if normalize_name(c["first_name"]) == kfirst:
                    hit = c
                    break
        if hit:
            matched.append((hit, k))
        else:
            unmatched.append(k)
    return matched, unmatched

# ---------------------------------------------------------------------------
# SQL artifact generation
# ---------------------------------------------------------------------------
def write_phase2_profiles_sql(updates, out_path):
    """Bulk UPDATE clients via UPDATE ... FROM (VALUES ...) AS u(...)."""
    if not updates:
        with open(out_path, "w") as f:
            f.write("-- Phase 2: no profile updates\n")
        return 0
    with open(out_path, "w") as f:
        f.write("-- Phase 2: bulk profile updates ({} clients)\n".format(len(updates)))
        f.write("-- Updates only: first_name, last_name, address, city, zip_code,\n")
        f.write("--   frequency, last_service_date, next_service_date, package, balance=0, status='active'\n")
        f.write("-- Does NOT touch: external_id, business_id, created_at, preferred_day,\n")
        f.write("--   preferred_time, notes\n\n")
        # Chunk to avoid one giant statement
        CHUNK = 100
        for i in range(0, len(updates), CHUNK):
            batch = updates[i:i+CHUNK]
            f.write("UPDATE clients SET\n")
            f.write("  first_name        = u.first_name,\n")
            f.write("  last_name         = u.last_name,\n")
            f.write("  address           = u.address,\n")
            f.write("  city              = u.city,\n")
            f.write("  zip_code          = u.zip_code,\n")
            f.write("  frequency         = u.frequency::frequency_code,\n")
            f.write("  last_service_date = u.last_service_date::date,\n")
            f.write("  next_service_date = u.next_service_date::date,\n")
            f.write("  package           = u.package,\n")
            f.write("  balance           = 0,\n")
            f.write("  status            = 'active'::client_status,\n")
            f.write("  updated_at        = now()\n")
            f.write("FROM (VALUES\n")
            rows = []
            for u in batch:
                rows.append("  ({eid}, {fn}, {ln}, {addr}, {city}, {zip}, {freq}, {lsd}, {nsd}, {pkg})".format(
                    eid=sql_str(u["external_id"]),
                    fn=sql_str(u["first_name"]),
                    ln=sql_str(u["last_name"]),
                    addr=sql_str(u["address"]),
                    city=sql_str(u["city"]),
                    zip=sql_str(u["zip_code"]),
                    freq=sql_str(u["frequency"]),
                    lsd=sql_str(u["last_service_date"]),
                    nsd=sql_str(u["next_service_date"]),
                    pkg=sql_str(u["package"]),
                ))
            f.write(",\n".join(rows))
            f.write("\n) AS u(external_id, first_name, last_name, address, city, zip_code, frequency, last_service_date, next_service_date, package)\n")
            f.write("WHERE clients.external_id = u.external_id\n")
            f.write("  AND clients.business_id = '{}'::uuid;\n\n".format(BUSINESS_ID))
    return len(updates)

def write_phase3_anchors_sql(anchor_updates, out_path):
    if not anchor_updates:
        with open(out_path, "w") as f: f.write("-- Phase 3: no anchor updates\n")
        return 0
    with open(out_path, "w") as f:
        f.write("-- Phase 3: bulk anchor_date updates ({} clients)\n\n".format(len(anchor_updates)))
        CHUNK = 100
        for i in range(0, len(anchor_updates), CHUNK):
            batch = anchor_updates[i:i+CHUNK]
            f.write("UPDATE clients SET\n")
            f.write("  anchor_date = u.anchor::date,\n")
            f.write("  updated_at  = now()\n")
            f.write("FROM (VALUES\n")
            rows = []
            for u in batch:
                rows.append("  ({eid}, {anc})".format(
                    eid=sql_str(u["external_id"]),
                    anc=sql_str(u["anchor"]),
                ))
            f.write(",\n".join(rows))
            f.write("\n) AS u(external_id, anchor)\n")
            f.write("WHERE clients.external_id = u.external_id\n")
            f.write("  AND clients.business_id = '{}'::uuid;\n\n".format(BUSINESS_ID))
    return len(anchor_updates)

def write_phase4_orphans_sql(orphans, out_path):
    with open(out_path, "w") as f:
        f.write("-- Phase 4: flip {} orphans to status='inactive'\n".format(len(orphans)))
        f.write("-- Sets next_service_date=NULL so they don't appear in 'upcoming' projections.\n")
        f.write("-- Does NOT soft-delete — rows kept for marketing/win-back.\n\n")
        if not orphans:
            f.write("-- (no orphans)\n")
            return 0
        ids = ", ".join(sql_str(o["external_id"]) for o in orphans)
        f.write("UPDATE clients SET\n")
        f.write("  status            = 'inactive'::client_status,\n")
        f.write("  status_changed_at = now(),\n")
        f.write("  next_service_date = NULL,\n")
        f.write("  updated_at        = now()\n")
        f.write("WHERE business_id = '{}'::uuid\n".format(BUSINESS_ID))
        f.write("  AND deleted_at IS NULL\n")
        f.write("  AND external_id IN ({});\n".format(ids))
    return len(orphans)

def write_phase5_keys_sql(matched_keys, clear_path, insert_path, inline_path):
    """Two SQL artifacts:
       - clear_path:  DELETE existing client_keys for this business (idempotency)
       - insert_path: INSERT all matched keys into client_keys
       - inline_path: UPDATE clients.key_code so the app shows them in the edit form
    """
    with open(clear_path, "w") as f:
        f.write("-- Phase 5a: clear existing client_keys for this business (idempotency)\n")
        f.write("DELETE FROM client_keys WHERE business_id = '{}'::uuid;\n".format(BUSINESS_ID))

    with open(insert_path, "w") as f:
        f.write("-- Phase 5b: insert {} matched keys into client_keys\n\n".format(len(matched_keys)))
        if not matched_keys:
            f.write("-- (no matches)\n")
        else:
            f.write("INSERT INTO client_keys (business_id, client_id, key_code, notes) VALUES\n")
            rows = []
            for client, k in matched_keys:
                note = "Imported from TMConnect Keylist · matched on {} {}".format(
                    client["first_name"], client["last_name"])
                rows.append("  ('{biz}'::uuid, '{cid}'::uuid, {code}, {note})".format(
                    biz=BUSINESS_ID,
                    cid=client["uuid"],
                    code=sql_str(k["key_number"]),
                    note=sql_str(note),
                ))
            f.write(",\n".join(rows))
            f.write(";\n")

    with open(inline_path, "w") as f:
        f.write("-- Phase 5c: also write key_code inline on clients (app edit form reads this)\n\n")
        if not matched_keys:
            f.write("-- (no matches)\n")
        else:
            f.write("UPDATE clients SET\n  key_code = u.key_code,\n  updated_at = now()\nFROM (VALUES\n")
            rows = []
            for client, k in matched_keys:
                rows.append("  ('{cid}'::uuid, {code})".format(
                    cid=client["uuid"], code=sql_str(k["key_number"])))
            f.write(",\n".join(rows))
            f.write("\n) AS u(client_id, key_code)\nWHERE clients.id = u.client_id;\n")
    return len(matched_keys)

def write_phase6_cancellations_sql(cancels_by_uuid, clear_path, insert_path):
    """Insert one row per cancellation into client_cancellations.
    Idempotent via a clear-first pattern."""
    with open(clear_path, "w") as f:
        f.write("-- Phase 6a: clear existing cancellations for this business (idempotency)\n")
        f.write("DELETE FROM client_cancellations WHERE business_id = '{}'::uuid;\n".format(BUSINESS_ID))

    flat = []
    for uuid, events in cancels_by_uuid.items():
        for ev in events:
            flat.append((uuid, ev["date"], ev["status"], ev.get("summary") or None))

    with open(insert_path, "w") as f:
        f.write("-- Phase 6b: insert {} cancellation events across {} clients\n".format(
            len(flat), len(cancels_by_uuid)))
        f.write("-- Schema: business_id, client_id, cancelled_date, reason, reason_category\n\n")
        if not flat:
            f.write("-- (no cancellations)\n")
            return 0, 0
        CHUNK = 200
        for i in range(0, len(flat), CHUNK):
            batch = flat[i:i+CHUNK]
            f.write("INSERT INTO client_cancellations (business_id, client_id, cancelled_date, reason, reason_category) VALUES\n")
            rows = []
            for uuid, dt, status, summary in batch:
                rows.append("  ('{biz}'::uuid, '{cid}'::uuid, {dt}, {sum}, {cat})".format(
                    biz=BUSINESS_ID, cid=uuid,
                    dt=sql_date(dt),
                    sum=sql_str(summary),
                    cat=sql_str(status),
                ))
            f.write(",\n".join(rows))
            f.write(";\n\n")
    return len(flat), len(cancels_by_uuid)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Compute and print summary; skip writing artifacts and CSVs")
    args = ap.parse_args()

    print("=" * 60)
    print("BIG IMPORT — TMConnect → Penta")
    print("=" * 60)

    # --- Phase 1: pre-flight -------------------------------------------------
    print("\n[Phase 1] Pre-flight checks")
    for path, label in [(XLS_PATH, "client xls"),
                         (JOBS_CSV_PATH, "job list csv"),
                         (KEYS_CSV_PATH, "keys csv"),
                         (SNAPSHOT_PATH, "DB snapshot")]:
        if not os.path.exists(path):
            print("  FAIL: missing {} at {}".format(label, path))
            sys.exit(1)
        print("  OK  {}: {}".format(label, path))

    snapshot = load_snapshot()
    print("  DB snapshot: {} active+paused clients".format(len(snapshot)))

    xls_clients, xls_total_rows = load_xls()
    print("  xls: {} unique customers ({} raw rows, {} dupes deduped)".format(
        len(xls_clients), xls_total_rows, xls_total_rows - len(xls_clients)))

    job_rows, history, cancels = load_jobs()
    n_hist = sum(len(v) for v in history.values())
    n_canc = sum(len(v) for v in cancels.values())
    print("  jobs: {} rows; {} historical (Closed/Completed/Scheduled), {} cancellations".format(
        len(job_rows), n_hist, n_canc))

    keys = load_keys()
    print("  keys: {} active rows (skipped Inactive)".format(len(keys)))

    # --- Phase 2: profile updates --------------------------------------------
    print("\n[Phase 2] Profile updates (xls → clients)")
    snap_extids = {s["external_id"] for s in snapshot}
    profile_updates = []
    new_clients = []
    for c in xls_clients:
        if c["external_id"] in snap_extids:
            profile_updates.append(c)
        else:
            new_clients.append(c)
    print("  to update: {} clients".format(len(profile_updates)))
    print("  in xls but NOT in DB (new — review): {}".format(len(new_clients)))

    # --- Phase 3: anchor derivation ------------------------------------------
    print("\n[Phase 3] Anchor derivation from job history")
    snap_by_extid = {s["external_id"]: s for s in snapshot}
    anchor_updates = []
    classification_counts = Counter()
    messy_review = []
    for c in xls_clients:
        ext = c["external_id"]
        snap = snap_by_extid.get(ext)
        if not snap: continue  # new clients handled separately
        freq = c["frequency"]
        hist = history.get(ext, [])
        anchor, klass = derive_anchor(hist, freq, c["next_service_date"])
        classification_counts[klass] += 1
        if anchor and klass != "oms":
            anchor_updates.append({"external_id": ext, "anchor": anchor, "classification": klass})
        if klass == "messy":
            messy_review.append({
                "external_id": ext,
                "name": "{} {}".format(c["first_name"], c["last_name"]),
                "frequency": freq,
                "history_count": len(hist),
                "history_dates": ";".join(hist[-10:]),  # last 10
                "next_service_date": c["next_service_date"],
                "anchor_default": anchor,
            })
    print("  total xls clients in DB: {}".format(sum(classification_counts.values())))
    print("  classifications: {}".format(dict(classification_counts)))
    print("  anchors to update: {}".format(len(anchor_updates)))
    print("  messy (review needed): {}".format(len(messy_review)))

    # --- Phase 4: orphans ----------------------------------------------------
    print("\n[Phase 4] Orphan handling")
    xls_extids = {c["external_id"] for c in xls_clients}
    orphans = [s for s in snapshot if s["external_id"] not in xls_extids]
    print("  orphans (in DB but not in xls): {}".format(len(orphans)))
    for o in orphans[:10]:
        print("    - {}: {} {} (status={})".format(
            o["external_id"], o.get("first_name") or "?", o.get("last_name") or "?", o["status"]))
    if len(orphans) > 10:
        print("    ... and {} more".format(len(orphans) - 10))

    # --- Phase 5: keys -------------------------------------------------------
    print("\n[Phase 5] Key import")
    matched_keys, unmatched_keys = match_keys_to_clients(keys, snapshot, xls_clients)
    print("  matched: {}".format(len(matched_keys)))
    print("  unmatched: {} (will be reviewed in CSV)".format(len(unmatched_keys)))

    # --- Phase 6: cancellation backfill --------------------------------------
    print("\n[Phase 6] Cancellation backfill (Option C: client_cancellations table)")
    snap_uuid_by_extid = {s["external_id"]: s["client_uuid"] for s in snapshot}
    cancels_by_uuid = defaultdict(list)
    skipped_no_uuid = 0
    for ext, events in cancels.items():
        uuid = snap_uuid_by_extid.get(ext)
        if not uuid:
            skipped_no_uuid += len(events)
            continue
        cancels_by_uuid[uuid].extend(events)
    n_events = sum(len(v) for v in cancels_by_uuid.values())
    print("  cancellation events to backfill: {} across {} clients".format(
        n_events, len(cancels_by_uuid)))
    if skipped_no_uuid:
        print("  skipped (no DB client match): {} events (orphan customer IDs)".format(skipped_no_uuid))

    # --- Write artifacts -----------------------------------------------------
    if args.dry_run:
        print("\n--dry-run: skipping artifact writes")
    else:
        os.makedirs(OUT_DIR, exist_ok=True)
        n2 = write_phase2_profiles_sql(profile_updates, OUT_DIR + "/phase2_profiles.sql")
        n3 = write_phase3_anchors_sql(anchor_updates, OUT_DIR + "/phase3_anchors.sql")
        n4 = write_phase4_orphans_sql(orphans, OUT_DIR + "/phase4_orphans.sql")
        n5 = write_phase5_keys_sql(matched_keys,
                                   OUT_DIR + "/phase5_keys_clear.sql",
                                   OUT_DIR + "/phase5_keys_insert.sql",
                                   OUT_DIR + "/phase5_keys_inline.sql")
        n6_events, n6_clients = write_phase6_cancellations_sql(cancels_by_uuid,
                                   OUT_DIR + "/phase6_cancellations_clear.sql",
                                   OUT_DIR + "/phase6_cancellations.sql")
        print("\n[Artifacts written to {}/]".format(OUT_DIR))
        for name in sorted(os.listdir(OUT_DIR)):
            if name.endswith(".sql"):
                p = os.path.join(OUT_DIR, name)
                print("  {} ({:,} bytes)".format(name, os.path.getsize(p)))

        # Review CSVs
        os.makedirs(DESKTOP, exist_ok=True)
        with open(os.path.join(DESKTOP, "anchor_anomalies_messy.csv"), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["external_id","name","frequency","history_count","history_dates","next_service_date","anchor_default"])
            w.writeheader()
            for r in messy_review: w.writerow(r)
        with open(os.path.join(DESKTOP, "key_unmatched.csv"), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["key_number","full_name","first_name","last_name","address","team"])
            w.writeheader()
            for r in unmatched_keys: w.writerow(r)
        with open(os.path.join(DESKTOP, "new_clients_review.csv"), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["external_id","first_name","last_name","address","city","state","zip_code","frequency","last_service_date","next_service_date","package"])
            w.writeheader()
            for r in new_clients: w.writerow(r)
        print("\n[Review CSVs written to {}/]".format(DESKTOP))
        print("  anchor_anomalies_messy.csv ({} rows)".format(len(messy_review)))
        print("  key_unmatched.csv ({} rows)".format(len(unmatched_keys)))
        print("  new_clients_review.csv ({} rows)".format(len(new_clients)))

    # --- Plan summary --------------------------------------------------------
    print("\n" + "=" * 60)
    print("PLAN SUMMARY (no DB writes performed by this script)")
    print("=" * 60)
    print("Profile updates:      {} clients".format(len(profile_updates)))
    print("Anchor derivations:   {} (clean: {}, one-off: {}, messy: {}, sparse: {}, oms: {})".format(
        len(anchor_updates),
        classification_counts["clean"],
        classification_counts["one_off"],
        classification_counts["messy"],
        classification_counts["sparse"],
        classification_counts["oms"],
    ))
    print("Orphans → inactive:   {}".format(len(orphans)))
    print("Keys imported:        {} matched / {} unmatched".format(
        len(matched_keys), len(unmatched_keys)))
    print("Cancellations:        {} events / {} clients".format(n_events, len(cancels_by_uuid)))
    print("New clients (review): {}".format(len(new_clients)))
    print()
    print("Next: assistant applies SQL artifacts via Supabase MCP.")
    print("=" * 60)

if __name__ == "__main__":
    main()
