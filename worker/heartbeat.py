import time
import json
import sys
from config import get_self_name, get_system_specs
from job_runner import send_jett_api

def main():
    worker_name = get_self_name()
    if worker_name == "unknown":
        print("[Heartbeat] Error: Could not resolve self worker name.")
        sys.exit(1)
        
    specs = get_system_specs()
    print(f"[Heartbeat] Starting heartbeat loop for worker '{worker_name}'...")
    
    while True:
        try:
            payload = {
                "name": worker_name,
                "cpu": specs["cpu"],
                "memory": specs["memory"],
                "capabilities": specs["capabilities"],
                "status": "idle"  # Will be overridden during active job runs
            }
            send_jett_api("/api/workers/heartbeat", payload)
        except Exception as e:
            print(f"[Heartbeat] Error sending heartbeat: {e}")
            
        time.sleep(10)

if __name__ == "__main__":
    main()
