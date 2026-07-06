import os
import sys
import json
import argparse
import subprocess
import threading
from daytona import Daytona
from config import load_all_api_keys, get_self_name

# Helper to run a curl call on Jett's FastAPI
def send_jett_api(endpoint: str, payload: dict):
    keys = load_all_api_keys()
    jett_key = keys.get("jett")
    if not jett_key:
        print("[JobRunner] Jett API key not found in .env!")
        return
        
    try:
        daytona = Daytona(api_key=jett_key)
        # Find jett sandbox to make sure it exists
        jett_sandbox = None
        for s in daytona.list():
            if s.name.lower() == "jett":
                jett_sandbox = s
                break
                
        if not jett_sandbox:
            print("[JobRunner] Jett sandbox not found via API!")
            return

        payload_str = json.dumps(payload)
        # Escape single quotes in JSON payload for shell execution
        escaped_payload = payload_str.replace("'", "'\\''")
        curl_cmd = f"curl -s -X POST -H 'Content-Type: application/json' -d '{escaped_payload}' http://localhost:8000{endpoint}"
        
        # Execute locally on Jett
        jett_sandbox.process.exec(curl_cmd)
    except Exception as e:
        print(f"[JobRunner] Failed to send log to Jett: {e}")

def stream_pipe(pipe, job_id):
    """
    Reads lines from a pipe and streams them to Jett's API.
    """
    for line in iter(pipe.readline, ''):
        if line:
            # Report log line back to Jett
            send_jett_api(f"/api/jobs/{job_id}/logs", {"log_text": line})

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", type=int, required=True)
    parser.add_argument("--command", type=str, required=True)
    args = parser.parse_args()

    job_id = args.job_id
    command = args.command
    worker_name = get_self_name()

    print(f"[JobRunner] Job #{job_id} assigned. Worker: {worker_name}. Executing command: {command}")

    # Set worker state to running in Jett database
    send_jett_api("/api/workers/heartbeat", {
        "name": worker_name,
        "cpu": 4, # Fallback, config will update dynamically
        "memory": 8,
        "capabilities": ["docker", "python", "node", "git"],
        "status": "running"
    })

    try:
        # Spawn the process
        process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd="/home/daytona"
        )

        # Start log streaming threads
        t1 = threading.Thread(target=stream_pipe, args=(process.stdout, job_id))
        t2 = threading.Thread(target=stream_pipe, args=(process.stderr, job_id))
        t1.daemon = True
        t2.daemon = True
        t1.start()
        t2.start()

        # Wait for completion
        exit_code = process.wait()
        t1.join()
        t2.join()

        success = (exit_code == 0)
        result_msg = f"Completed with exit code: {exit_code}" if success else f"Failed with exit code: {exit_code}"
        
        # Send final complete call
        send_jett_api(f"/api/jobs/{job_id}/complete", {
            "result": result_msg,
            "success": success
        })

    except Exception as e:
        print(f"[JobRunner] Exception during execution: {e}")
        send_jett_api(f"/api/jobs/{job_id}/complete", {
            "result": f"Execution failed: {str(e)}",
            "success": False
        })
    
    # Update worker back to idle status
    send_jett_api("/api/workers/heartbeat", {
        "name": worker_name,
        "cpu": 4,
        "memory": 8,
        "capabilities": ["docker", "python", "node", "git"],
        "status": "idle"
    })

if __name__ == "__main__":
    main()
