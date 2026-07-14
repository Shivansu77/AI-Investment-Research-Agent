# AI Investment Research Agent


visit here : https://dist-blond-psi-29.vercel.app/
A small LangGraph.js backend that researches a public company and returns an
investment call: `INVEST`, `PASS`, or `WATCHLIST`.

## Graph

`router -> research -> orchestrator -> worker -> reducer -> complete -> end`

- `router`: decides whether the company needs an identity lookup.
- `research`: uses Tavily to find company context.
- `orchestrator`: asks Gemini to plan the research queries.
- `worker`: runs the planned Tavily searches.
- `reducer`: turns evidence into the final investment view.
- `complete`: returns the finished state.

## Setup

```bash
cd backend
npm install
```

Create `backend/.env`:

```bash
GOOGLE_API_KEY=your_gemini_key
TAVILY_API_KEY=your_tavily_key
```

`API_KEY` also works for Gemini if you already have that in your local `.env`.

## Run

```bash
npm run research -- "Reliance Industries"
```

For a fast graph-only smoke test:

```bash
npm run research -- --dry-run "Reliance Industries"
```
