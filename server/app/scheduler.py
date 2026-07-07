import os
import time
import json
import threading
import datetime
from sqlalchemy.orm import Session
from .database import SessionLocal
from .models import Job, Worker

# Load Daytona API key from .env
def get_api_key_for_worker(name: str) -> str:
    env_paths = [
        "/home/daytona/.env",
        "/app/.env",
        ".env",
        "../.env"
    ]
    for path in env_paths:
        if os.path.exists(path):
            with open(path, "r") as f:
                for line in f:
                    if line.strip().startswith(f"DAYTONA_MACHINE_{name.upper()}="):
                        return line.split("=", 1)[1].strip()
    return None

def execute_job_on_worker(job_id: int, worker_name: str):
    print(f"[Scheduler] Starting job {job_id} on worker {worker_name}...")
    
    # We import Daytona inside the function to avoid global import issues during initialization
    from daytona import Daytona
    
    db = SessionLocal()
    try:
        # Get Job from DB
        job = db.query(Job).filter(Job.id == job_id).first()
        if not job:
            print(f"[Scheduler] Job {job_id} not found in DB.")
            return
            
        # Get worker API key
        api_key = get_api_key_for_worker(worker_name)
        if not api_key:
            print(f"[Scheduler] API key for worker {worker_name} not found.")
            job.status = "failed"
            job.result = "Failed to load worker API key."
            db.commit()
            return
            
        daytona = Daytona(api_key=api_key)
        
        # Find sandbox
        sandbox = None
        for s in daytona.list():
            if s.name.lower() == worker_name.lower():
                sandbox = s
                break
                
        if not sandbox:
            print(f"[Scheduler] Sandbox for worker {worker_name} not found.")
            job.status = "failed"
            job.result = "Worker sandbox not found."
            db.commit()
            return

        # Start sandbox if it's not started
        if sandbox.state != "started":
            print(f"[Scheduler] Starting worker sandbox {worker_name}...")
            sandbox.start()

        # Update Job status to running
        job.status = "running"
        job.started_at = datetime.datetime.utcnow()
        db.commit()

        # Run the job runner on the worker sandbox
        # Pass the job command and job ID
        # The worker runner script is at /home/daytona/worker/job_runner.py
        # We escape the command to pass it safely as an arg
        safe_command = job.command.replace("'", "'\\''")
        run_cmd = f"python3 /home/daytona/worker/job_runner.py --job-id {job_id} --command '{safe_command}'"
        
        print(f"[Scheduler] Executing command on {worker_name}: {run_cmd}")
        response = sandbox.process.exec(run_cmd)
        
        # Refresh job and worker states
        db.refresh(job)
        worker = db.query(Worker).filter(Worker.name == worker_name).first()
        
        # If the local execution finished but worker didn't update status, we parse response
        print(f"[Scheduler] Job {job_id} run completed. Exit code: {response.exit_code}")
        
        if response.exit_code != 0:
            job.status = "failed"
            job.result = response.result
            job.completed_at = datetime.datetime.utcnow()
            if worker:
                worker.status = "idle"
                worker.current_job_id = None
            db.commit()
        
    except Exception as e:
        print(f"[Scheduler] Exception executing job {job_id}: {str(e)}")
        db.rollback()
        # Fallback to failing the job
        try:
            job = db.query(Job).filter(Job.id == job_id).first()
            if job:
                job.status = "failed"
                job.result = f"Scheduler Exception: {str(e)}"
                job.completed_at = datetime.datetime.utcnow()
                db.commit()
            worker = db.query(Worker).filter(Worker.name == worker_name).first()
            if worker:
                worker.status = "idle"
                worker.current_job_id = None
                db.commit()
        except:
            pass
    finally:
        db.close()

def scheduler_loop():
    print("[Scheduler] Starting background scheduler loop...")
    while True:
        db = SessionLocal()
        try:
            # Clean up offline workers: if last heartbeat was > 30 seconds ago, mark offline
            now = datetime.datetime.utcnow()
            offline_threshold = now - datetime.timedelta(seconds=45)
            active_workers = db.query(Worker).filter(Worker.status != "offline").all()
            for w in active_workers:
                if w.last_heartbeat < offline_threshold:
                    print(f"[Scheduler] Worker {w.name} heartbeat timeout. Marking offline.")
                    w.status = "offline"
                    # If it was running a job, mark the job as failed/pending again
                    if w.current_job_id:
                        job = db.query(Job).filter(Job.id == w.current_job_id).first()
                        if job and job.status == "running":
                            job.status = "pending"
                            job.result = "Worker disconnected during execution."
                        w.current_job_id = None
                    db.commit()

            # Find oldest pending job
            pending_job = db.query(Job).filter(Job.status == "pending").order_by(Job.created_at.asc())
            job = pending_job.first()
            
            if job:
                # Find an idle worker
                idle_worker = db.query(Worker).filter(Worker.status == "idle").first()
                if idle_worker:
                    # Assign job to worker
                    idle_worker.status = "running"
                    idle_worker.current_job_id = job.id
                    job.worker_name = idle_worker.name
                    db.commit()
                    
                    # Run job execution in a separate background thread
                    t = threading.Thread(target=execute_job_on_worker, args=(job.id, idle_worker.name))
                    t.daemon = True
                    t.start()
                    
        except Exception as e:
            print(f"[Scheduler] Error in scheduler loop: {e}")
        finally:
            db.close()
            
        time.sleep(2)

def start_scheduler():
    t = threading.Thread(target=scheduler_loop)
    t.daemon = True
    t.start()
