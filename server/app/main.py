import os
from fastapi import FastAPI, Depends, HTTPException, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
import datetime
from pydantic import BaseModel
from typing import List, Optional

from .database import engine, Base, get_db
from .models import Worker, Job
from .scheduler import start_scheduler

# Create tables
Base.metadata.create_all(bind=engine)

app = FastAPI(title="Daytona Distributed Compute Control Plane")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic schemas
class HeartbeatPayload(BaseModel):
    name: str
    cpu: int
    memory: int
    capabilities: List[str]
    status: str  # idle, running, offline

class JobSubmit(BaseModel):
    command: str

class LogPayload(BaseModel):
    log_text: str

class CompletePayload(BaseModel):
    result: str
    success: bool

# Serve static files if folder exists
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.on_event("startup")
def startup_event():
    start_scheduler()
    print("[Main] Control Server started and scheduler loop initialized.")

# Serve Dashboard HTML directly from root
@app.get("/", response_class=HTMLResponse)
def get_dashboard():
    dashboard_path = os.path.join(os.path.dirname(__file__), "static", "index.html")
    if os.path.exists(dashboard_path):
        with open(dashboard_path, "r") as f:
            return f.read()
    return """
    <html>
        <head><title>Daytona Control Plane</title></head>
        <body style="font-family: sans-serif; background-color: #121212; color: #ffffff; padding: 50px; text-align: center;">
            <h1>Daytona Distributed Compute Control Plane</h1>
            <p>Static index.html is missing. API is fully functional.</p>
        </body>
    </html>
    """

# 1. Heartbeat & Registration
@app.post("/api/workers/heartbeat")
def worker_heartbeat(payload: HeartbeatPayload, db: Session = Depends(get_db)):
    worker = db.query(Worker).filter(Worker.name == payload.name.lower()).first()
    if not worker:
        # Create worker
        worker = Worker(
            name=payload.name.lower(),
            cpu=payload.cpu,
            memory=payload.memory,
            capabilities=payload.capabilities,
            status=payload.status,
            last_heartbeat=datetime.datetime.utcnow()
        )
        db.add(worker)
        print(f"[Main] Registered new worker: {payload.name.lower()}")
    else:
        # Update worker
        worker.cpu = payload.cpu
        worker.memory = payload.memory
        worker.capabilities = payload.capabilities
        # Only overwrite status if worker is not running a job or reports offline/running
        if worker.status != "running" or payload.status == "offline" or payload.status == "idle":
            worker.status = payload.status
        worker.last_heartbeat = datetime.datetime.utcnow()
        
    db.commit()
    return {"status": "ok", "message": f"Heartbeat received from {payload.name.lower()}"}

# 2. Submit Job
@app.post("/api/jobs/submit")
def submit_job(payload: JobSubmit, db: Session = Depends(get_db)):
    job = Job(
        command=payload.command,
        status="pending",
        created_at=datetime.datetime.utcnow()
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    print(f"[Main] Job {job.id} submitted: {payload.command}")
    return {"status": "ok", "job_id": job.id}

# 3. List Workers
@app.get("/api/workers")
def list_workers(db: Session = Depends(get_db)):
    workers = db.query(Worker).all()
    # Serialize JSON
    res = []
    for w in workers:
        res.append({
            "name": w.name,
            "status": w.status,
            "cpu": w.cpu,
            "memory": w.memory,
            "capabilities": w.capabilities,
            "last_heartbeat": w.last_heartbeat.isoformat() if w.last_heartbeat else None,
            "current_job_id": w.current_job_id
        })
    return res

# 4. List Jobs
@app.get("/api/jobs")
def list_jobs(db: Session = Depends(get_db)):
    jobs = db.query(Job).order_by(Job.created_at.desc()).limit(100).all()
    return jobs

# 5. Get Job details
@app.get("/api/jobs/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

# 6. Append logs
@app.post("/api/jobs/{job_id}/logs")
def append_job_logs(job_id: int, payload: LogPayload, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.logs is None:
        job.logs = ""
    job.logs += payload.log_text
    db.commit()
    return {"status": "ok"}

# 7. Complete or Fail Job
@app.post("/api/jobs/{job_id}/complete")
def complete_job(job_id: int, payload: CompletePayload, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
        
    job.status = "completed" if payload.success else "failed"
    job.result = payload.result
    job.completed_at = datetime.datetime.utcnow()
    
    # Release worker
    if job.worker_name:
        worker = db.query(Worker).filter(Worker.name == job.worker_name).first()
        if worker:
            worker.status = "idle"
            worker.current_job_id = None
            
    db.commit()
    print(f"[Main] Job {job_id} marked as {job.status}. Result size: {len(payload.result)}")
    return {"status": "ok"}
