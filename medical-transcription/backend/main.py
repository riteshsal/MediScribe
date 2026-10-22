from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel,Field    
import os 
import tempfile
from fastapi import UploadFile,File,HTTPException
from faster_whisper import WhisperModel

app = FastAPI(
    title="Medical Transcription API",
    description="Backend for live medical transcription and clinical summaries",
    version="1.0.0",
)

# Allow the local frontend to communicate with the backend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class TranscriptionRequest(BaseModel):
    transcript: str = Field(..., min_length=1, description="Medical conversation transcript")

whisper_model=WhisperModel(
    "tiny",
    device="cpu",
    compute_type="int8"
)

@app.get("/")
def home():
    return {
        "message": "Medical Transcription API is running",
        "status": "success",
    }


@app.get("/health")
def health_check():
    return {"status": "healthy"}


@app.post("/api/process-transcript")
def process_transcript(request:TranscriptionRequest):
    transcript = request.transcript.strip()

    if not transcript:
        return {"error": "Transcript cannot be empty."}
    
    return {
            "status": "success",
            "transcript": transcript,
            "message": "Transcript received successfully",
        }


@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(
        status_code=400,
        detail="Please upload an audio file.",
    )

    temp_path = None

    try:
        suffix = os.path.splitext(file.filename or "recording.webm")[1]
        if not suffix:
            suffix = ".webm"

        with tempfile.NamedTemporaryFile(
            delete=False,
            suffix=suffix,
        ) as temp_file:
            temp_path = temp_file.name
            while chunk := await file.read(1024 * 1024):
                temp_file.write(chunk)

        segments, info = whisper_model.transcribe(
            temp_path,
            vad_filter=True,
        )

        transcript = " ".join(
            segment.text.strip() for segment in segments
        ).strip()

        return {
            "status": "success",
            "transcript": transcript,
            "language": info.language,
            "duration_seconds": round(info.duration, 2),
        }

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Audio transcription failed: {str(e)}",
        )

    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        await file.close()
