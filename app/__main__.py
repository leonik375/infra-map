import uvicorn

from .main import LISTEN_HOST, LISTEN_PORT, app

if __name__ == "__main__":
    uvicorn.run(app, host=LISTEN_HOST, port=LISTEN_PORT, log_level="warning")
