from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel,Field    

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
