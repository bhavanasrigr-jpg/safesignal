# SafeSignal

SafeSignal is a local disaster-intelligence and response-coordination demonstration. It combines a Flask and SQLite backend with a responsive dashboard, interactive map, community reporting, preparedness guidance, resource tracking, and volunteer coordination.

> **Demo safety:** This application opens directly into an unauthenticated local workspace. It is for local demonstrations only, not a production or emergency-response system. Do not expose it to a public network or use it to coordinate real incidents.

## Run locally

Requirements: Python 3.10 or later.

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000). The SQLite database is created locally on first run and is intentionally excluded from Git.

## Demo data and external services

- Sample alerts, map markers, shelters, volunteers, and inventory are illustrative. They are not verified live incidents or operational resources.
- The flood simulation changes only the demonstration scenario; it does not dispatch responders or contact authorities.
- Map tiles, fonts, icons, and chart libraries load from external providers and require an internet connection.
- Community submissions are local records, remain unverified until reviewed, and are not sent to emergency services.
- Never rely on this prototype for emergency instructions. Follow local authorities and emergency services.

## Project layout

- `app.py` — Flask routes, SQLite setup, and local demo behavior
- `templates/` — dashboard HTML
- `static/css/` — responsive dashboard styles
- `static/js/` — map, charts, and interactive workflows
- `requirements.txt` — Python dependencies
