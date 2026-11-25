# SafeSignal

SafeSignal is a local disaster-intelligence and response-coordination demonstration. It combines a Flask and SQLite backend with a responsive dashboard, interactive map, community reporting, preparedness guidance, resource tracking, and volunteer coordination.

> **Demo safety:** This application is not a production or emergency-response system. Its local workspace is interactive and unauthenticated; do not expose it to a public network. The Render Blueprint configures a separate public, read-only demonstration with simulated data. Do not use either deployment to coordinate real incidents.

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

## Public read-only demo on Render

The included `render.yaml` configures a free Render web service with server-side read-only enforcement. To publish it:

1. Push this repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com), choose **New → Blueprint** and connect this repository.
3. Review and deploy the `safesignal-public-demo` service. Render will display its public URL when the first deployment completes.

The hosted demo rejects database-changing requests even if a visitor bypasses the interface. Preparedness checklist progress is stored only in each visitor's browser. To prevent public API abuse, the hosted assistant uses demo responses and the translation feature uses its curated phrasebook; neither makes paid AI API calls. The SQLite database is ephemeral on Render's free service, and all sample records are illustrative—not live alerts, verified reports, or confirmed resources.

## Project layout

- `app.py` — Flask routes, SQLite setup, and local demo behavior
- `templates/` — dashboard HTML
- `static/css/` — responsive dashboard styles
- `static/js/` — map, charts, and interactive workflows
- `render.yaml` — public read-only Render deployment
- `requirements.txt` — Python dependencies
