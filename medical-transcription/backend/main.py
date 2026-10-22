from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel,Field    
import os 
from dotenv import load_dotenv
load_dotenv()
import tempfile
from fastapi import UploadFile,File,HTTPException
from faster_whisper import WhisperModel
from groq import Groq
import json


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


groq_client=Groq(api_key=os.getenv("GROQ_API_KEY"))

@app.post("/api/summarize")
def summarize_transcript(request: TranscriptionRequest):
    transcript = request.transcript.strip()

    if not transcript:
        raise HTTPException(
            status_code=400,
            detail="Transcript cannot be empty.",
        )

    try:
        response=groq_client.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=[
                {
                    "role": "system",
                    "content": """
        You are a clinical documentation assistant.
        Extract information only from the supplied transcript.
        Never invent patient details, diagnoses, medications, allergies,
        examination findings, or test results.
        Use "Not mentioned" for missing information.
        Treat the output as a draft for review by a qualified clinician.

        Return valid JSON with exactly these fields:
        {
        "patient_details": {
            "name": "string",
            "age": "string",
            "gender": "string"
        },
        "summary": "string",
        "chief_complaints": ["string"],
        "clinical_impression": ["string"],
        "medications": ["string"],
        "allergies": ["string"],
        "examinations_and_tests": ["string"],
        "past_medical_history": ["string"],
        "follow_up": ["string"]
        }
        """
            },
            {
                    "role": "user",
                    "content": f"Create a clinical summary from this transcript:\n\n{transcript}",
            },
            ],
            temperature=0,
            max_completion_tokens=1500,
            reasoning_effort="low",
            response_format={"type": "json_object"}
        )

        content = response.choices[0].message.content

        if not content :
            raise HTTPException(
                status_code=500,
                detail="The AI returned an empty response. Please try again",
            )

        summary=json.loads(content)

        return {
            "status": "success",
            "clinical_summary": summary,
        }

    except HTTPException:
        raise
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=502,
            detail="The AI returned invalid JSON. Please try again.",
        )
    except Exception:
        raise HTTPException(
            status_code=502,
            detail="Failed to generate clinical summary. Please try again.",
        )