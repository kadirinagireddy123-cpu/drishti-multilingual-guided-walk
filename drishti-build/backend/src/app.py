"""FastAPI application setup (converted from app.js)."""
import sys
import time
import logging
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

try:
    from .config.env import config
    from .routes.vision_routes import router as vision_router
    from .routes.chat_routes import router as chat_router
    from .routes.tts_routes import router as tts_router
    from .routes.info_routes import router as info_router
    from .routes.transcribe_routes import router as transcribe_router
except (ImportError, ValueError):
    from src.config.env import config
    from src.routes.vision_routes import router as vision_router
    from src.routes.chat_routes import router as chat_router
    from src.routes.tts_routes import router as tts_router
    from src.routes.info_routes import router as info_router
    from src.routes.transcribe_routes import router as transcribe_router

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("drishti.app")

def create_app() -> FastAPI:
    app = FastAPI(
        title="Drishti: Voice & Vision AI Backend",
        description="Multimodal AI assistive service empowering visually impaired individuals.",
        version="1.0.0",
        docs_url="/docs",
        redoc_url="/redoc",
        redirect_slashes=False,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"] if "*" in config.CORS_ORIGIN else config.CORS_ORIGIN,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def request_logger_middleware(request: Request, call_next):
        start_time = time.time()
        response = await call_next(request)
        process_time = (time.time() - start_time) * 1000
        response.headers["X-Process-Time-Ms"] = f"{process_time:.2f}"
        logger.info(
            f"{request.method} {request.url.path} - {response.status_code} ({process_time:.1f}ms)"
        )
        return response

    # Mount direct endpoints
    app.include_router(vision_router)
    app.include_router(chat_router)
    app.include_router(tts_router)
    app.include_router(info_router)
    app.include_router(transcribe_router)

    # Also mount under /api prefix for standard REST clients
    app.include_router(vision_router, prefix="/api")
    app.include_router(chat_router, prefix="/api")
    app.include_router(tts_router, prefix="/api")
    app.include_router(info_router, prefix="/api")
    app.include_router(transcribe_router, prefix="/api")

    from fastapi.responses import HTMLResponse, FileResponse
    from fastapi.staticfiles import StaticFiles

    _ROOT_DIR = _BACKEND_DIR.parent.parent
    candidates = [
        _BACKEND_DIR / "static",
        _BACKEND_DIR.parent / "frontend",
        _ROOT_DIR / "public",
        _ROOT_DIR / "drishti-build" / "frontend",
        Path("static"),
        Path("public"),
        Path("frontend"),
    ]
    frontend_dir = None
    for cand in candidates:
        if cand.exists() and (cand / "index.html").exists():
            frontend_dir = cand
            break

    if frontend_dir:
        js_dir = frontend_dir / "js"
        if js_dir.exists():
            app.mount("/js", StaticFiles(directory=str(js_dir)), name="js")

        @app.get("/", response_class=HTMLResponse)
        async def serve_root():
            index_file = frontend_dir / "index.html"
            return HTMLResponse(content=index_file.read_text(encoding="utf-8"))

        @app.get("/index.html", response_class=HTMLResponse)
        async def serve_index_html():
            index_file = frontend_dir / "index.html"
            return HTMLResponse(content=index_file.read_text(encoding="utf-8"))

        @app.get("/styles.css")
        async def serve_styles():
            css_file = frontend_dir / "styles.css"
            if css_file.exists():
                return FileResponse(str(css_file), media_type="text/css")
            return JSONResponse(status_code=404, content={"error": "styles.css not found"})

    @app.exception_handler(404)
    async def custom_404_handler(request: Request, exc):
        return JSONResponse(
            status_code=404,
            content={
                "success": False,
                "error": f"Endpoint not found: {request.method} {request.url.path}",
                "availableEndpoints": [
                    "POST /vision-assist (or /api/vision-assist)",
                    "POST /chat (or /api/chat)",
                    "POST /tts (or /api/tts)",
                    "GET /health (or /api/health)",
                    "GET /languages (or /api/languages)",
                    "GET /modes (or /api/modes)",
                    "GET /docs",
                ],
            },
        )

    return app

app = create_app()
