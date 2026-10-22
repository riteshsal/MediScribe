
const API_BASE = "http://127.0.0.1:8000";
const SEGMENT_SECONDS = 4;
const VAD_THRESHOLD = 0.025;

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const chunkCount = document.getElementById("chunkCount");
const liveTranscript = document.getElementById("liveTranscript");
const clearSummaryBtn = document.getElementById("clearSummaryBtn");
const clearBtn = document.getElementById("clearBtn");
const saveBtn = document.getElementById("saveBtn");
const processBtn = document.getElementById("processBtn");
const copyBtn = document.getElementById("copyBtn");

const wordCountEl = document.getElementById("wordCount");
const durationEl = document.getElementById("duration");
const vadStatusEl = document.getElementById("vadStatus");
const recordingStatusEl = document.getElementById("recordingStatus");
const audioStatusEl = document.getElementById("audioStatus");
const transcriptEl = document.getElementById("transcript");
const processStatusEl = document.getElementById("processStatus");
const summaryContentEl = document.getElementById("summaryContent");

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let silentGain = null;

let isRecording = false;
let isProcessingAudio = false;
let recordingStartTime = 0;
let durationInterval = null;
let vadAnimationId = null;

let audioBuffer = [];
let speechDetectedInSegment = false;
let speechSegmentCount = 0;
let transcriptText = "";
let recordingParts = [];
let recordingSampleRate = 44100;
let summaryData = null;

function updateWordCount() {
    const text = transcriptText.trim();
    wordCountEl.textContent = text ? text.split(/\s+/).length : 0;
}

function updateDuration() {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    durationEl.textContent =
        `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:` +
        `${String(elapsed % 60).padStart(2, "0")}`;
}

function renderTranscript() {
    transcriptEl.replaceChildren();

    if (!transcriptText.trim()) {
        const placeholder = document.createElement("p");
        placeholder.className = "placeholder";
        placeholder.textContent = isRecording
            ? "Listening for speech..."
            : "Your consultation transcript will appear here.";
        transcriptEl.appendChild(placeholder);
        return;
    }

    const paragraph = document.createElement("p");
    paragraph.textContent = transcriptText;
    transcriptEl.appendChild(paragraph);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function calculateRMS(samples) {
    let sumSquares = 0;

    for (let i = 0; i < samples.length; i++) {
        sumSquares += samples[i] * samples[i];
    }

    return Math.sqrt(sumSquares / samples.length);
}

function mergeAudioBuffers(buffers) {
    const totalLength = buffers.reduce(
        (total, buffer) => total + buffer.length, 0
    );

    const result = new Float32Array(totalLength);
    let offset = 0;

    for (const buffer of buffers) {
        result.set(buffer, offset);
        offset += buffer.length;
    }

    return result;
}

function encodeWav(samples, sampleRate) {
    const bytesPerSample = 2;
    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);

    function writeString(offset, value) {
        for (let i = 0; i < value.length; i++) {
            view.setUint8(offset + i, value.charCodeAt(i));
        }
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + samples.length * bytesPerSample, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, samples.length * bytesPerSample, true);

    let offset = 44;

    for (const sample of samples) {
        const clipped = Math.max(-1, Math.min(1, sample));
        const value = clipped < 0
            ? clipped * 32768
            : clipped * 32767;

        view.setInt16(offset, value, true);
        offset += 2;
    }

    return new Blob([buffer], { type: "audio/wav" });
}

async function transcribeSegment(samples) {
    const wavBlob = encodeWav(samples, recordingSampleRate);

    const formData = new FormData();
    formData.append("file", wavBlob, "speech-segment.wav");

    try {
        const response = await fetch(`${API_BASE}/api/transcribe`, {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Transcription request failed (${response.status})`);
        }

        const result = await response.json();
        chunkCount.textContent = Number(chunkCount.textContent) + 1;
        const text = (result.transcript || "").trim();

        if (text) {
            liveTranscript.textContent = text;

            transcriptText = transcriptText
                ? `${transcriptText} ${text}`
                : text;

            renderTranscript();
            updateWordCount();
        }
    } catch (error) {
        console.error("Segment transcription error:", error);
        audioStatusEl.textContent = "A segment failed; check backend";
    }
}

async function processAudioSegment(samples, hadSpeech) {
    if (!hadSpeech || samples.length === 0) return;

    speechSegmentCount++;
    audioStatusEl.textContent = `Transcribing speech segment ${speechSegmentCount}...`;

    await transcribeSegment(samples);

    if (isRecording) {
        audioStatusEl.textContent = "Listening for speech";
    }
}

function handleAudioProcess(event) {
    if (!isRecording) return;

    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input);
    recordingParts.push(copy);

    audioBuffer.push(copy);

    const rms = calculateRMS(input);
    const active = rms > VAD_THRESHOLD;

    if (active) {
        speechDetectedInSegment = true;
        vadStatusEl.textContent = "Voice detected";
        vadStatusEl.style.color = "#1c9b70";
    } else {
        vadStatusEl.textContent = "Silence";
        vadStatusEl.style.color = "#777d91";
    }

    const bufferedSamples = audioBuffer.reduce(
        (total, part) => total + part.length, 0
    );

    const targetSamples = recordingSampleRate * SEGMENT_SECONDS;

    if (bufferedSamples >= targetSamples) {
        const samples = mergeAudioBuffers(audioBuffer);
        const hadSpeech = speechDetectedInSegment;

        audioBuffer = [];
        speechDetectedInSegment = false;

        // Keep segment requests in order to avoid transcript reordering.
        if (!isProcessingAudio) {
            isProcessingAudio = true;
            processAudioSegment(samples, hadSpeech)
                .finally(() => {
                    isProcessingAudio = false;
                });
        } else {
            // Preserve the segment for the next processing cycle.
            audioBuffer = [samples, ...audioBuffer];
            speechDetectedInSegment = hadSpeech;
        }
    }
}

async function startRecording() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        audioContext = new AudioContext();
        await audioContext.resume();

        recordingSampleRate = audioContext.sampleRate;
        sourceNode = audioContext.createMediaStreamSource(mediaStream);

        // ScriptProcessorNode is deprecated but widely supported for this prototype.
        processorNode = audioContext.createScriptProcessor(4096, 1, 1);
        silentGain = audioContext.createGain();
        silentGain.gain.value = 0;

        sourceNode.connect(processorNode);
        processorNode.connect(silentGain);
        silentGain.connect(audioContext.destination);

        processorNode.onaudioprocess = handleAudioProcess;

        audioBuffer = [];
        recordingParts = [];
        transcriptText = "";
        speechDetectedInSegment = false;
        speechSegmentCount = 0;
        summaryData = null;

        isRecording = true;
        recordingStartTime = Date.now();

        startBtn.disabled = true;
        stopBtn.disabled = false;
        processBtn.disabled = true;
        copyBtn.disabled = true;

        recordingStatusEl.textContent = "● Recording";
        recordingStatusEl.style.color = "#dc4c5a";
        audioStatusEl.textContent = "Microphone active";
        vadStatusEl.textContent = "Listening";

        renderTranscript();
        updateWordCount();

        durationInterval = setInterval(updateDuration, 1000);
    } catch (error) {
        console.error("Could not start microphone:", error);
        alert(`Could not start microphone: ${error.message}`);
        cleanupAudio();
    }
}

async function stopRecording() {
    if (!isRecording) return;

    isRecording = false;
    stopBtn.disabled = true;

    if (durationInterval) {
        clearInterval(durationInterval);
        durationInterval = null;
    }

    // Process the final partial segment.
    const remainingSamples = mergeAudioBuffers(audioBuffer);
    const hadSpeech = speechDetectedInSegment;
    audioBuffer = [];
    speechDetectedInSegment = false;

    if (remainingSamples.length && hadSpeech) {
        audioStatusEl.textContent = "Transcribing final segment...";
        await transcribeSegment(remainingSamples);
    }

    // Store a WAV recording of the entire session for the Save button.
    const allSamples = mergeAudioBuffers(recordingParts);
    window.lastRecording = encodeWav(allSamples, recordingSampleRate);

    cleanupAudio();

    startBtn.disabled = false;
    stopBtn.disabled = true;
    processBtn.disabled = !transcriptText.trim();

    recordingStatusEl.textContent = "● Recording stopped";
    recordingStatusEl.style.color = "#777d91";
    audioStatusEl.textContent = "Recording stopped";
    vadStatusEl.textContent = "Inactive";
    renderTranscript();
}

function cleanupAudio() {
    if (processorNode) {
        processorNode.onaudioprocess = null;
        processorNode.disconnect();
        processorNode = null;
    }

    if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
    }

    if (silentGain) {
        silentGain.disconnect();
        silentGain = null;
    }

    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    if (audioContext && audioContext.state !== "closed") {
        audioContext.close();
    }

    audioContext = null;
}

function clearRecording() {
    if (isRecording) {
        stopRecording();
    }

    transcriptText = "";
    audioBuffer = [];
    recordingParts = [];
    window.lastRecording = null;
    summaryData = null;

    wordCountEl.textContent = "0";
    durationEl.textContent = "00:00";
    vadStatusEl.textContent = "Inactive";
    audioStatusEl.textContent = "Microphone not started";
    recordingStatusEl.textContent = "● Not recording";

    processBtn.disabled = false;
    copyBtn.disabled = true;

    renderTranscript();

    summaryContentEl.innerHTML = `
        <div class="summary-empty">
            <div class="empty-icon">✦</div>
            <h3>No summary generated yet</h3>
            <p>Record a consultation and process the transcript to generate structured clinical documentation.</p>
        </div>
    `;

    processStatusEl.textContent =
        "Review the transcript before generating the clinical summary.";
}

function saveRecording() {
    if (!window.lastRecording || !window.lastRecording.size) {
        alert("Stop the recording before saving it.");
        return;
    }

    const url = URL.createObjectURL(window.lastRecording);
    const link = document.createElement("a");

    link.href = url;
    link.download = "mediscribe-recording.wav";
    link.click();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

startBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);
clearBtn.addEventListener("click", clearRecording);
saveBtn.addEventListener("click", saveRecording);


function renderList(items) {
    if (!Array.isArray(items) || items.length === 0) {
        return "<li>Not mentioned</li>";
    }

    return items.map(item => {
        const li = document.createElement("li");
        li.textContent = String(item);
        return li.outerHTML;
    }).join("");
}

function renderSummary(data) {
    const patient = data.patient_details || {};

    summaryContentEl.replaceChildren();

    const sections = [
        {
            title: "Patient Details",
            content: `Name: ${patient.name || "Not mentioned"}\nAge: ${patient.age || "Not mentioned"}\nGender: ${patient.gender || "Not mentioned"}`,
            type: "text"
        },
        {
            title: "Clinical Summary",
            content: data.summary || "Not mentioned",
            type: "text"
        },
        {
            title: "Chief Complaints",
            content: data.chief_complaints,
            type: "list"
        },
        {
            title: "Clinical Impression",
            content: data.clinical_impression,
            type: "list"
        },
        {
            title: "Medications",
            content: data.medications,
            type: "list"
        },
        {
            title: "Allergies",
            content: data.allergies,
            type: "list"
        },
        {
            title: "Examinations & Tests",
            content: data.examinations_and_tests,
            type: "list"
        },
        {
            title: "Past Medical History",
            content: data.past_medical_history,
            type: "list"
        },
        {
            title: "Follow-up",
            content: data.follow_up,
            type: "list"
        }
    ];

    for (const section of sections) {
        const article = document.createElement("article");
        article.className = "summary-section";

        const heading = document.createElement("h3");
        heading.textContent = section.title;
        article.appendChild(heading);

        if (section.type === "list") {
            const ul = document.createElement("ul");
            ul.innerHTML = renderList(section.content);
            article.appendChild(ul);
        } else {
            const paragraph = document.createElement("p");
            paragraph.style.whiteSpace = "pre-line";
            paragraph.textContent = section.content;
            article.appendChild(paragraph);
        }

        summaryContentEl.appendChild(article);
    }
}

async function processTranscriptWithAI() {
    const transcript = transcriptText.trim();

    if (!transcript) {
        alert("Please record a consultation or enter a transcript first.");
        return;
    }

    processBtn.disabled = true;
    processStatusEl.textContent = "Generating clinical summary...";
    
    try {
        const response = await fetch(`${API_BASE}/api/summarize`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ transcript })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(
                result.detail || "Could not generate the clinical summary."
            );
        }

        if (!result.clinical_summary) {
            throw new Error("The AI response did not contain a clinical summary.");
        }

        summaryData = result.clinical_summary;
        renderSummary(summaryData);

        copyBtn.disabled = false;
        processStatusEl.textContent =
            "Summary generated. Please review all details for accuracy.";

    } catch (error) {
        console.error("Summary error:", error);
        processStatusEl.textContent = error.message;
    } finally {
        processBtn.disabled = false;
    }
}

processBtn.addEventListener("click", processTranscriptWithAI);



async function copyPrescription() {
    if (!summaryData) {
        alert("Please generate a clinical summary first.");
        return;
    }

    const patient = summaryData.patient_details || {};

    const prescriptionText = `
MEDISCRIBE — CLINICAL NOTES

PATIENT DETAILS
Name: ${patient.name || "Not mentioned"}
Age: ${patient.age || "Not mentioned"}
Gender: ${patient.gender || "Not mentioned"}

CLINICAL SUMMARY
${summaryData.summary || "Not mentioned"}

CHIEF COMPLAINTS
${(summaryData.chief_complaints || []).join("\n") || "Not mentioned"}

CLINICAL IMPRESSION
${(summaryData.clinical_impression || []).join("\n") || "Not mentioned"}

MEDICATIONS
${(summaryData.medications || []).join("\n") || "Not mentioned"}

ALLERGIES
${(summaryData.allergies || []).join("\n") || "Not mentioned"}

EXAMINATIONS AND TESTS
${(summaryData.examinations_and_tests || []).join("\n") || "Not mentioned"}

PAST MEDICAL HISTORY
${(summaryData.past_medical_history || []).join("\n") || "Not mentioned"}

FOLLOW-UP
${(summaryData.follow_up || []).join("\n") || "Not mentioned"}

Note: AI-generated draft. Verify all information before clinical use.
`.trim();

    try {
        await navigator.clipboard.writeText(prescriptionText);
        processStatusEl.textContent =
            "Clinical notes copied. Please verify them before use.";
    } catch (error) {
        console.error("Copy failed:", error);
        processStatusEl.textContent =
            "Could not copy automatically. Please use the browser's secure context and try again.";
    }
}

copyBtn.addEventListener("click", copyPrescription);
clearSummaryBtn.addEventListener("click", () => {
    summaryData = null;

    summaryContent.innerHTML = `
        <div class="summary-empty">
            <div class="empty-icon">✦</div>
            <h3>No summary generated yet</h3>
            <p>
                Process a consultation transcript to generate
                structured clinical documentation.
            </p>
        </div>
    `;

    copyBtn.disabled = true;
    processStatus.textContent = "Summary cleared. Your transcript is unchanged.";
});


const helpBtn = document.getElementById("helpBtn");

helpBtn.addEventListener("click", () => {
    alert(
        "MediScribe — AI-powered clinical documentation\n\n" +
        "1. Start Mic and speak naturally.\n" +
        "2. Stop recording when finished.\n" +
        "3. Review the generated transcript.\n" +
        "4. Click Process Transcript with AI.\n" +
        "5. Review the clinical summary and copy your notes.\n\n" +
        "Always have a qualified healthcare professional verify AI-generated documentation."
    );
});