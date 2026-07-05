// server.ts

import "dotenv/config";
import express, { Request, Response } from "express";
import { Daytona } from "@daytona/sdk";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const machines: Record<string, string> = {};

if (process.env.DAYTONA_MACHINES) {
  try {
    Object.assign(machines, JSON.parse(process.env.DAYTONA_MACHINES));
  } catch (err) {
    console.error("Failed to parse DAYTONA_MACHINES JSON from environment:", err);
  }
}

for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("DAYTONA_MACHINE_") && value) {
    const machineName = key.replace("DAYTONA_MACHINE_", "").toLowerCase();
    machines[machineName] = value;
  }
}


type NodeInfo = {
  name: string;
  daytona: Daytona;
  sandbox?: any;
  status: "UP" | "DOWN" | "NONE";
  id?: string;
  region?: string;
  sshToken?: string;
};

const daytonas: Record<string, Daytona> = {};
const cache: Record<string, NodeInfo> = {};

async function queryMachine(name: string): Promise<NodeInfo> {
  const daytona = daytonas[name] || new Daytona({ apiKey: machines[name] });
  daytonas[name] = daytona;
  try {
    let foundSandbox: any = undefined;
    for await (const sandbox of daytona.list({ name })) {
      if (sandbox.name.toLowerCase() === name.toLowerCase()) {
        foundSandbox = sandbox;
        break;
      }
    }
    if (foundSandbox) {
      const isUp = foundSandbox.state === "started";
      return {
        name,
        daytona,
        sandbox: foundSandbox,
        status: isUp ? "UP" : "DOWN",
        id: foundSandbox.id,
        region: foundSandbox.target,
      };
    } else {
      return {
        name,
        daytona,
        status: "NONE",
      };
    }
  } catch (err: any) {
    return {
      name,
      daytona,
      status: "NONE",
    };
  }
}

async function refreshAll() {
  const promises = Object.keys(machines).map((name) => queryMachine(name));
  const results = await Promise.all(promises);
  for (const info of results) {
    cache[info.name] = info;
  }
}

// 1. Get status of all machines
app.get("/api/machines", (req: Request, res: Response) => {
  const list = Object.keys(machines).map((name) => {
    const info = cache[name];
    if (info) {
      return {
        name: info.name,
        status: info.status,
        id: info.id || null,
        region: info.region || null,
        sshCommand: info.sshToken ? `ssh ${info.sshToken}@ssh.app.daytona.io` : null,
      };
    }
    return {
      name,
      status: "NONE",
      id: null,
      region: null,
      sshCommand: null,
    };
  });
  res.json({ success: true, data: list });
});

// 2. Trigger cache refresh
app.post("/api/machines/refresh", async (req: Request, res: Response) => {
  try {
    await refreshAll();
    res.json({ success: true, message: "Status cache refreshed successfully." });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || err });
  }
});

// 3. Create VM for a node
app.post("/api/machines/:name/create", async (req: Request, res: Response) => {
  const name = (req.params.name as string).toLowerCase();
  const apiKey = machines[name];

  if (!apiKey) {
    res.status(404).json({ success: false, error: `Machine key '${name}' not found in configuration.` });
    return;
  }

  try {
    const daytona = new Daytona({ apiKey });
    daytonas[name] = daytona;

    // Check & delete existing sandboxes
    const existing = [];
    for await (const sandbox of daytona.list()) {
      existing.push(sandbox);
    }

    if (existing.length) {
      for (const sandbox of existing) {
        try {
          await sandbox.delete();
        } catch {}
      }
      // wait a bit for deletion to finalize
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Create sandbox
    const sandbox = await daytona.create({
      name,
      snapshot: "daytona-large",
      autoStopInterval: 0,
      autoDeleteInterval: -1,
      autoArchiveInterval: 0,
    });

    // Start VM
    try {
      await sandbox.start();
    } catch {}

    // Create 24h SSH token
    const sshAccess = await sandbox.createSshAccess(60 * 24);
    const sshToken = sshAccess.token;

    cache[name] = {
      name,
      daytona,
      sandbox,
      status: "UP",
      id: sandbox.id,
      region: sandbox.target,
      sshToken,
    };

    res.json({
      success: true,
      data: {
        name,
        id: sandbox.id,
        status: "UP",
        sshCommand: `ssh ${sshToken}@ssh.app.daytona.io`,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || err });
  }
});

// 4. Delete VM
app.delete("/api/machines/:name", async (req: Request, res: Response) => {
  const name = (req.params.name as string).toLowerCase();
  const info = cache[name];

  if (!info || !info.sandbox) {
    res.status(404).json({ success: false, error: `Active VM '${name}' not found in cache.` });
    return;
  }

  try {
    await info.sandbox.delete();
    cache[name] = {
      name,
      daytona: info.daytona,
      status: "NONE",
    };
    res.json({ success: true, message: `VM '${name}' successfully deleted.` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || err });
  }
});

// 5. Get or Regenerate SSH Command (validates existing; if invalid/expired, regenerates)
app.get("/api/machines/:name/ssh", async (req: Request, res: Response) => {
  const name = (req.params.name as string).toLowerCase();
  const info = cache[name];

  if (!info || !info.sandbox) {
    res.status(404).json({ success: false, error: `Active VM '${name}' not found in cache. Create it first.` });
    return;
  }

  try {
    let token = info.sshToken;
    let reused = false;

    if (token) {
      try {
        const validation = await info.sandbox.validateSshAccess(token);
        if (validation.valid) {
          reused = true;
        } else {
          token = undefined;
        }
      } catch {
        token = undefined;
      }
    }

    if (!token) {
      const sshAccess = await info.sandbox.createSshAccess(60 * 24);
      token = sshAccess.token;
      info.sshToken = token;
    }

    res.json({
      success: true,
      data: {
        name,
        sshCommand: `ssh ${token}@ssh.app.daytona.io`,
        reused,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || err });
  }
});

// 6. Start VM
app.post("/api/machines/:name/start", async (req: Request, res: Response) => {
  const name = (req.params.name as string).toLowerCase();
  const info = cache[name];

  if (!info || !info.sandbox) {
    res.status(404).json({ success: false, error: `VM '${name}' not found. Create it first.` });
    return;
  }

  try {
    await info.sandbox.start();
    info.status = "UP";
    res.json({ success: true, message: `VM '${name}' started successfully.`, status: "UP" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || err });
  }
});

// 7. Stop VM
app.post("/api/machines/:name/stop", async (req: Request, res: Response) => {
  const name = (req.params.name as string).toLowerCase();
  const info = cache[name];

  if (!info || !info.sandbox) {
    res.status(404).json({ success: false, error: `VM '${name}' not found.` });
    return;
  }

  try {
    await info.sandbox.stop();
    info.status = "DOWN";
    res.json({ success: true, message: `VM '${name}' stopped successfully.`, status: "DOWN" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || err });
  }
});

// 23-Hour Cron to automatically regenerate SSH tokens for all active VMs
setInterval(async () => {
  console.log("Running scheduled 23-hour SSH token regeneration...");
  const existingVms = Object.values(cache).filter((info) => info.status !== "NONE");
  for (const vm of existingVms) {
    if (!vm.sandbox) continue;
    try {
      console.log(`Regenerating SSH token for ${vm.name}...`);
      const sshAccess = await vm.sandbox.createSshAccess(60 * 24);
      vm.sshToken = sshAccess.token;
    } catch (err: any) {
      console.error(`Failed scheduled SSH token regeneration for ${vm.name}: ${err.message || err}`);
    }
  }
}, 23 * 60 * 60 * 1000);

// Auto-restart loop: runs every 5 minutes to ensure all created VMs stay UP 24/7
setInterval(async () => {
  console.log("[Auto-Restart] Checking for any stopped VMs...");
  try {
    await refreshAll();
    const stoppedVms = Object.values(cache).filter((info) => info.status === "DOWN");
    for (const vm of stoppedVms) {
      if (!vm.sandbox) continue;
      console.log(`[Auto-Restart] Node '${vm.name}' is DOWN. Auto-starting it...`);
      try {
        await vm.sandbox.start();
        vm.status = "UP";
        console.log(`[Auto-Restart] Successfully started node '${vm.name}'.`);
      } catch (err: any) {
        console.error(`[Auto-Restart] Failed to auto-start node '${vm.name}':`, err.message || err);
      }
    }
  } catch (err: any) {
    console.error("[Auto-Restart] Error in auto-restart loop:", err.message || err);
  }
}, 5 * 60 * 1000);

// Server Initialization
app.listen(PORT, async () => {
  console.log(`========================================`);
  console.log(` Daytona API Server running on port ${PORT}`);
  console.log(`========================================`);
  console.log(`Initializing Daytona account cache status...`);
  try {
    await refreshAll();
    console.log(`Initial node status cache populated successfully.`);
  } catch (err: any) {
    console.error(`Warning: Cache population failed during startup: ${err.message || err}`);
  }
});
