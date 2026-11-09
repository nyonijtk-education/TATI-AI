import io
import json
import os
import re
import urllib.request
import urllib.error
import numpy as np
import soundfile as sf
import meilisearch
from fastapi import FastAPI, HTTPException
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

def get_active_groq_model() -> str:
    """Dynamically queries Groq to find supported text generation models for the current API key."""
    if not groq_client:
        return ""
    
    try:
        response = groq_client.models.list()
        available_ids = [m.id for m in response.data]
        print(f"📋 Models accessible under your Groq key: {available_ids}")
        
        # Priority list matching accessible chat models on your account tier
        preferred_candidates = [
            "qwen/qwen3.8-27b",
            "openai/gpt-oss-20b",
            "openai/gpt-oss-120b",
            "allam-2-7b",
            "llama-3.1-8b-instant",
            "llama-3.3-70b-versatile"
        ]
        
        for candidate in preferred_candidates:
            if candidate in available_ids:
                print(f"🎯 Selected active model: {candidate}")
                return candidate
                
        # Filter out speech/audio and guard models if no candidate matches
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
        
    return "qwen/qwen3.8-27b"

# Import Kokoro Neural TTS Pipeline
try:
    from kokoro import KPipeline
    tts_pipeline = KPipeline(lang_code='a')  # 'a' for American English
    print("✅ Kokoro-82M Neural TTS Engine loaded successfully.")
except Exception as e:
    print(f"⚠️ Warning: Could not initialize Kokoro TTS pipeline: {e}")
    tts_pipeline = None

app = FastAPI(title="Tati Voice AI Local RAG Backend (Kokoro Neural TTS & Groq Fallback)")

# Enable CORS for frontend and tunnel routing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Connect to local Meilisearch instance
meili_client = meilisearch.Client('http://127.0.0.1:7700')
index = meili_client.index('academic_records')

class ChatRequest(BaseModel):
    transcript: str
    language: str = "en-US"

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
    "wouldn me", "you", "you'd", "you'll", "you're", "you've", "your", "yours",
    "yourself", "yourselves", "tell", "please", "find", "show", "search", "hi", "hello"
}

def extract_keywords(text: str) -> list[str]:
    """Filters conversational filler to isolate core research search tokens."""
    words = re.findall(r'\b[a-zA-Z0-9]+\b', text.lower())
    keywords = [w for w in words if w not in STOP_WORDS and len(w) > 2]
    return keywords if keywords else words

def format_text_for_natural_speech(text: str) -> str:
    """Strips markdown and formats text with natural speech pauses."""
    text = re.sub(r'[*_#`~]', '', text)
    text = text.replace(" e.g., ", ", for example, ").replace(" i.e., ", ", that is, ")
    text = re.sub(r';', ',', text)
    return re.sub(r'\s+', ' ', text).strip()

def broader_meili_search(query_text: str, max_hits: int = 5):
    """Multi-stage retrieval: full string query followed by key phrase extraction."""
    hits = []
    seen_ids = set()

    # Stage 1: Full raw query
    try:
        res = index.search(query_text, {'limit': max_hits})
        for hit in res.get('hits', []):
            hit_id = hit.get('id') or hit.get('title')
            if hit_id not in seen_ids:
                seen_ids.add(hit_id)
                hits.append(hit)
    except Exception as e:
        print(f"Meilisearch stage 1 search warning: {e}")

    # Stage 2: Filtered keywords
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
    """Queries local Ollama using llama3 with a 3-second timeout."""
    url = "http://127.0.0.1:11434/api/generate"
    
    for model_name in ["llama3:latest", "llama3"]:
        payload = json.dumps({
            "model": model_name,
            "prompt": prompt_text,
            "stream": False,
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
            with urllib.request.urlopen(req, timeout=3) as response:
                if response.status == 200:
                    result = json.loads(response.read().decode("utf-8"))
                    answer = result.get("response", "").strip()
                    if answer:
                        return format_text_for_natural_speech(answer)
        except Exception as e:
            print(f"⚠️ Ollama unreachable or timed out: {e}")
            break
            
    return ""

def query_groq_fallback(system_instruction: str, user_prompt: str):
    """Cloud fallback dynamically retrieving active models from Groq API."""
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
        "groq_fallback_ready": groq_client is not None,
        "groq_key_detected": bool(groq_api_key)
    }

@app.post("/search")
def search_records(req: SearchRequest):
    hits = broader_meili_search(req.query, max_hits=req.limit)
    return {"hits": hits, "query": req.query, "total": len(hits)}

@app.post("/api/tts")
def generate_local_neural_speech(req: TTSRequest):
    """Generates 100% offline human-like neural audio using Kokoro-82M."""
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

@app.post("/api/chat")
def chat_endpoint(req: ChatRequest):
    query_text = req.transcript.strip()
    if not query_text:
        raise HTTPException(status_code=400, detail="Query transcript cannot be empty.")

    # 1. Search Meilisearch Index
    hits = broader_meili_search(query_text, max_hits=5)

    # 2. Dynamic Prompt Construction
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

    # 3. Try Local Ollama Engine First
    provider = "ollama_local"
    answer = query_ollama_local(full_prompt)

    # 4. Fallback to Groq Cloud API if Ollama is Offline/Timed Out
    groq_error = ""
    if not answer:
        print("⚡ Ollama unavailable or offline. Routing request to Groq Cloud...")
        answer, groq_error = query_groq_fallback(system_instructions, user_prompt_content)
        if answer:
            provider = "groq_cloud"
        else:
            provider = "groq_error"
            answer = f"Groq Error: {groq_error}"

    return {
        "response_text": answer,
        "database_hits": len(hits),
        "hits": hits,
        "provider": provider,
        "diagnostics": {"groq_error": groq_error} if groq_error else {}
    }

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)