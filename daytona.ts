// daytona.ts

import "dotenv/config";
import { Daytona } from "@daytona/sdk";
import * as readline from "readline";
import { spawn } from "child_process";

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

function cleanExit() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  console.clear();
  console.log("Goodbye!");
  process.exit(0);
}

process.on("SIGINT", () => {
  cleanExit();
});

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      process.stdin.resume();
      resolve(answer.trim());
    });
  });
}

async function promptText(question: string): Promise<string> {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  const answer = await ask(question);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  return answer;
}

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

async function refresh() {
  printBox("REFRESHING STATUS", [
    "Re-fetching every account...",
    "Querying nodes in parallel."
  ]);
  const promises = Object.keys(machines).map((name) => queryMachine(name));
  const results = await Promise.all(promises);
  for (const info of results) {
    cache[info.name] = info;
  }
}

function printTableRow(node: string, status: string, sandboxId?: string) {
  const nodeCol = node.padEnd(11);
  let statusStr = "❌ NONE";
  if (status === "UP") statusStr = "🟢 UP";
  else if (status === "DOWN") statusStr = "🔴 DOWN";
  else if (status === "Status") statusStr = "Status";
  
  const statusCol = statusStr.padEnd(12);
  
  let sandboxCol = "-";
  if (sandboxId) {
    sandboxCol = sandboxId.slice(0, 8);
  } else if (status === "Sandbox ID") {
    sandboxCol = "Sandbox ID";
  }
  const idCol = sandboxCol.padEnd(10);
  
  console.log(`│ ${nodeCol} │ ${statusCol} │ ${idCol} │`);
}

function printStatusTable() {
  console.log("┌─────────────────────────────────────────┐");
  console.log("│             DAYTONA MANAGER             │");
  console.log("├─────────────┬──────────────┬────────────┤");
  printTableRow("Node", "Status", "Sandbox ID");
  console.log("├─────────────┼──────────────┼────────────┤");
  for (const name of Object.keys(machines)) {
    const info = cache[name.toLowerCase()];
    if (info) {
      printTableRow(info.name, info.status, info.id);
    } else {
      printTableRow(name, "NONE");
    }
  }
  console.log("└─────────────┴──────────────┴────────────┘\n");
}

function printBox(title: string, lines: string[]) {
  console.clear();
  console.log(`┌────────────────────────────────────────┐`);
  console.log(`│ ${title.padEnd(38)} │`);
  console.log(`├────────────────────────────────────────┤`);
  for (const line of lines) {
    console.log(`│ ${line.padEnd(38)} │`);
  }
  console.log(`└────────────────────────────────────────┘`);
}

async function selectFromList(title: string, items: string[]): Promise<number | null> {
  if (items.length === 0) return null;
  let cursor = 0;

  const renderList = () => {
    console.clear();
    console.log(`┌────────────────────────────────────────┐`);
    console.log(`│ ${title.padEnd(38)} │`);
    console.log(`├────────────────────────────────────────┤`);
    items.forEach((item, index) => {
      if (index === cursor) {
        console.log(`│ ➔ \x1b[1;36m${item.padEnd(34)}\x1b[0m   │`);
      } else {
        console.log(`│   ${item.padEnd(34)}   │`);
      }
    });
    console.log(`└────────────────────────────────────────┘`);
    console.log(`\x1b[2m(Use ↑/↓ to navigate, Enter to select, Esc to cancel)\x1b[0m`);
  };

  return new Promise((resolve) => {
    renderList();

    const onKey = (str: string, key: any) => {
      if (!key) return;
      if (key.name === "up") {
        cursor = (cursor - 1 + items.length) % items.length;
        renderList();
      } else if (key.name === "down") {
        cursor = (cursor + 1) % items.length;
        renderList();
      } else if (key.name === "return") {
        process.stdin.removeListener("keypress", onKey);
        resolve(cursor);
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        process.stdin.removeListener("keypress", onKey);
        resolve(null);
      }
    };

    process.stdin.on("keypress", onKey);
  });
}

async function handleCreateVM() {
  console.clear();
  console.log("┌────────────────────────────────────────┐");
  console.log("│ CREATE NEW VM                          │");
  console.log("└────────────────────────────────────────┘\n");
  
  const name = await promptText("Enter Machine/API key name (e.g. killjoy): ");
  if (!name) {
    printBox("CREATE VM", ["Operation cancelled."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  const machineKey = name.toLowerCase();
  const apiKey = machines[machineKey];
  if (!apiKey) {
    printBox("CREATE VM", [
      `❌ Error: Machine '${name}' not found`,
      "in the configuration keys."
    ]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  printBox("CREATE VM", [
    `Initializing Daytona for ${machineKey}...`
  ]);

  const daytona = new Daytona({ apiKey });

  printBox("CREATE VM", [
    "Checking for existing sandboxes..."
  ]);

  const existing = [];
  try {
    for await (const sandbox of daytona.list()) {
      existing.push(sandbox);
    }
  } catch (err: any) {
    printBox("CREATE VM", [
      `❌ Error listing sandboxes:`,
      err.message || err
    ]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  if (existing.length) {
    printBox("CREATE VM", [
      `Deleting ${existing.length} existing sandbox(s)...`,
      ...existing.map(s => `  • ${s.name}`)
    ]);
    for (const sandbox of existing) {
      try {
        await sandbox.delete();
      } catch (err: any) {
        // ignore
      }
    }
    printBox("CREATE VM", [
      "Waiting 5 seconds for deletion",
      "to finalize..."
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  printBox("CREATE VM", [
    "Creating sandbox...",
    "Snapshot: daytona-large",
    "Auto Stop: 0 (disabled)",
    "Auto Delete: -1 (disabled)"
  ]);

  let sandbox: any;
  try {
    sandbox = await daytona.create({
      name: machineKey,
      snapshot: "daytona-large",
      autoStopInterval: 0,
      autoDeleteInterval: -1,
      autoArchiveInterval: 525600,
    });
  } catch (err: any) {
    printBox("CREATE VM", [
      `❌ Error creating sandbox:`,
      err.message || err
    ]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  printBox("CREATE VM", [
    "Starting VM..."
  ]);
  try {
    await sandbox.start();
  } catch (err: any) {
    // ignore
  }

  printBox("CREATE VM", [
    "Creating SSH token (24h)..."
  ]);
  let sshToken = "";
  try {
    const sshAccess = await sandbox.createSshAccess(60 * 24);
    sshToken = sshAccess.token;
  } catch (err: any) {
    printBox("CREATE VM", [
      `❌ Error creating SSH token:`,
      err.message || err
    ]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  printBox("VM CREATED SUCCESS", [
    `Created ${machineKey} successfully!`,
    "",
    "SSH Access Command:",
    `ssh ${sshToken}@ssh.app.daytona.io`
  ]);

  cache[machineKey] = {
    name: machineKey,
    daytona,
    sandbox,
    status: "UP",
    id: sandbox.id,
    region: sandbox.target,
    sshToken,
  };

  await promptText("\nPress Enter to continue...");
}

async function handleDeleteVM() {
  const existingVms = Object.values(cache).filter((info) => info.status !== "NONE");
  if (existingVms.length === 0) {
    printBox("DELETE VM", ["No existing VMs to delete."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  const items = existingVms.map(vm => `${vm.name.padEnd(10)} (${vm.status})`);
  const selectedIdx = await selectFromList("SELECT VM TO DELETE", items);
  if (selectedIdx === null) {
    printBox("DELETE VM", ["Operation cancelled."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  const selectedVm = existingVms[selectedIdx];
  if (!selectedVm || !selectedVm.sandbox) {
    printBox("DELETE VM", ["❌ Invalid VM selection."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  printBox("DELETE VM", [
    `Deleting ${selectedVm.name}...`
  ]);

  try {
    await selectedVm.sandbox.delete();
    printBox("DELETE VM", [
      `Successfully deleted ${selectedVm.name}!`,
      "Done."
    ]);
    cache[selectedVm.name] = {
      name: selectedVm.name,
      daytona: selectedVm.daytona,
      status: "NONE",
    };
  } catch (err: any) {
    printBox("DELETE VM", [
      `❌ Error deleting VM:`,
      err.message || err
    ]);
  }

  await promptText("\nPress Enter to continue...");
}

async function handleRegenAllSSH() {
  const existingVms = Object.values(cache).filter((info) => info.status !== "NONE");
  if (existingVms.length === 0) {
    printBox("REGENERATE SSH", ["No existing VMs found."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  printBox("REGENERATE SSH", [
    "Regenerating SSH for all VMs...",
    "This may take a moment."
  ]);

  const outputLines: string[] = ["Loops over every VM:"];
  for (const vm of existingVms) {
    if (!vm.sandbox) continue;
    try {
      const sshAccess = await vm.sandbox.createSshAccess(60 * 24);
      vm.sshToken = sshAccess.token;
      outputLines.push(`• ${vm.name}:`);
      outputLines.push(`  ssh ${sshAccess.token}@ssh.app.daytona.io`);
    } catch (err: any) {
      outputLines.push(`• ${vm.name}: ❌ Failed`);
    }
  }

  printBox("REGENERATE SSH DONE", outputLines);
  await promptText("\nPress Enter to continue...");
}

function runSsh(token: string): Promise<void> {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [`${token}@ssh.app.daytona.io`], {
      stdio: "inherit",
    });
    child.on("exit", () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      resolve();
    });
    child.on("error", (err: Error) => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      reject(err);
    });
  });
}

async function handleSshVM() {
  const existingVms = Object.values(cache).filter((info) => info.status !== "NONE");
  if (existingVms.length === 0) {
    printBox("SSH INTO VM", ["No existing VMs to SSH into."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  const items = existingVms.map(vm => `${vm.name.padEnd(10)} (${vm.status})`);
  const selectedIdx = await selectFromList("SELECT VM TO SSH INTO", items);
  if (selectedIdx === null) {
    printBox("SSH INTO VM", ["Operation cancelled."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  const selectedVm = existingVms[selectedIdx];
  if (!selectedVm || !selectedVm.sandbox) {
    printBox("SSH INTO VM", ["❌ Invalid VM selection."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  printBox("SSH INTO VM", ["Checking SSH token validity..."]);
  let token = selectedVm.sshToken;
  if (token) {
    try {
      const validation = await selectedVm.sandbox.validateSshAccess(token);
      if (!validation.valid) {
        token = undefined;
      }
    } catch {
      token = undefined;
    }
  }

  if (!token) {
    printBox("SSH INTO VM", ["Generating fresh SSH token..."]);
    try {
      const sshAccess = await selectedVm.sandbox.createSshAccess(60 * 24);
      token = sshAccess.token;
      selectedVm.sshToken = token;
    } catch (err: any) {
      printBox("SSH INTO VM", [
        `❌ Failed to generate SSH token:`,
        err.message || err
      ]);
      await promptText("\nPress Enter to continue...");
      return;
    }
  }

  printBox("SSH INTO VM", [
    "Launching...",
    `ssh ${token}@ssh.app.daytona.io`
  ]);

  try {
    await runSsh(token!);
  } catch (err: any) {
    printBox("SSH INTO VM", [
      `❌ SSH Connection error:`,
      err.message || err
    ]);
    await promptText("\nPress Enter to return to menu...");
  }
}

async function handleStartVM() {
  const stoppedVms = Object.values(cache).filter((info) => info.status === "DOWN");
  if (stoppedVms.length === 0) {
    printBox("START VM", ["No stopped VMs to start."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  const items = stoppedVms.map(vm => vm.name);
  const selectedIdx = await selectFromList("SELECT VM TO START", items);
  if (selectedIdx === null) {
    printBox("START VM", ["Operation cancelled."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  const selectedVm = stoppedVms[selectedIdx];
  if (!selectedVm || !selectedVm.sandbox) {
    printBox("START VM", ["❌ Invalid VM selection."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  printBox("START VM", [
    `Starting ${selectedVm.name}...`
  ]);

  try {
    await selectedVm.sandbox.start();
    selectedVm.status = "UP";
    printBox("START VM", [
      `Successfully started ${selectedVm.name}!`,
      "Done."
    ]);
  } catch (err: any) {
    printBox("START VM", [
      `❌ Error starting VM:`,
      err.message || err
    ]);
  }

  await promptText("\nPress Enter to continue...");
}

async function handleStartAllVMs() {
  const stoppedVms = Object.values(cache).filter((info) => info.status === "DOWN");
  if (stoppedVms.length === 0) {
    printBox("START ALL VMS", ["No stopped VMs to start."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  printBox("START ALL VMS", [
    `Starting ${stoppedVms.length} VM(s)...`,
    ...stoppedVms.map(vm => `  • ${vm.name}`)
  ]);

  const promises = stoppedVms.map(async (vm) => {
    if (!vm.sandbox) return;
    try {
      await vm.sandbox.start();
      vm.status = "UP";
    } catch (err: any) {
      // Ignore or log error in TUI
    }
  });

  await Promise.all(promises);

  printBox("START ALL VMS DONE", [
    `Finished starting ${stoppedVms.length} VM(s).`,
    "All available nodes are now starting."
  ]);
  await promptText("\nPress Enter to continue...");
}

async function handleStopVM() {
  const runningVms = Object.values(cache).filter((info) => info.status === "UP");
  if (runningVms.length === 0) {
    printBox("STOP VM", ["No running VMs to stop."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  const items = runningVms.map(vm => vm.name);
  const selectedIdx = await selectFromList("SELECT VM TO STOP", items);
  if (selectedIdx === null) {
    printBox("STOP VM", ["Operation cancelled."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  const selectedVm = runningVms[selectedIdx];
  if (!selectedVm || !selectedVm.sandbox) {
    printBox("STOP VM", ["❌ Invalid VM selection."]);
    await promptText("\nPress Enter to continue...");
    return;
  }

  printBox("STOP VM", [
    `Stopping ${selectedVm.name}...`
  ]);

  try {
    await selectedVm.sandbox.stop();
    selectedVm.status = "DOWN";
    printBox("STOP VM", [
      `Successfully stopped ${selectedVm.name}!`,
      "Done."
    ]);
  } catch (err: any) {
    printBox("STOP VM", [
      `❌ Error stopping VM:`,
      err.message || err
    ]);
  }

  await promptText("\nPress Enter to continue...");
}

async function main() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  let menuCursor = 0;
  const menuOptions = [
    "Create VM",
    "Delete VM",
    "SSH into VM",
    "Regenerate SSH (all)",
    "Start VM",
    "Start All VMs",
    "Stop VM",
    "Refresh",
    "Exit",
  ];

  const render = () => {
    console.clear();
    printStatusTable();
    console.log("SELECT AN ACTION:");
    menuOptions.forEach((opt, idx) => {
      if (idx === menuCursor) {
        console.log(`  \x1b[1;36m➔  ${opt.padEnd(30)}\x1b[0m`);
      } else {
        console.log(`     ${opt}`);
      }
    });
    console.log(`\n\x1b[2m(Use ↑/↓ to navigate, Enter to select)\x1b[0m`);
  };

  await refresh();

  while (true) {
    render();
    const actionIdx = await new Promise<number | null>((resolve) => {
      const onKey = (str: string, key: any) => {
        if (!key) return;
        if (key.name === "up") {
          menuCursor = (menuCursor - 1 + menuOptions.length) % menuOptions.length;
          render();
        } else if (key.name === "down") {
          menuCursor = (menuCursor + 1) % menuOptions.length;
          render();
        } else if (key.name === "return") {
          process.stdin.removeListener("keypress", onKey);
          resolve(menuCursor);
        } else if (key.ctrl && key.name === "c") {
          process.stdin.removeListener("keypress", onKey);
          resolve(null);
        }
      };
      process.stdin.on("keypress", onKey);
    });

    if (actionIdx === null) {
      cleanExit();
    }

    switch (actionIdx) {
      case 0:
        await handleCreateVM();
        break;
      case 1:
        await handleDeleteVM();
        break;
      case 2:
        await handleSshVM();
        break;
      case 3:
        await handleRegenAllSSH();
        break;
      case 4:
        await handleStartVM();
        break;
      case 5:
        await handleStartAllVMs();
        break;
      case 6:
        await handleStopVM();
        break;
      case 7:
        await refresh();
        break;
      case 8:
        cleanExit();
    }
  }
}

main().catch((err) => {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  console.error(err);
});