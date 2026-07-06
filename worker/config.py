import os
import multiprocessing

def load_all_api_keys():
    keys = {}
    env_paths = ["/home/daytona/.env", ".env", "../.env"]
    for path in env_paths:
        if os.path.exists(path):
            with open(path, "r") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("DAYTONA_MACHINE_") or line.startswith("DAYTONA_MACHINES="):
                        if "=" in line:
                            k, v = line.split("=", 1)
                            # Handle JSON format or individual prefixed keys
                            if k == "DAYTONA_MACHINES":
                                # Strip single quotes and load JSON
                                import json
                                try:
                                    val_str = v.strip("'").strip('"')
                                    keys.update(json.loads(val_str))
                                except Exception as e:
                                    print("Err parsing JSON env:", e)
                            else:
                                name = k.replace("DAYTONA_MACHINE_", "").lower()
                                keys[name] = v.strip()
    return keys

def get_self_name() -> str:
    # Check if manually overridden
    if os.getenv("WORKER_NAME"):
        return os.getenv("WORKER_NAME").lower()
        
    sandbox_id = os.getenv("DAYTONA_SANDBOX_ID")
    if not sandbox_id:
        return "unknown"
        
    # We resolve our name by querying Daytona APIs using the keys we have
    from daytona import Daytona
    keys = load_all_api_keys()
    
    for name, key in keys.items():
        try:
            daytona = Daytona(api_key=key)
            for s in daytona.list():
                if s.id == sandbox_id:
                    return s.name.lower()
        except:
            continue
            
    return "unknown"

def get_system_specs():
    # Cores
    cores = multiprocessing.cpu_count()
    # Memory (RAM) in GB
    mem_gb = 8 # Fallback
    try:
        with open('/proc/meminfo', 'r') as f:
            for line in f:
                if 'MemTotal' in line:
                    mem_kb = int(line.split()[1])
                    mem_gb = round(mem_kb / (1024 * 1024))
                    break
    except:
        pass
    
    return {
        "cpu": cores,
        "memory": mem_gb,
        "capabilities": ["docker", "python", "node", "git"]
    }
