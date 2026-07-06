import subprocess
import os

def run_command(command: str, cwd: str = "/home/daytona") -> dict:
    """
    Executes a shell command and returns the results.
    """
    print(f"[Executor] Running command: {command} in {cwd}")
    try:
        # Run command, capture stdout/stderr
        process = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=600  # 10 minutes timeout
        )
        return {
            "exit_code": process.returncode,
            "stdout": process.stdout,
            "stderr": process.stderr
        }
    except subprocess.TimeoutExpired:
        return {
            "exit_code": -1,
            "stdout": "",
            "stderr": "Execution Timeout (exceeded 10 minutes)."
        }
    except Exception as e:
        return {
            "exit_code": -1,
            "stdout": "",
            "stderr": str(e)
        }
