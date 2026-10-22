# Launch Planner 3D (web viewer)

Static page (CesiumJS from a CDN, Esri satellite imagery; no API keys). Open it through a local web server:

    cd web
    python -m http.server 8000        # then browse to http://localhost:8000

The page reads `web/data/*.json`, which is generated (and not in git, 11 MB):

    python -u -W ignore -m scripts.export_web_case forecast --launch-leads 3:96:1   # 94 launch hours, ~20 min
    python -u -W ignore -m scripts.export_web_case replay --seed 3                  # one real flight vs the forecast

Needs the GFS and GEFS files in `~/balloon-data` and `wind_error_full.joblib` (from `scripts.wind_error_model`).

Deep links: `?launch=2026-10-19T13:00:00Z&view=chase&t=0.4&mode=real&debug=1`

Imagery: Esri World Imagery (attribution shown). Real-balloon data: SondeHub and its volunteers, CC BY-SA 2.0.
