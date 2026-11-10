import io
import json
import os
import re
import socket
import tempfile
import traceback
import urllib.request
import urllib.error
import numpy as np
import soundfile as sf
import meilisearch
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv, find_dotenv
from groq import Groq
import uvicorn

# Load local environment variables (.env.local or .env)
env_file = find_dotenv(".env.local") or find_dotenv(".env")
if env_file:
    load_dotenv(env_file, override=True)
    print(f"📁 Environment file loaded from: {env_file}")

# Initialize Groq Client
groq_api_key = os.getenv("GROQ_API_KEY")
groq_client = None

if groq_api_key:
    groq_api_key = groq_api_key.strip("'\" \t\n;")
    try:
        groq_client = Groq(api_key=groq_api_key)
        print("⚡ Groq Cloud Fallback initialized successfully.")
    except Exception as e:
        print(f"⚠️ Warning: Could not initialize Groq client: {e}")
else:
    print("⚠️ GROQ_API_KEY not found in environment variables.")

def is_online() -> bool:
    """Checks fast network connection to determine if cloud fallbacks are available."""
    try:
        socket.create_connection(("1.1.1.1", 53), timeout=1.0)
        return True
    except OSError:
        return False

def get_active_groq_model() -> str:
    """Dynamically queries Groq to find supported text generation models for the current API key."""
    if not groq_client:
        return ""
    
    try:
        response = groq_client.models.list()
        available_ids = [m.id for m in response.data]
        print(f"📋 Models accessible under your Groq key: {available_ids}")
        
        preferred_candidates = [
            "llama-3.1-8b-instant",
            "llama-3.3-70b-versatile",
            "qwen/qwen3.8-27b",
            "openai/gpt-oss-20b",
            "allam-2-7b"
        ]
        
        for candidate in preferred_candidates:
            if candidate in available_ids:
                print(f"🎯 Selected active model: {candidate}")
                return candidate
                
        text_models = [
            m_id for m_id in available_ids 
            if not any(x in m_id.lower() for x in ["whisper", "orpheus", "guard"])
        ]
        if text_models:
            selected = text_models[0]
            print(f"🎯 Fallback model selected: {selected}")
            return selected
            
    except Exception as e:
        print(f"⚠️ Error fetching Groq models list: {e}")
        
    return "llama-3.1-8b-instant"

# Import Kokoro Neural TTS Pipeline
try:
    from kokoro import KPipeline
    tts_pipeline = KPipeline(lang_code='a')  # 'a' for American English
    print("✅ Kokoro-82M Neural TTS Engine loaded successfully.")
except Exception as e:
    print(f"⚠️ Warning: Could not initialize Kokoro TTS pipeline: {e}")
    tts_pipeline = None

# Import Faster-Whisper Engine for 100% Offline STT with Quantization Fallback
stt_model = None
try:
    from faster_whisper import WhisperModel
    try:
        stt_model = WhisperModel("base.en", device="cpu", compute_type="int8")
        print("✅ Faster-Whisper Local STT Engine loaded successfully (int8).")
    except Exception as e1:
        print(f"⚠️ int8 quantization failed ({e1}), falling back to float32...")
        stt_model = WhisperModel("base.en", device="cpu", compute_type="float32")
        print("✅ Faster-Whisper Local STT Engine loaded successfully (float32).")
except Exception as e:
    print(f"⚠️ Warning: Could not initialize Faster-Whisper local STT pipeline: {e}")
    stt_model = None

app = FastAPI(title="Tati Voice AI Local RAG Backend (Kokoro Neural TTS, Offline Whisper & Groq Fallback)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

meili_client = meilisearch.Client('http://127.0.0.1:7700')
index = meili_client.index('academic_records')

class ChatRequest(BaseModel):
    transcript: str = ""
    prompt: str = ""
    language: str = "en-US"
    stream: bool = False

class TTSRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    speed: float = 1.0

class SearchRequest(BaseModel):
    query: str
    limit: int = 20

STOP_WORDS = {
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
    "any", "are", "aren't", "as", "at", "be", "because", "been", "before", "being",
    "below", "between", "both", "but", "by", "can", "can't", "cannot", "could",
    "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't", "down",
    "during", "each", "few", "for", "from", "further", "had", "hadn't", "has",
    "hasn't", "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her",
    "here", "here's", "hers", "herself", "him", "himself", "his", "how", "how's",
    "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't", "it",
    "it's", "its", "itself", "let's", "me", "more", "most", "mustn't", "my",
    "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other",
    "ought", "our", "ours", "ourselves", "out", "over", "own", "same", "shan't",
    "she", "she'd", "she'll", "she's", "should", "shouldn't", "so", "some", "such",
    "than", "that", "that's", "the", "their", "theirs", "them", "themselves",
    "then", "there", "there's", "these", "they", "they'd", "they'll", "they're",
    "they've", "this", "those", "through", "to", "too", "under", "until", "up",
    "very", "was", "wasn't", "we", "we'd", "we'll", "we're", "we've", "were",
    "weren't", "what", "what's", "when", "when's", "where", "where's", "which",
    "while", "who", "who's", "whom", "why", "why's", "with", "won't", "would",
    "wouldn't", "you", "you'd", "you'll", "you're", "you've", "your", "yours",
    "yourself", "yourselves", "tell", "please", "find", "show", "search", "hi", "hello"
}

def extract_keywords(text: str) -> list[str]:
    words = re.findall(r'\b[a-zA-Z0-9]+\b', text.lower())
    keywords = [w for w in words if w not in STOP_WORDS and len(w) > 2]
    return keywords if keywords else words

def format_text_for_natural_speech(text: str) -> str:
    text = re.sub(r'[*_#`~]', '', text)
    text = text.replace(" e.g., ", ", for example, ").replace(" i.e., ", ", that is, ")
    text = re.sub(r';', ',', text)
    return re.sub(r'\s+', ' ', text).strip()

def broader_meili_search(query_text: str, max_hits: int = 5):
    hits = []
    seen_ids = set()

    try:
        res = index.search(query_text, {'limit': max_hits})
        for hit in res.get('hits', []):
            hit_id = hit.get('id') or hit.get('title')
            if hit_id not in seen_ids:
                seen_ids.add(hit_id)
                hits.append(hit)
    except Exception as e:
        print(f"Meilisearch stage 1 search warning: {e}")

    if len(hits) < max_hits:
        keywords = extract_keywords(query_text)
        if keywords:
            keyword_query = " ".join(keywords)
            try:
                res = index.search(keyword_query, {'limit': max_hits - len(hits)})
                for hit in res.get('hits', []):
                    hit_id = hit.get('id') or hit.get('title')
                    if hit_id not in seen_ids:
                        seen_ids.add(hit_id)
                        hits.append(hit)
            except Exception as e:
                print(f"Meilisearch stage 2 search warning: {e}")

    return hits

def query_ollama_local(prompt_text: str) -> str:
    """Queries local Ollama using dynamic timeouts and candidate model fallbacks."""
    online = is_online()
    ollama_timeout = 10 if online else 120
    url = "http://127.0.0.1:11434/api/generate"
    
    for model_name in ["llama3:latest", "llama3"]:
        payload = json.dumps({
            "model": model_name,
            "prompt": prompt_text,
            "stream": False,
            "keep_alive": os.getenv("OLLAMA_KEEP_ALIVE", "24h"),
            "options": {
                "num_ctx": 1024,
                "num_predict": 120,
                "temperature": 0.4
            }
        }).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json", "Connection": "close"},
            method="POST"
        )

        try:
            with urllib.request.urlopen(req, timeout=ollama_timeout) as response:
                if response.status == 200:
                    result = json.loads(response.read().decode("utf-8"))
                    answer = result.get("response", "").strip()
                    if answer:
                        return format_text_for_natural_speech(answer)
        except urllib.error.HTTPError as he:
            print(f"⚠️ Ollama HTTP Error {he.code} for model '{model_name}': {he.reason}")
        except urllib.error.URLError as ue:
            print(f"⚠️ Ollama Connection Error for model '{model_name}': {ue.reason}")
            break
        except Exception as e:
            print(f"⚠️ Ollama query attempt for '{model_name}' failed: {e}")

    return ""

def generate_ollama_stream(prompt_text: str):
    """Generator streaming tokens from local Ollama via SSE format."""
    url = "http://127.0.0.1:11434/api/generate"
    payload = json.dumps({
        "model": "llama3:latest",
        "prompt": prompt_text,
        "stream": True,
        "keep_alive": os.getenv("OLLAMA_KEEP_ALIVE", "2m"),
        "options": {
            "num_ctx": 1024,
            "num_predict": 120,
            "temperature": 0.4
        }
    }).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            for line in response:
                if line:
                    decoded = line.decode("utf-8").strip()
                    if decoded:
                        data = json.loads(decoded)
                        chunk = data.get("response", "")
                        if chunk:
                            yield chunk
    except Exception as e:
        print(f"⚠️ Ollama streaming exception: {e}")

def query_groq_fallback(system_instruction: str, user_prompt: str):
    if not groq_client:
        return "", "GROQ_API_KEY is not set or groq_client failed to initialize."
    
    model_name = get_active_groq_model()
    if not model_name:
        return "", "No accessible text models found for this Groq API key."
    
    try:
        completion = groq_client.chat.completions.create(
            messages=[
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": user_prompt}
            ],
            model=model_name,
            max_tokens=150,
            temperature=0.4
        )
        
        raw_content = completion.choices[0].message.content if completion.choices else None
        if raw_content:
            formatted = format_text_for_natural_speech(raw_content)
            if formatted:
                return formatted, ""
                
        return "", f"Model '{model_name}' returned empty or null content."
    except Exception as e:
        err_msg = str(e) or repr(e)
        return "", err_msg

@app.get("/")
def read_root():
    return {
        "status": "online", 
        "message": "Tati Voice AI Local Backend Active",
        "kokoro_tts": tts_pipeline is not None,
        "whisper_stt": stt_model is not None,
        "groq_fallback_ready": groq_client is not None,
        "groq_key_detected": bool(groq_api_key)
    }

@app.post("/search")
def search_records(req: SearchRequest):
    hits = broader_meili_search(req.query, max_hits=req.limit)
    return {"hits": hits, "query": req.query, "total": len(hits)}

@app.post("/api/stt")
async def transcribe_audio_offline(file: UploadFile = File(...)):
    """Transcribes audio files 100% offline using disk temporary storage + Faster-Whisper."""
    if stt_model is None:
        print("❌ STT Error: stt_model is not initialized on server.")
        raise HTTPException(
            status_code=500, 
            detail="Faster-Whisper STT engine is not installed or initialized on the server."
        )
    
    temp_path = None
    try:
        audio_bytes = await file.read()
        if not audio_bytes or len(audio_bytes) < 100:
            print("❌ STT Error: Received empty or corrupted audio buffer.")
            raise HTTPException(status_code=400, detail="Audio file is empty or too short.")

        ext = os.path.splitext(file.filename)[1] if file.filename else ".webm"
        if not ext:
            ext = ".webm"

        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as temp_file:
            temp_file.write(audio_bytes)
            temp_path = temp_file.name

        print(f"🎙️ Transcribing {len(audio_bytes)} bytes from temporary file: {temp_path}")
        segments, _ = stt_model.transcribe(temp_path, beam_size=5)
        transcript = " ".join([segment.text for segment in segments]).strip()
        print(f"📝 STT Result: '{transcript}'")
        
        return {"transcript": transcript, "provider": "faster_whisper_local"}

    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Local Whisper Transcription Error:\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Whisper transcription failed: {str(e)}")
    
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass

@app.post("/api/tts")
def generate_local_neural_speech(req: TTSRequest):
    if tts_pipeline is None:
        raise HTTPException(status_code=500, detail="Kokoro TTS pipeline is not initialized.")
    
    try:
        generator = tts_pipeline(
            req.text, 
            voice=req.voice, 
            speed=req.speed, 
            split_pattern=r'\n+'
        )
        
        audio_segments = []
        for gs, ps, audio in generator:
            if audio is not None and len(audio) > 0:
                audio_segments.append(audio)
        
        if not audio_segments:
            raise HTTPException(status_code=500, detail="No audio generated by Kokoro.")
            
        full_audio = np.concatenate(audio_segments)

        buffer = io.BytesIO()
        sf.write(buffer, full_audio, 24000, format='WAV')
        buffer.seek(0)

        return StreamingResponse(buffer, media_type="audio/wav")
    except Exception as e:
        print(f"❌ Kokoro Neural TTS Generation Error: {e}")
        raise HTTPException(status_code=500, detail=f"Kokoro synthesis failed: {str(e)}")

@app.post("/api/chat/stream")
def chat_stream_endpoint(req: ChatRequest):
    query_text = (req.prompt or req.transcript).strip()
    if not query_text:
        raise HTTPException(status_code=400, detail="Query transcript cannot be empty.")

    hits = broader_meili_search(query_text, max_hits=5)
    system_instructions = "You are Tati Voice AI, an Earth science research assistant. Answer concisely in 2 clear sentences."
    
    if hits:
        context_items = [f"Record {idx}:\nTitle: {h.get('title')}\nSummary: {h.get('abstract', '')}\n" for idx, h in enumerate(hits, 1)]
        full_prompt = f"{system_instructions}\n\nContext:\n{''.join(context_items)}\n\nUser Question: {query_text}\nAnswer:"
    else:
        full_prompt = f"{system_instructions}\n\nUser Question: {query_text}\nAnswer:"

    return StreamingResponse(generate_ollama_stream(full_prompt), media_type="text/event-stream")

@app.post("/api/chat")
def chat_endpoint(req: ChatRequest):
    query_text = (req.prompt or req.transcript).strip()
    if not query_text:
        raise HTTPException(status_code=400, detail="Query transcript cannot be empty.")

    if req.stream:
        return chat_stream_endpoint(req)

    hits = broader_meili_search(query_text, max_hits=5)

    system_instructions = (
        "You are Tati Voice AI, an Earth science research assistant speaking directly to a user. "
        "Answer the question concisely in exactly 2 warm, clear sentences."
    )
    
    if hits:
        context_items = []
        for idx, item in enumerate(hits, 1):
            title = item.get('title', 'Earth Science Study')
            summary = item.get('abstract', item.get('summary', item.get('content', 'No abstract available.')))
            context_items.append(f"Record {idx}:\nTitle: {title}\nSummary: {summary}\n")
        context_str = "\n".join(context_items)
        user_prompt_content = f"Context:\n{context_str}\n\nUser Question: {query_text}\n\nAnswer:"
    else:
        user_prompt_content = f"User Question: {query_text}\n\nAnswer:"

    full_prompt = f"{system_instructions}\n\n{user_prompt_content}"

    provider = "ollama_local"
    answer = query_ollama_local(full_prompt)

    groq_error = ""
    if not answer:
        if is_online():
            print("⚡ Local Ollama timed out/failed while online. Routing request to Groq Cloud...")
            answer, groq_error = query_groq_fallback(system_instructions, user_prompt_content)
            if answer:
                provider = "groq_cloud"
            else:
                provider = "groq_error"
                answer = f"Groq Error: {groq_error}"
        else:
            provider = "offline_local"
            answer = "Local language model processing timed out or failed. Please check Ollama and try again."

    return {
        "response_text": answer,
        "database_hits": len(hits),
        "hits": hits,
        "provider": provider,
        "diagnostics": {"groq_error": groq_error} if groq_error else {}
    }

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)