import json
import os
import re
import secrets
import sqlite3
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from flask import Flask, g, jsonify, redirect, render_template, request, send_file, session, url_for
from werkzeug.security import generate_password_hash


ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "database.db"
PHOTO_DIRECTORY = ROOT / "instance" / "report_uploads"
MAX_PHOTO_BYTES = 2 * 1024 * 1024
LOCAL_OPERATOR_EMAIL = "local-operator@safesignal.invalid"
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 3 * 1024 * 1024
app.config.update(
    SECRET_KEY=os.environ.get("SAFESIGNAL_SECRET_KEY") or secrets.token_hex(32),
    READ_ONLY=os.environ.get("SAFESIGNAL_READ_ONLY", "").lower() in {"1", "true", "yes"},
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("SAFESIGNAL_COOKIE_SECURE") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
)

ALERTS = [
    {"id": "a-01", "title": "Monsoon watch: river levels", "type": "Flood", "severity": "WATCH", "location": "Demo: Riverside district", "time": "Today, 09:20", "status": "Monitoring", "source": "SafeSignal demo scenario", "expires": "Today, 18:00", "details": "Simulated monitoring notice for demonstration only. Check official local advisories for current conditions."},
    {"id": "a-02", "title": "Coastal preparedness advisory", "type": "Cyclone", "severity": "INFORMATION", "location": "Demo: Coastal region", "time": "Today, 08:05", "status": "Active", "source": "SafeSignal demo scenario", "expires": "Tomorrow, 08:00", "details": "Preparedness reminder only; this is not a live weather bulletin or forecast."},
    {"id": "a-03", "title": "Community-reported road obstruction", "type": "Road blockage", "severity": "WARNING", "location": "Demo: Hillview route", "time": "Yesterday, 17:45", "status": "Under review", "source": "Simulated community report", "expires": "Pending verification", "details": "Simulated, unverified report. Do not rely on this entry for route planning."},
]

MAP_POINTS = [
    {"id": 1, "type": "Flood reports", "title": "Waterlogging (simulated)", "lat": 13.0827, "lng": 80.2707, "status": "Unverified", "detail": "Example community report; no active incident implied."},
    {"id": 2, "type": "Cyclone information", "title": "Preparedness zone (simulated)", "lat": 12.9141, "lng": 80.2300, "status": "Demo", "detail": "Illustrative marker only. Not a forecast or live advisory."},
    {"id": 3, "type": "Fire reports", "title": "Fire response exercise (simulated)", "lat": 13.0569, "lng": 80.2425, "status": "Demo", "detail": "Training scenario marker."},
    {"id": 4, "type": "Landslide reports", "title": "Slope observation (simulated)", "lat": 13.1350, "lng": 80.2120, "status": "Unverified", "detail": "Illustrative, unverified community report."},
    {"id": 5, "type": "Earthquake information", "title": "Preparedness point (simulated)", "lat": 13.0100, "lng": 80.2350, "status": "Demo", "detail": "Preparedness information only; no earthquake event implied."},
    {"id": 6, "type": "Relief camps", "title": "Demo relief centre", "lat": 13.0674, "lng": 80.2480, "status": "Demo location", "detail": "Not an operational shelter. Verify locations with local authorities."},
    {"id": 7, "type": "Hospitals", "title": "Demo medical point", "lat": 13.0990, "lng": 80.2820, "status": "Demo location", "detail": "Illustrative location; contact details and capacity are not verified."},
    {"id": 8, "type": "Community reports", "title": "Water request (simulated)", "lat": 13.0400, "lng": 80.2600, "status": "Under review", "detail": "Simulated community report; not verified."},
    {"id": 9, "type": "Road closure reports", "title": "Road access note (simulated)", "lat": 13.1150, "lng": 80.2500, "status": "Unverified", "detail": "Example only; check official traffic information."},
]

PREPAREDNESS = {
    "Floods": {
        "before": ["Know your local flood routes and higher ground.", "Store clean water, medication, a torch and a battery radio.", "Keep important documents in a sealed waterproof pouch."],
        "during": ["Follow official evacuation instructions promptly.", "Never walk or drive through floodwater.", "Switch off electricity only if it is safe to do so."],
        "after": ["Avoid floodwater and damaged buildings.", "Use safe drinking water and follow public health advice.", "Document damage only when safe."],
    },
    "Cyclones": {
        "before": ["Secure loose outdoor items and protect important documents.", "Charge phones and prepare essential medicines.", "Know your nearest official evacuation centre."],
        "during": ["Stay indoors away from windows.", "Do not go outside during a calm period; conditions may change suddenly.", "Follow official warnings and evacuation instructions."],
        "after": ["Watch for downed wires, debris and damaged structures.", "Use phones for urgent communication only.", "Return only when authorities say it is safe."],
    },
    "Earthquakes": {
        "before": ["Secure heavy furniture and identify safe cover.", "Practise Drop, Cover and Hold On.", "Keep a small emergency kit accessible."],
        "during": ["Drop, Cover and Hold On; stay away from windows.", "If outdoors, move away from buildings and power lines.", "Do not use lifts."],
        "after": ["Expect aftershocks and move carefully.", "Leave damaged buildings and avoid unsafe areas.", "Check for injuries and contact emergency services when needed."],
    },
    "Fires": {
        "before": ["Check smoke alarms and plan two exit routes.", "Keep exits clear and store flammables safely.", "Learn how to use an extinguisher only if trained."],
        "during": ["Raise the alarm and leave immediately if unsafe.", "Stay low under smoke and use stairs, not lifts.", "Never re-enter a burning building."],
        "after": ["Wait for authorities to confirm re-entry is safe.", "Seek medical help for smoke inhalation or burns.", "Report hazards to the appropriate local service."],
    },
    "Landslides": {
        "before": ["Know local warning signs and safer routes.", "Keep emergency supplies accessible.", "Report new ground cracks or unusual water flow to authorities."],
        "during": ["Move away from the slide path if safe.", "Avoid river valleys and low areas during heavy rain.", "Follow official evacuation instructions."],
        "after": ["Stay away from the slide area; further movement may occur.", "Watch for damaged utilities and roads.", "Return only after authorities declare the area safe."],
    },
    "Heatwaves": {
        "before": ["Plan to stay cool and check on at-risk neighbours.", "Keep water and essential medicines available.", "Know where local cooling support is available."],
        "during": ["Drink water regularly and avoid strenuous activity in peak heat.", "Move to a cool place and wear light clothing.", "Seek urgent medical help for signs of heat illness."],
        "after": ["Continue hydration and rest.", "Check on people who may need assistance.", "Report heat-related health concerns to a medical professional."],
    },
}
SAFE_VOLUNTEER_ACTIVITIES = {
    "Not assigned",
    "Information desk support",
    "Relief kit packing",
    "Neighbour check-in calls",
    "Translation support",
    "Data entry",
}
FLOOD_SIMULATION_ACTIVE = False
FLOOD_ZONES = [
    {"name": "Demo Riverside zone", "coordinates": [[13.090, 80.255], [13.105, 80.278], [13.083, 80.300], [13.064, 80.278]]},
    {"name": "Demo East Ward zone", "coordinates": [[13.072, 80.291], [13.086, 80.315], [13.061, 80.329], [13.048, 80.304]]},
]
FLOOD_VOLUNTEER_TASKS = [
    {"title": "Pack water and food kits", "area": "Demo: Central support hub", "safety": "Indoor, non-hazardous coordination"},
    {"title": "Share verified preparedness information", "area": "Demo: Community information desk", "safety": "Use official messages only"},
    {"title": "Make opt-in neighbour check-in calls", "area": "Demo: Remote coordination", "safety": "Phone-based; no field deployment"},
]
FLOOD_ACTION_PLAN = {
    "English": [
        "Check official local flood and evacuation updates before taking action.",
        "If instructed, move people, essential medicines and documents to safer higher ground.",
        "Never walk or drive through floodwater; avoid drains and fast-moving water.",
        "Keep phones charged and use this demo report form only for platform testing—it does not dispatch help.",
        "If in immediate danger, contact local emergency services and follow official instructions.",
    ],
    "Tamil": [
        "செயல்படுவதற்கு முன், உள்ளூர் அதிகாரிகளின் வெள்ளம் மற்றும் வெளியேற்ற அறிவிப்புகளைச் சரிபார்க்கவும்.",
        "அறிவுறுத்தப்பட்டால், மக்களை, அத்தியாவசிய மருந்துகளை மற்றும் ஆவணங்களை பாதுகாப்பான உயரமான இடத்திற்கு மாற்றவும்.",
        "வெள்ள நீரில் ஒருபோதும் நடக்கவோ வாகனம் ஓட்டவோ வேண்டாம்; வடிகால்கள் மற்றும் வேகமாக ஓடும் நீரைத் தவிர்க்கவும்.",
        "தொலைபேசியை சார்ஜ் செய்து வைத்திருங்கள். இந்த மாதிரி அறிக்கைப் படிவம் சோதனைக்காக மட்டுமே; இது உதவியை அனுப்பாது.",
        "உடனடி ஆபத்து இருந்தால், உள்ளூர் அவசர சேவைகளைத் தொடர்புகொண்டு அதிகாரப்பூர்வ அறிவுறுத்தல்களைப் பின்பற்றுங்கள்.",
    ],
}


@contextmanager
def connect_db():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except (OSError, sqlite3.Error):
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_db():
    with connect_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('admin','member')),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                incident_type TEXT NOT NULL,
                description TEXT NOT NULL,
                area TEXT NOT NULL,
                latitude REAL,
                longitude REAL,
                severity TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'Submitted',
                created_at TEXT NOT NULL,
                photo_name TEXT
            );
            CREATE TABLE IF NOT EXISTS resources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                quantity INTEGER NOT NULL CHECK(quantity >= 0),
                unit TEXT NOT NULL,
                area TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS volunteers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                skills TEXT NOT NULL,
                area TEXT NOT NULL,
                availability TEXT NOT NULL,
                activity TEXT NOT NULL DEFAULT 'Not assigned',
                status TEXT NOT NULL DEFAULT 'Available',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS checklist (
                user_id INTEGER NOT NULL REFERENCES users(id),
                item_key TEXT NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(user_id, item_key)
            );
            """
        )
        checklist_columns = {row["name"] for row in db.execute("PRAGMA table_info(checklist)").fetchall()}
        if "user_id" not in checklist_columns:
            db.execute("ALTER TABLE checklist RENAME TO checklist_legacy")
            db.execute(
                """CREATE TABLE checklist (
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    item_key TEXT NOT NULL,
                    completed INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(user_id, item_key)
                )"""
            )
        migrate_legacy_checklist(db)
        operator = db.execute(
            "SELECT id FROM users WHERE email=? COLLATE NOCASE", (LOCAL_OPERATOR_EMAIL,)
        ).fetchone()
        if operator:
            operator_id = operator["id"]
            db.execute(
                "UPDATE users SET name='Local operator',role='admin' WHERE id=?",
                (operator_id,),
            )
        else:
            cursor = db.execute(
                "INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)",
                (
                    "Local operator",
                    LOCAL_OPERATOR_EMAIL,
                    generate_password_hash(secrets.token_urlsafe(48)),
                    "admin",
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            operator_id = cursor.lastrowid
        migrate_legacy_checklist(db, operator_id)
        if db.execute("SELECT COUNT(*) FROM resources").fetchone()[0] == 0:
            now = datetime.now(timezone.utc).isoformat()
            demo_resources = [
                ("Drinking water", "Water", 840, "bottles", "Demo: Central store"),
                ("Family food packs", "Food", 145, "packs", "Demo: Central store"),
                ("First-aid kits", "Medical", 28, "kits", "Demo: East hub"),
                ("Thermal blankets", "Shelter", 12, "blankets", "Demo: East hub"),
                ("Emergency supply kits", "Supplies", 6, "kits", "Demo: North hub"),
                ("Shelter capacity", "Shelter capacity", 72, "places", "Demo: Community hall"),
            ]
            db.executemany(
                "INSERT INTO resources(name,category,quantity,unit,area,updated_at) VALUES(?,?,?,?,?,?)",
                [item + (now,) for item in demo_resources],
            )
        if db.execute("SELECT COUNT(*) FROM volunteers").fetchone()[0] == 0:
            now = datetime.now(timezone.utc).isoformat()
            db.executemany(
                "INSERT INTO volunteers(name,skills,area,availability,activity,status,created_at) VALUES(?,?,?,?,?,?,?)",
                [
                    ("Demo volunteer A", "First aid, translation", "Demo: Central", "Available", "Information desk support", "Available", now),
                    ("Demo volunteer B", "Logistics, packing", "Demo: East", "Available", "Relief kit packing", "Available", now),
                    ("Demo volunteer C", "Community outreach", "Demo: North", "On task", "Neighbour check-in calls", "Assigned", now),
                ],
            )


def migrate_legacy_checklist(db, user_id=None):
    legacy_table = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='checklist_legacy'"
    ).fetchone()
    if not legacy_table:
        return
    owner = user_id or db.execute("SELECT id FROM users ORDER BY id LIMIT 1").fetchone()
    if not owner:
        return
    owner_id = owner if isinstance(owner, int) else owner["id"]
    db.execute(
        "INSERT OR IGNORE INTO checklist(user_id,item_key,completed,updated_at) "
        "SELECT ?,item_key,completed,updated_at FROM checklist_legacy",
        (owner_id,),
    )
    db.execute("DROP TABLE checklist_legacy")


def csrf_token_is_valid():
    supplied = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
    expected = session.get("csrf_token")
    return bool(supplied and expected and secrets.compare_digest(supplied, expected))


@app.before_request
def prepare_local_workspace():
    if request.endpoint == "static":
        return None
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)
    with connect_db() as db:
        g.current_user = db.execute(
            "SELECT id,name,email,role FROM users WHERE email=? COLLATE NOCASE",
            (LOCAL_OPERATOR_EMAIL,),
        ).fetchone()
    if g.current_user is None:
        message = "The local workspace is not initialized. Restart the SafeSignal app."
        if request.path.startswith("/api/"):
            return jsonify({"error": message}), 503
        return message, 503
    if (
        app.config["READ_ONLY"]
        and request.method in {"POST", "PUT", "PATCH", "DELETE"}
        and request.path not in {"/api/assistant", "/api/translate"}
    ):
        message = "This public SafeSignal demo is read-only. Changes are disabled."
        if request.path.startswith("/api/"):
            return jsonify({"error": message}), 403
        return message, 403
    if request.method in {"POST", "PUT", "PATCH", "DELETE"} and not csrf_token_is_valid():
        if request.path.startswith("/api/"):
            return jsonify({"error": "Your session expired. Reload and try again."}), 403
        return "Your session expired. Reload and try again.", 403
    return None


@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    if not request.path.startswith("/static/") or request.path == "/static/sw.js":
        response.headers["Cache-Control"] = "no-store"
    return response


@app.context_processor
def inject_csrf_token():
    return {"csrf_token": session.get("csrf_token", ""), "read_only": app.config["READ_ONLY"]}


@app.route("/login", methods=["GET", "POST"])
@app.route("/register", methods=["GET", "POST"])
@app.post("/logout")
def redirect_auth_routes():
    return redirect(url_for("home"))


@app.get("/")
def home():
    return render_template("index.html", current_user=g.current_user, csrf_token=session["csrf_token"])


@app.get("/api/overview")
def overview():
    with connect_db() as db:
        report_count = db.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
        assistance_rows = db.execute(
            "SELECT * FROM reports WHERE incident_type='Medical assistance' AND status NOT IN ('Resolved','Rejected') ORDER BY id DESC LIMIT 5"
        ).fetchall()
        assistance_count = db.execute(
            "SELECT COUNT(*) FROM reports WHERE incident_type='Medical assistance' AND status NOT IN ('Resolved','Rejected')"
        ).fetchone()[0]
        resource_rows = db.execute("SELECT * FROM resources ORDER BY category, name").fetchall()
        volunteer_count = db.execute("SELECT COUNT(*) FROM volunteers").fetchone()[0]
        recent_reports = db.execute("SELECT * FROM reports ORDER BY id DESC LIMIT 5").fetchall()
        since = (datetime.now(timezone.utc) - timedelta(days=6)).date().isoformat()
        daily_reports = db.execute(
            "SELECT substr(created_at,1,10) AS day,COUNT(*) AS count FROM reports WHERE substr(created_at,1,10)>=? GROUP BY day ORDER BY day",
            (since,),
        ).fetchall()
    resources = [dict(row) for row in resource_rows]
    simulation = build_flood_simulation(resources) if FLOOD_SIMULATION_ACTIVE else None
    active_alerts = ([simulation["alert"]] if simulation else []) + ALERTS
    counts = {"INFORMATION": 0, "WATCH": 0, "WARNING": 0, "CRITICAL": 0}
    for alert in active_alerts:
        counts[alert["severity"]] += 1
    return jsonify({
        "simulated": True,
        "reports_count": report_count,
        "rescue_request_count": assistance_count,
        "rescue_requests": [serialize_report(row) for row in assistance_rows],
        "active_incidents": len(active_alerts),
        "affected_locations": 5,
        "volunteer_count": volunteer_count,
        "alerts": active_alerts,
        "severity_counts": counts,
        "resources": resources,
        "shortages": sum(1 for item in resources if item["quantity"] <= 20),
        "recent_reports": [serialize_report(row) for row in recent_reports],
        "report_daily": [dict(row) for row in daily_reports],
        "report_count_is_user_submissions_only": True,
        "flood_simulation": simulation,
    })


def require_admin():
    if g.current_user["role"] != "admin":
        return jsonify({"error": "Administrator access is required for this action."}), 403
    return None


@app.get("/api/alerts")
def alerts():
    simulation = build_flood_simulation([]) if FLOOD_SIMULATION_ACTIVE else None
    return jsonify({"simulated": True, "alerts": ([simulation["alert"]] if simulation else []) + ALERTS})


@app.get("/api/map-points")
def map_points():
    with connect_db() as db:
        rows = db.execute(
            "SELECT id,incident_type,area,latitude,longitude,status,created_at FROM reports WHERE latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY id DESC"
        ).fetchall()
    community_points = [
        {
            "id": f"report-{row['id']}",
            "type": "Community reports",
            "title": f"Community report #{row['id']}: {row['incident_type']}",
            "lat": row["latitude"],
            "lng": row["longitude"],
            "status": row["status"],
            "detail": f"User-submitted report for {row['area']}. Status: {row['status']}. Verify information before relying on it.",
            "simulated": False,
        }
        for row in rows
    ]
    return jsonify({
        "simulated": True,
        "points": MAP_POINTS + community_points,
        "community_report_count": len(community_points),
        "flood_zones": FLOOD_ZONES if FLOOD_SIMULATION_ACTIVE else [],
    })


@app.post("/api/simulation/flood")
def start_flood_simulation():
    global FLOOD_SIMULATION_ACTIVE
    FLOOD_SIMULATION_ACTIVE = True
    with connect_db() as db:
        resources = [dict(row) for row in db.execute("SELECT * FROM resources").fetchall()]
    return jsonify({"simulation": build_flood_simulation(resources)})


@app.post("/api/simulation/reset")
def reset_simulation():
    global FLOOD_SIMULATION_ACTIVE
    FLOOD_SIMULATION_ACTIVE = False
    return jsonify({"active": False, "message": "Flood simulation reset. Saved reports, resources and volunteer records were not changed."})


def build_flood_simulation(resources):
    resource_needs = [
        ("Water", "Drinking water", 900, "bottles"),
        ("Food", "Family food packs", 180, "packs"),
        ("Medical", "First-aid kits", 35, "kits"),
        ("Shelter", "Thermal blankets", 30, "blankets"),
        ("Shelter capacity", "Shelter capacity", 100, "places"),
    ]
    shortages = []
    for category, name, required, unit in resource_needs:
        available = sum(int(item["quantity"]) for item in resources if item["category"] == category)
        if available < required:
            shortages.append({"category": category, "name": name, "required": required, "available": available, "shortage": required - available, "unit": unit})
    return {
        "active": True,
        "simulated": True,
        "title": "Flood response exercise",
        "alert": {
            "id": "sim-flood-01",
            "title": "Flood simulation: response exercise active",
            "type": "Flood",
            "severity": "CRITICAL",
            "location": "Demo: Riverside and East Ward zones",
            "time": "Simulation active now",
            "status": "SIMULATION",
            "source": "SafeSignal Flood Simulation",
            "expires": "When reset",
            "details": "Simulated scenario only. This is not a real flood alert or live hazard assessment.",
        },
        "affected_areas": ["Demo Riverside zone", "Demo East Ward zone", "Demo Canal Road corridor"],
        "zones": FLOOD_ZONES,
        "resource_shortages": shortages,
        "volunteer_tasks": FLOOD_VOLUNTEER_TASKS,
        "action_plan": FLOOD_ACTION_PLAN,
        "note": "All affected areas, alert severity, demands and tasks are fictional exercise data. Saved inventory is not modified.",
    }


@app.route("/api/reports", methods=["GET", "POST"])
def reports():
    if request.method == "GET":
        status = request.args.get("status", "").strip()
        category = request.args.get("category", "").strip()
        query = "SELECT * FROM reports WHERE 1=1"
        params = []
        if status and status != "All statuses":
            query += " AND status=?"
            params.append(status)
        if category and category != "All categories":
            query += " AND incident_type=?"
            params.append(category)
        query += " ORDER BY id DESC"
        with connect_db() as db:
            rows = db.execute(query, params).fetchall()
        return jsonify({"reports": [serialize_report(row) for row in rows]})

    data = request.form if request.form else (request.get_json(silent=True) or {})
    incident_type = str(data.get("incident_type", "")).strip()[:60]
    description = str(data.get("description", "")).strip()[:1200]
    area = str(data.get("area", "")).strip()[:120]
    severity = str(data.get("severity", "WATCH")).upper()
    allowed_types = {"Flooding", "Road blockage", "Fallen trees", "Infrastructure damage", "Fire incident", "Power outage", "Medical assistance", "Water shortage", "Food shortage", "Other emergency"}
    if incident_type not in allowed_types or not (10 <= len(description) <= 1200) or not area:
        return jsonify({"error": "Choose an incident type, enter an area, and provide at least 10 characters of detail."}), 400
    if severity not in {"INFORMATION", "WATCH", "WARNING", "CRITICAL"}:
        return jsonify({"error": "Select a valid severity."}), 400
    raw_latitude, raw_longitude = data.get("latitude"), data.get("longitude")
    latitude = parse_coordinate(raw_latitude, -90, 90)
    longitude = parse_coordinate(raw_longitude, -180, 180)
    if raw_latitude not in (None, "") and latitude is None:
        return jsonify({"error": "Latitude must be between -90 and 90."}), 400
    if raw_longitude not in (None, "") and longitude is None:
        return jsonify({"error": "Longitude must be between -180 and 180."}), 400
    photo = request.files.get("photo") if request.files else None
    photo_name = None
    photo_content = None
    if photo and photo.filename:
        photo_content = photo.read(MAX_PHOTO_BYTES + 1)
        if len(photo_content) > MAX_PHOTO_BYTES:
            return jsonify({"error": "Photo must be 2 MB or smaller."}), 400
        photo_extension = image_extension(photo_content)
        if not photo_extension:
            return jsonify({"error": "Upload a valid JPEG, PNG or WebP image."}), 400
        photo_name = f"{uuid4().hex}{photo_extension}"
    try:
        with connect_db() as db:
            cursor = db.execute(
                "INSERT INTO reports(incident_type,description,area,latitude,longitude,severity,status,created_at,photo_name) VALUES(?,?,?,?,?,?,?,?,?)",
                (incident_type, description, area, latitude, longitude, severity, "Submitted", datetime.now(timezone.utc).isoformat(), photo_name),
            )
            if photo_content:
                PHOTO_DIRECTORY.mkdir(parents=True, exist_ok=True)
                (PHOTO_DIRECTORY / photo_name).write_bytes(photo_content)
            row = db.execute("SELECT * FROM reports WHERE id=?", (cursor.lastrowid,)).fetchone()
    except Exception:
        if photo_name:
            (PHOTO_DIRECTORY / photo_name).unlink(missing_ok=True)
        raise
    return jsonify({"report": serialize_report(row), "message": "Report submitted for review. It has not been verified or sent to authorities."}), 201


def image_extension(content):
    if content.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return ".webp"
    return None


def serialize_report(row):
    report = dict(row)
    report["has_photo"] = bool(report.pop("photo_name", None))
    return report


@app.get("/api/reports/<int:report_id>/photo")
def report_photo(report_id):
    with connect_db() as db:
        row = db.execute("SELECT photo_name FROM reports WHERE id=?", (report_id,)).fetchone()
    if not row or not row["photo_name"]:
        return jsonify({"error": "No photo is attached to this report."}), 404
    photo_name = row["photo_name"]
    path = PHOTO_DIRECTORY / photo_name
    if path.name != photo_name or not path.is_file():
        return jsonify({"error": "Report photo was not found."}), 404
    mimetype = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(path.suffix)
    return send_file(path, mimetype=mimetype, max_age=0, conditional=True)


def parse_coordinate(value, minimum, maximum):
    if value in (None, ""):
        return None
    try:
        number = float(value)
        return number if minimum <= number <= maximum else None
    except (TypeError, ValueError):
        return None


@app.patch("/api/reports/<int:report_id>")
def update_report(report_id):
    denied = require_admin()
    if denied:
        return denied
    data = request.get_json(silent=True) or {}
    status = data.get("status")
    if status not in {"Submitted", "Under Review", "Verified", "Resolved", "Rejected"}:
        return jsonify({"error": "Invalid report status."}), 400
    with connect_db() as db:
        cursor = db.execute("UPDATE reports SET status=? WHERE id=?", (status, report_id))
        if cursor.rowcount == 0:
            return jsonify({"error": "Report not found."}), 404
    return jsonify({"message": "Report status updated.", "status": status})


@app.route("/api/resources", methods=["GET", "POST"])
def resources():
    if request.method == "GET":
        search = request.args.get("q", "").strip()[:100]
        with connect_db() as db:
            rows = db.execute(
                "SELECT * FROM resources WHERE name LIKE ? OR category LIKE ? OR area LIKE ? ORDER BY category,name",
                (f"%{search}%", f"%{search}%", f"%{search}%"),
            ).fetchall()
        return jsonify({"resources": [dict(row) for row in rows]})
    denied = require_admin()
    if denied:
        return denied
    data = request.get_json(silent=True) or {}
    values, error = validate_resource(data)
    if error:
        return jsonify({"error": error}), 400
    now = datetime.now(timezone.utc).isoformat()
    with connect_db() as db:
        cursor = db.execute(
            "INSERT INTO resources(name,category,quantity,unit,area,updated_at) VALUES(?,?,?,?,?,?)",
            (*values, now),
        )
        resource = dict(db.execute("SELECT * FROM resources WHERE id=?", (cursor.lastrowid,)).fetchone())
    return jsonify({"resource": resource}), 201


@app.patch("/api/resources/<int:resource_id>")
def update_resource(resource_id):
    denied = require_admin()
    if denied:
        return denied
    data = request.get_json(silent=True) or {}
    values, error = validate_resource(data)
    if error:
        return jsonify({"error": error}), 400
    with connect_db() as db:
        cursor = db.execute(
            "UPDATE resources SET name=?,category=?,quantity=?,unit=?,area=?,updated_at=? WHERE id=?",
            (*values, datetime.now(timezone.utc).isoformat(), resource_id),
        )
        if not cursor.rowcount:
            return jsonify({"error": "Resource not found."}), 404
        resource = dict(db.execute("SELECT * FROM resources WHERE id=?", (resource_id,)).fetchone())
    return jsonify({"resource": resource})


@app.delete("/api/resources/<int:resource_id>")
def delete_resource(resource_id):
    denied = require_admin()
    if denied:
        return denied
    with connect_db() as db:
        cursor = db.execute("DELETE FROM resources WHERE id=?", (resource_id,))
        if not cursor.rowcount:
            return jsonify({"error": "Resource not found."}), 404
    return jsonify({"message": "Resource removed."})


def validate_resource(data):
    name = str(data.get("name", "")).strip()[:80]
    category = str(data.get("category", "")).strip()[:50]
    unit = str(data.get("unit", "")).strip()[:30]
    area = str(data.get("area", "")).strip()[:120]
    try:
        quantity = int(data.get("quantity"))
    except (TypeError, ValueError):
        return None, "Quantity must be a non-negative whole number."
    if not name or not category or not unit or not area or quantity < 0:
        return None, "Complete all resource fields with a non-negative quantity."
    return (name, category, quantity, unit, area), None


@app.route("/api/volunteers", methods=["GET", "POST"])
def volunteers():
    if request.method == "GET":
        with connect_db() as db:
            rows = db.execute("SELECT id,name,skills,area,availability,activity,status,created_at FROM volunteers ORDER BY id DESC").fetchall()
        return jsonify({"volunteers": [dict(row) for row in rows]})
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()[:80]
    skills = str(data.get("skills", "")).strip()[:200]
    area = str(data.get("area", "")).strip()[:120]
    availability = str(data.get("availability", "Available"))
    if len(name) < 2 or not skills or not area or availability not in {"Available", "Limited", "Unavailable"}:
        return jsonify({"error": "Enter a name, skills, area and valid availability."}), 400
    with connect_db() as db:
        cursor = db.execute(
            "INSERT INTO volunteers(name,skills,area,availability,activity,status,created_at) VALUES(?,?,?,?,?,?,?)",
            (name, skills, area, availability, "Not assigned", "Available", datetime.now(timezone.utc).isoformat()),
        )
        volunteer = dict(db.execute("SELECT * FROM volunteers WHERE id=?", (cursor.lastrowid,)).fetchone())
    return jsonify({"volunteer": volunteer}), 201


@app.patch("/api/volunteers/<int:volunteer_id>")
def update_volunteer(volunteer_id):
    denied = require_admin()
    if denied:
        return denied
    data = request.get_json(silent=True) or {}
    status = data.get("status")
    activity = str(data.get("activity", "")).strip()
    if status not in {"Available", "Assigned", "Unavailable"} or activity not in SAFE_VOLUNTEER_ACTIVITIES:
        return jsonify({"error": "Choose a valid status and activity."}), 400
    with connect_db() as db:
        cursor = db.execute("UPDATE volunteers SET status=?,activity=? WHERE id=?", (status, activity, volunteer_id))
        if not cursor.rowcount:
            return jsonify({"error": "Volunteer not found."}), 404
    return jsonify({"message": "Volunteer coordination updated."})


@app.route("/api/checklist", methods=["GET", "POST"])
def checklist():
    if request.method == "GET":
        if app.config["READ_ONLY"]:
            return jsonify({"completed": {}})
        with connect_db() as db:
            rows = db.execute(
                "SELECT item_key,completed FROM checklist WHERE user_id=?",
                (g.current_user["id"],),
            ).fetchall()
        return jsonify({"completed": {row["item_key"]: bool(row["completed"]) for row in rows}})
    data = request.get_json(silent=True) or {}
    item_key = str(data.get("item_key", "")).strip()
    completed = data.get("completed")
    if not item_key or len(item_key) > 160 or not isinstance(completed, bool):
        return jsonify({"error": "Invalid checklist update."}), 400
    with connect_db() as db:
        db.execute(
            "INSERT INTO checklist(user_id,item_key,completed,updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(user_id,item_key) DO UPDATE SET completed=excluded.completed,updated_at=excluded.updated_at",
            (g.current_user["id"], item_key, int(completed), datetime.now(timezone.utc).isoformat()),
        )
    return jsonify({"item_key": item_key, "completed": completed})


@app.get("/api/preparedness")
def preparedness():
    return jsonify({"guides": PREPAREDNESS, "source": "General preparedness information; follow local official guidance."})


@app.get("/api/analytics")
def analytics():
    with connect_db() as db:
        by_type = db.execute("SELECT incident_type,COUNT(*) AS count FROM reports GROUP BY incident_type ORDER BY count DESC").fetchall()
        by_status = db.execute("SELECT status,COUNT(*) AS count FROM reports GROUP BY status").fetchall()
        by_area = db.execute("SELECT area,COUNT(*) AS count FROM reports GROUP BY area ORDER BY count DESC LIMIT 8").fetchall()
        daily = db.execute("SELECT substr(created_at,1,10) AS day,COUNT(*) AS count FROM reports GROUP BY day ORDER BY day DESC LIMIT 7").fetchall()
        shortages = db.execute("SELECT name,quantity,unit,area FROM resources WHERE quantity<=20 ORDER BY quantity").fetchall()
    return jsonify({
        "report_types": [dict(row) for row in by_type],
        "report_statuses": [dict(row) for row in by_status],
        "areas": [dict(row) for row in by_area],
        "daily": [dict(row) for row in reversed(daily)],
        "shortages": [dict(row) for row in shortages],
        "note": "Calculated only from reports and resources recorded in this SafeSignal demo database. This is not a risk forecast.",
    })


@app.get("/api/shelters")
def shelters():
    return jsonify({"simulated": True, "locations": [
        {"name": "Community Hall (demo)", "type": "Public shelter", "location": "Demo: Central district", "capacity": "Not verified", "contact": "Not verified", "status": "Demo location", "source": "SafeSignal sample data", "updated": "Demo dataset"},
        {"name": "District Health Point (demo)", "type": "Hospital", "location": "Demo: East district", "capacity": "Not verified", "contact": "Not verified", "status": "Demo location", "source": "SafeSignal sample data", "updated": "Demo dataset"},
        {"name": "Community Support Desk (demo)", "type": "Public assistance center", "location": "Demo: North district", "capacity": "Not verified", "contact": "Not verified", "status": "Demo location", "source": "SafeSignal sample data", "updated": "Demo dataset"},
    ]})


@app.get("/api/recovery")
def recovery():
    with connect_db() as db:
        counts = db.execute("SELECT status,COUNT(*) AS count FROM reports GROUP BY status").fetchall()
    report_status = {row["status"]: row["count"] for row in counts}
    return jsonify({
        "simulated": True,
        "report_status": report_status,
        "total_reports": sum(report_status.values()),
        "progress": 0 if not report_status else round(100 * report_status.get("Resolved", 0) / sum(report_status.values())),
        "note": "Progress reflects report statuses in this local demo database, not verified recovery outcomes.",
    })


@app.post("/api/assistant")
def assistant():
    data = request.get_json(silent=True) or {}
    message = str(data.get("message", "")).strip()[:1000]
    language = data.get("language", "English")
    if len(message) < 2:
        return jsonify({"error": "Please enter a question."}), 400
    api_key = None if app.config["READ_ONLY"] else os.environ.get("OPENAI_API_KEY")
    if api_key:
        endpoint = os.environ.get("OPENAI_API_URL", "https://api.openai.com/v1/chat/completions")
        payload = {
            "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            "messages": [
                {"role": "system", "content": "You are SafeSignal AI, a cautious disaster preparedness information assistant. Never claim to predict disasters. Never claim messages or reports were sent to authorities. For imminent danger, direct the user to local emergency services and official authorities. State that you are not an official source. Keep responses concise. Answer in " + str(language)[:30] + "."},
                {"role": "user", "content": message},
            ],
            "temperature": 0.3,
        }
        try:
            req = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"), headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=12) as response:
                body = json.loads(response.read(1024 * 1024).decode("utf-8"))
            answer = body["choices"][0]["message"]["content"]
            return jsonify({"answer": answer, "mode": "configured AI", "disclaimer": "AI-generated, not official emergency guidance."})
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError, IndexError) as error:
            app.logger.warning("Assistant provider unavailable: %s", error)
            return jsonify({"answer": demo_answer(message, language), "mode": "demo fallback", "disclaimer": "Demo response; not official emergency guidance."})
    return jsonify({"answer": demo_answer(message, language), "mode": "demo", "disclaimer": "Demo response; not official emergency guidance."})


TRANSLATIONS = {
    "Follow official evacuation instructions.": {
        "Tamil": "அதிகாரப்பூர்வ வெளியேற்ற அறிவுறுத்தல்களைப் பின்பற்றுங்கள்.",
        "Hindi": "आधिकारिक निकासी निर्देशों का पालन करें।",
    },
    "Avoid walking or driving through floodwater.": {
        "Tamil": "வெள்ள நீரில் நடப்பதையோ வாகனம் ஓட்டுவதையோ தவிர்க்கவும்.",
        "Hindi": "बाढ़ के पानी में पैदल चलने या गाड़ी चलाने से बचें।",
    },
    "Community reports are unverified until reviewed.": {
        "Tamil": "சமூக அறிக்கைகள் மதிப்பாய்வு செய்யப்படும் வரை சரிபார்க்கப்படாதவை.",
        "Hindi": "सामुदायिक रिपोर्ट की समीक्षा होने तक वे अप्रमाणित हैं।",
    },
    "SafeSignal demo alerts are simulated, not live.": {
        "Tamil": "SafeSignal மாதிரி எச்சரிக்கைகள் உருவகப்படுத்தப்பட்டவை; நேரலைத் தகவல் அல்ல.",
        "Hindi": "SafeSignal के डेमो अलर्ट काल्पनिक हैं, लाइव जानकारी नहीं।",
    },
    "For urgent help, contact local emergency services.": {
        "Tamil": "அவசர உதவிக்கு, உள்ளூர் அவசர சேவைகளைத் தொடர்புகொள்ளுங்கள்.",
        "Hindi": "तत्काल सहायता के लिए स्थानीय आपातकालीन सेवाओं से संपर्क करें।",
    },
}


@app.post("/api/translate")
def translate_text():
    data = request.get_json(silent=True) or {}
    text = str(data.get("text", "")).strip()[:1000]
    target_language = data.get("language")
    if not text or target_language not in {"English", "Tamil", "Hindi"}:
        return jsonify({"error": "Enter text and choose English, Tamil or Hindi."}), 400
    if target_language == "English":
        return jsonify({"translation": text, "mode": "original text"})
    translated = TRANSLATIONS.get(text, {}).get(target_language)
    if translated:
        return jsonify({"translation": translated, "mode": "curated demo phrase"})

    api_key = None if app.config["READ_ONLY"] else os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return jsonify({"error": "This phrase is not in the demo phrasebook. Configure an AI API to translate custom text."}), 422
    endpoint = os.environ.get("OPENAI_API_URL", "https://api.openai.com/v1/chat/completions")
    payload = {
        "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        "messages": [
            {"role": "system", "content": "Translate the user's text into " + target_language + ". Return only the translation. Preserve uncertainty and warnings; do not add advice."},
            {"role": "user", "content": text},
        ],
        "temperature": 0.1,
    }
    try:
        req = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"), headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=12) as response:
            body = json.loads(response.read(1024 * 1024).decode("utf-8"))
        translation = body["choices"][0]["message"]["content"]
        return jsonify({"translation": translation, "mode": "configured AI", "disclaimer": "Machine translation may be inaccurate."})
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError, IndexError) as error:
        app.logger.warning("Translation provider unavailable: %s", error)
        return jsonify({"error": "Translation service is unavailable. Try again or use the curated demo phrasebook."}), 503


def demo_answer(message, language):
    text = message.lower()
    if any(term in text for term in ("translate", "தமிழ்", "hindi", "tamil")):
        return "Demo translation support is shown in the language selector. For reliable emergency translation, use an official translation or local authority service. (This demo does not translate arbitrary text.)"
    if any(term in text for term in ("alert", "warning", "watch", "critical")):
        return "An alert is an advisory from an issuing authority or source; check the source, location, time and expiry. A community report is user-submitted and remains unverified until reviewed. This app's sample alerts are simulated."
    if any(term in text for term in ("checklist", "prepare", "kit")):
        return "A basic preparedness kit can include drinking water, essential medicines, a torch, batteries, a first-aid kit, copies of key documents and a way to receive official updates. Adapt it to your household and local official guidance."
    if any(term in text for term in ("flood", "water")):
        return "General flood safety: follow official evacuation instructions, avoid walking or driving through floodwater, and use safe drinking water. This is general information, not an official instruction or live alert."
    if any(term in text for term in ("resource", "shelter", "hospital")):
        return "The resources and support directory in this demo contains illustrative entries. Verify operational availability, location and contact details with official local sources before travelling."
    return "I can explain alerts versus community reports, share general preparedness checklist ideas, or help you find platform resources. For immediate danger, contact local emergency services and follow official authority guidance. This is a demo response, not an official instruction."


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": "Request too large. Keep submitted content under 3 MB."}), 413


@app.errorhandler(404)
def not_found(_error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "The requested record or endpoint was not found."}), 404
    return "Page not found", 404


@app.errorhandler(500)
def server_error(error):
    app.logger.error("Unhandled server error: %s", error)
    if request.path.startswith("/api/"):
        return jsonify({"error": "Something went wrong. Please try again."}), 500
    return "Something went wrong. Please try again.", 500


initialize_db()

if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1", host="127.0.0.1", port=int(os.environ.get("PORT", "5000")))
