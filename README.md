This is the Readme File of my project showing features about the project and how it will work ?

# CodePulse

A dark, no-login codebase health tracker built with React + Vite and Node.js + Express.

## Requirements
- Node.js 18+ (20+ recommended)
- npm
- Internet connection for installing dependencies and scanning public GitHub repositories

## Run locally
Open two terminals from this folder.

Terminal 1 — backend:
```bash
cd server
npm install
npm run dev
```

Terminal 2 — frontend:
```bash
cd client
npm install
npm run dev
```

Open http://localhost:5173. API runs at http://localhost:5000.

## Features
- Open workspace with no sign-in screen
- Dark developer-focused dashboard
- ZIP upload for supported project files
- Public GitHub repository scanning by URL (no GitHub token required)
- Source snippets and suggested remediation guidance for findings
- Built-in heuristic checks for debugging leftovers, possible hard-coded secrets, unsafe HTML insertion, repeated lines, long lines and large files
- ESLint recommended rules for supported JavaScript files when ESLint is installed
- Severity, health score, language breakdown and searchable findings
- Saved scan history in `server/data/scans.json`
- Export scan report as JSON
- Responsive layout and demo data

## GitHub scanning
Click **Scan GitHub** in the dashboard and paste a public repository URL such as `https://github.com/owner/repository`. Private repositories are not supported. CodePulse downloads the public repository archive from GitHub and scans it on your local API server. The backend enforces a 15 MB archive download limit and source scanning limits.

## Analysis limitations
The scanner does not execute project code. ESLint runs on supported JavaScript files; TypeScript files are not linted by ESLint unless a TypeScript parser is configured. Heuristic security findings can be false positives and are not proof of a vulnerability. Review every finding before applying a suggested fix. This is not a replacement for a dedicated security audit or CI pipeline.
