import datetime
from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, JSON
from .database import Base

class Worker(Base):
    __tablename__ = "workers"

    name = Column(String, primary_key=True, index=True)
    status = Column(String, default="offline")  # idle, running, offline
    cpu = Column(Integer, default=0)
    memory = Column(Integer, default=0)
    capabilities = Column(JSON, default=list)
    last_heartbeat = Column(DateTime, default=datetime.datetime.utcnow)
    current_job_id = Column(Integer, nullable=True)

class Job(Base):
    __tablename__ = "jobs"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    worker_name = Column(String, ForeignKey("workers.name"), nullable=True)
    status = Column(String, default="pending")  # pending, running, completed, failed
    command = Column(String, nullable=False)
    logs = Column(Text, default="")
    result = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
