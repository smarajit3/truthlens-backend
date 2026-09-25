# TruthLens Backend

Backend API for the TruthLens evidence-first misinformation checking website.

## Endpoints

- `GET /api/health`
- `POST /api/analyze-image`
- `POST /api/evidence-search`
- `POST /api/verify`

## Local setup

1. Install Node.js LTS.
2. Run `npm install`.
3. Create a `.env` file based on `.env.example`.
4. Put your Gemini API key in `.env`.
5. Run `npm start`.
6. The API runs on `http://localhost:10000` locally.

## Render deployment

Use a Render **Web Service**.

- Build Command: `npm install`
- Start Command: `npm start`
- Add `GEMINI_API_KEY` as a Render Environment Variable.
- Optional: add `GEMINI_MODEL=gemini-3.8-flash`.
- Do not upload `.env` to GitHub.

The server binds to `0.0.0.0` and uses Render's `PORT` environment variable.

## Important

Google News RSS is used only for evidence discovery. A headline alone is not proof. TruthLens should show the underlying sources and uncertainty rather than treating an AI response as authoritative fact.
