# Daytona VM Manager

A neat, clean, and highly modern terminal user interface (TUI), backend REST API server, and web-based status dashboard for managing multiple Daytona virtual machines with parallel query caching and automatic SSH key rotation.

## Features

- **Interactive TUI (`daytona.ts`)**: Built with native Node.js libraries, supporting full arrow-key navigation (`↑` / `↓` / `Enter` / `Esc`), colored status tables (`UP`, `DOWN`, `NONE`), loading box overlays, and raw-mode toggling for inline SSH sessions.
- **REST API Server (`server.ts`)**: An Express-based server exposing control endpoints for all VM operations.
- **Auto-Regenerating SSH**: The API automatically checks cached token validity before returning it; if expired or older than 24 hours, it provisions a fresh token.
- **23-Hour Cron**: The server operates a background interval cron task to automatically rotate and regenerate SSH tokens for all active VMs every 23 hours.
- **Web Dashboard (`public/index.html`)**: A beautiful, modern dark-themed web interface displaying glowing status badges, machine region details, copyable SSH command boxes, and quick-action buttons (Create, Start, Stop, Delete).

---

## File Structure

```
.
├── daytona.ts          # Interactive TUI Client
├── server.ts           # REST API Server & Cron Service
├── public/
│   └── index.html      # Responsive Dark-Theme Web Dashboard
├── .env                # API Keys and Node settings
├── package.json        # Dependencies (Express, Daytona SDK, dotenv, tsx)
└── README.md           # Documentation
```

---

## Configuration

Before running the application, configure your node names and API keys in a `.env` file in the root directory. You can specify the configuration in two ways:

### Option A: Using a Single JSON String (Recommended)
```env
DAYTONA_MACHINES='{"jett":"dtn_key1","phoenix":"dtn_key2","sage":"dtn_key3"}'
```

### Option B: Using Individual prefixed variables
```env
DAYTONA_MACHINE_JETT=dtn_key1
DAYTONA_MACHINE_PHOENIX=dtn_key2
DAYTONA_MACHINE_SAGE=dtn_key3
```

---

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Run the Interactive TUI Dashboard
To manage your machines directly from the terminal with a rich user interface, run:
```bash
npx tsx daytona.ts
```

### 3. Start the API Server & Web UI
To spin up the REST API, web dashboard, and the 23-hour background SSH rotation service, run:
```bash
npx tsx server.ts
```
The server will boot, warm up the status cache by querying all accounts in parallel, and listen on:
`http://localhost:3000`

---

## REST API Endpoints

All endpoints return JSON responses.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/machines` | Returns current status, sandbox IDs, regions, and SSH commands for all configured nodes. |
| `POST` | `/api/machines/refresh` | Triggers a fresh check against Daytona's APIs and updates the cache. |
| `POST` | `/api/machines/:name/create` | Re-provisions a `daytona-large` VM (wiping any existing sandboxes first). |
| `DELETE` | `/api/machines/:name` | Deletes the VM sandbox. |
| `GET` | `/api/machines/:name/ssh` | Returns the active SSH command (validating and recreating tokens if expired). |
| `POST` | `/api/machines/:name/start` | Starts a stopped VM. |
| `POST` | `/api/machines/:name/stop` | Stops a running VM. |
