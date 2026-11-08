# Drishti Frontend

Dependency-free web app (HTML + CSS + ES modules, no build step) for the Drishti FastAPI backend.

## Run
1. Start the backend: `cd ../backend && python server.py` (port 5000; no API key = demo mode).
2. Serve this folder: `python3 -m http.server 8080` → open http://localhost:8080
   (camera/mic need `localhost` or HTTPS). Backend URL is editable in **Settings** (default `http://localhost:5000`).

## Features
- **Guided walk**: one-tap camera start, continuous safety scans, pause/resume/end controls, and live counts for detected obstacles, vehicles, people and animals. The counts are grouped from the labels returned by the backend.
- **Vision**: live camera or uploaded photo → `POST /vision-assist` in safety / read / currency / all modes; bounding boxes (`box2d`, 0–1000) drawn over the view, colour-coded by severity; spoken alert, clock positions, distances, OCR text, banknotes, scene summary, safety tip; optional spoken/typed question; auto-scan loop.
- **Ask Drishti**: `POST /chat` with rolling history, optional current camera frame, suggested follow-up chips, urgency styling.
- **Speech**: `POST /tts` (server audio, else the browser `speechConfig` fallback) or device voice directly; voice input via the Web Speech API (Chrome/Edge) in the selected language.
- **13 languages** from `/languages`; status pill from `/health` (Live / Demo / Offline).
- **Accessibility**: screen-reader landmarks, live regions, large targets, high-contrast + text-size options, vibration on hazards, shortcuts: `A` analyze · `S` auto-scan · `1–4` mode · `M` mic · `R` repeat · `Esc` stop.

## Files
`index.html`, `styles.css`, `js/api.js` (backend client), `js/speech.js` (TTS + STT), `js/app.js` (UI/logic).


## Important integration notes
- The frontend uses the existing FastAPI `/vision-assist` response. Object boxes and labels are only as accurate and frequent as the backend model's `detectedObjects` output.
- Vehicle/person/animal grouping is a frontend label classification for display; it is not a separate detector and does not infer motion or whether an object is approaching.
- The Guided walk controls run the existing periodic safety scan. This ZIP does not include GPS routing, Bluetooth glasses pairing, depth sensing, or a dedicated real-time object-tracking model.
- Camera and microphone access require `localhost` or HTTPS. Test in a safe, controlled environment; do not depend on this prototype as the sole aid for crossing roads or avoiding hazards.


## Multilingual guided-walk actions

During Guided Walk, each safety scan speaks the short hazard alert plus the backend's recommended immediate action using the currently selected language. If the backend is in demo mode, the frontend announces that camera-based guidance is unavailable rather than treating sample detections as real. The model is prompted not to recommend a left/right move unless that side is visibly clear in the current frame; otherwise it should advise stopping and verifying the path. This is still a prototype and must not be relied on as the sole mobility or traffic-awareness aid.
